// api/stripe-webhook.js (Vercel Serverless Function)
// ENV required in Vercel project:
//   STRIPE_SECRET_KEY=sk_test_... (or sk_live_...)
//   STRIPE_WEBHOOK_SECRET=whsec_...
//   RESEND_API_KEY=re_...
//   OWNER_EMAIL=your@email.com
//   FROM_EMAIL="ProCan Sanitation <onboarding@resend.dev>"  // ok without your own domain
//
// NEW (for Supabase persistence):
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=eyJ...   (server-side only; NEVER expose to browser)
//
// Install dependency via package.json: "stripe"
const Stripe = require('stripe');

async function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function moneyFromCents(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function safe(v, max = 500) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * NEW: write paid orders into Supabase via REST
 * - Uses service role key (server-only) to bypass RLS safely.
 * - Upserts on stripe_session_id so retries don’t duplicate rows.
 */
async function upsertSupabaseOrder({ session, m, ownerEmail, customerEmail }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.log('ℹ️ Supabase env not set; skipping Supabase upsert');
    return null;
  }

  const endpoint = `${supabaseUrl}/rest/v1/orders?on_conflict=stripe_session_id`;

  const row = {
    stripe_session_id: session.id,
    order_id: safe(m.orderId, 80) || null,
    paid_at: session.created ? new Date(session.created * 1000).toISOString() : new Date().toISOString(),
    status: 'paid',

    mode: safe(session.mode, 40) || null,
    amount_total: Number(session.amount_total || 0),

    customer_email: safe(customerEmail, 200) || null,
    owner_email: safe(ownerEmail, 200) || null,

    biz_name: safe(m.bizName, 200) || null,
    contact_name: safe(m.contactName, 200) || null,
    phone: safe(m.phone, 60) || null,

    address: safe(m.address, 300) || null,
    locations: safe(m.locations, 120) || null,
    preferred_service_day: safe(m.preferredServiceDay, 40) || null,
    start_date: safe(m.startDate, 40) || null,

    cadence: safe(m.cadence, 40) || null,
    cans: m.cans ? Number(m.cans) : null,

    pad_enabled: String(m.padEnabled || '').toLowerCase() === 'true',
    pad_size: safe(m.padSize, 40) || null,
    pad_cadence: safe(m.padCadence, 40) || null,

    deep_clean_enabled: String(m.deepCleanEnabled || '').toLowerCase() === 'true',
    deep_clean_level: safe(m.deepCleanLevel, 40) || null,
    deep_clean_qty: m.deepCleanQty ? Number(m.deepCleanQty) : null,

    billing: safe(m.billing, 40) || null,
    billing_type: safe(m.billing_type, 40) || null,

    notes: safe(m.notes, 1000) || null,
    terms_url: safe(m.termsUrl, 500) || null,

    raw_metadata: m || {},
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([row]),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase upsert error (${res.status}): ${t || 'Failed to upsert order'}`);
  }

  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data[0] : data;
}

async function sendResendEmail({ to, subject, html, text, replyTo, idempotencyKey }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL;

  if (!key) throw new Error('Missing RESEND_API_KEY');
  if (!from) throw new Error('Missing FROM_EMAIL');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Resend error (${res.status}): ${t || 'Failed to send email'}`);
  }

  return res.json().catch(() => ({}));
}

function renderCustomerEmail({ m, session }) {
  const termsUrl = m.termsUrl || '';
  const dash = (v) => (v ? v : '—');

  const line1 = `${dash(m.bizName)} — Order confirmed`;
  const plan =
    m.billing_type === 'one_time'
      ? `One-time service`
      : `Recurring (${dash(m.billing)} billing)`;

  const serviceLines = [
    `Trash cadence: ${dash(m.cadence)} • Cans: ${dash(m.cans)}`,
    `Dumpster pad: ${m.padEnabled === 'true' ? `Yes (${dash(m.padSize)} • ${dash(m.padCadence)})` : 'No'}`,
    `Deep clean: ${m.deepCleanEnabled === 'true' ? `Yes (${dash(m.deepCleanLevel)} • qty ${dash(m.deepCleanQty)})` : 'No'}`,
  ];

  const amountLine =
    m.billing_type === 'one_time'
      ? `Paid today: ${dash(moneyFromCents(session.amount_total))}`
      : `Paid today: ${dash(moneyFromCents(session.amount_total))} (first billing)`;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.4;">
      <h2 style="margin:0 0 8px 0;">${line1}</h2>
      <p style="margin:0 0 14px 0;color:#444;">
        Thanks — we received your payment and will follow up to confirm routing details.
      </p>

      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;">
        <div style="font-weight:600;margin-bottom:6px;">Summary</div>
        <div>${plan}</div>
        <div>${amountLine}</div>
        <div>Service address: ${dash(m.address)}</div>
        <div>Preferred service day: ${dash(m.preferredServiceDay)}</div>
        <div>Start date: ${dash(m.startDate)}</div>
        <div style="margin-top:8px;">${serviceLines.map(x => `<div>${x}</div>`).join('')}</div>
      </div>

      ${termsUrl ? `
        <p style="margin:14px 0 0 0;">
          Terms & Conditions: <a href="${termsUrl}">${termsUrl}</a>
        </p>` : ''}

      <p style="margin:14px 0 0 0;color:#444;">
        If anything needs to change (gate code, access window, bin location), just reply to this email.
      </p>

      <p style="margin:14px 0 0 0;color:#6b7280;font-size:12px;">
        Order ID: ${dash(m.orderId)}
      </p>
    </div>
  `.trim();

  const text = [
    line1,
    '',
    'Thanks — we received your payment and will follow up to confirm routing details.',
    '',
    amountLine,
    `Service address: ${dash(m.address)}`,
    `Preferred service day: ${dash(m.preferredServiceDay)}`,
    `Start date: ${dash(m.startDate)}`,
    ...serviceLines,
    '',
    termsUrl ? `Terms & Conditions: ${termsUrl}` : '',
    '',
    'Reply to this email if anything needs to change (gate code, access window, bin location).',
    '',
    `Order ID: ${dash(m.orderId)}`
  ].filter(Boolean).join('\n');

  return { html, text };
}

function renderOwnerEmail({ m, session }){
  const dash = (v) => (v ? v : '—');

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.4;">
      <h2 style="margin:0 0 8px 0;">✅ New paid order</h2>
      <p style="margin:0 0 14px 0;color:#444;">Order ID: <b>${dash(m.orderId)}</b></p>

      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;">
        <div><b>Business:</b> ${dash(m.bizName)}</div>
        <div><b>Contact:</b> ${dash(m.contactName)}</div>
        <div><b>Email:</b> ${dash(m.customerEmail || session.customer_email)}</div>
        <div><b>Phone:</b> ${dash(m.phone)}</div>
        <div><b>Address:</b> ${dash(m.address)}</div>
        <div><b>Locations:</b> ${dash(m.locations)}</div>
        <div><b>Preferred day:</b> ${dash(m.preferredServiceDay)}</div>
        <div><b>Start date:</b> ${dash(m.startDate)}</div>
        <div style="margin-top:10px;"><b>Plan:</b> ${m.billing_type === 'one_time' ? 'One-time' : `Recurring (${dash(m.billing)})`}</div>
        <div><b>Paid today:</b> ${moneyFromCents(session.amount_total)}</div>
        <div style="margin-top:10px;"><b>Services</b></div>
        <div>Trash: ${dash(m.cadence)} • ${dash(m.cans)} cans</div>
        <div>Pad: ${m.padEnabled === 'true' ? `Yes (${dash(m.padSize)} • ${dash(m.padCadence)})` : 'No'}</div>
        <div>Deep clean: ${m.deepCleanEnabled === 'true' ? `Yes (${dash(m.deepCleanLevel)} • qty ${dash(m.deepCleanQty)} • total ${dash(m.deepCleanTotal)})` : 'No'}</div>
        <div style="margin-top:10px;"><b>Notes:</b> ${dash(m.notes)}</div>
      </div>
    </div>
  `.trim();

  const text = [
    'New paid order',
    `Order ID: ${dash(m.orderId)}`,
    '',
    `Business: ${dash(m.bizName)}`,
    `Contact: ${dash(m.contactName)}`,
    `Email: ${dash(m.customerEmail || session.customer_email)}`,
    `Phone: ${dash(m.phone)}`,
    `Address: ${dash(m.address)}`,
    `Locations: ${dash(m.locations)}`,
    `Preferred day: ${dash(m.preferredServiceDay)}`,
    `Start date: ${dash(m.startDate)}`,
    '',
    `Plan: ${m.billing_type === 'one_time' ? 'One-time' : `Recurring (${dash(m.billing)})`}`,
    `Paid today: ${moneyFromCents(session.amount_total)}`,
    '',
    `Trash: ${dash(m.cadence)} • ${dash(m.cans)} cans`,
    `Pad: ${m.padEnabled === 'true' ? `Yes (${dash(m.padSize)} • ${dash(m.padCadence)})` : 'No'}`,
    `Deep clean: ${m.deepCleanEnabled === 'true' ? `Yes (${dash(m.deepCleanLevel)} • qty ${dash(m.deepCleanQty)} • total ${dash(m.deepCleanTotal)})` : 'No'}`,
    '',
    `Notes: ${dash(m.notes)}`
  ].join('\n');

  return { html, text };
}

module.exports = async (req, res) => {
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // For safety: only email when payment is actually paid.
        if (session.payment_status && session.payment_status !== 'paid'){
          console.log('ℹ️ Checkout completed but not paid yet (skipping email)', {
            id: session.id,
            payment_status: session.payment_status,
            mode: session.mode
          });
          break;
        }

        const m = session.metadata || {};
        const ownerEmail = process.env.OWNER_EMAIL;

        const customerEmail = safe(session.customer_details?.email || session.customer_email || m.customerEmail, 200);
        if (!customerEmail){
          console.warn('⚠️ Missing customer email; cannot send customer receipt', { id: session.id });
        }

        console.log('✅ Checkout paid; processing', {
          id: session.id,
          orderId: m.orderId,
          customerEmail,
          ownerEmail,
          mode: session.mode,
          amount_total: session.amount_total,
          termsUrl: m.termsUrl
        });

        // NEW: persist into Supabase (safe upsert, handles webhook retries)
        try {
          const saved = await upsertSupabaseOrder({ session, m, ownerEmail, customerEmail });
          if (saved?.id) console.log('✅ Supabase upsert ok', { order_row_id: saved.id });
        } catch (e) {
          console.error('❌ Supabase upsert failed (continuing to email anyway):', e?.message || e);
        }

        // Customer email FIRST
        if (customerEmail){
          const c = renderCustomerEmail({ m, session });
          await sendResendEmail({
            to: customerEmail,
            subject: `ProCan — Order confirmed${m.orderId ? ` (#${m.orderId})` : ''}`,
            html: c.html,
            text: c.text,
            replyTo: ownerEmail || undefined,
            idempotencyKey: `procan_${session.id}_customer`
          });
        }

        // Owner email SECOND
        if (ownerEmail){
          const o = renderOwnerEmail({ m, session });
          await sendResendEmail({
            to: ownerEmail,
            subject: `ProCan — New paid order${m.orderId ? ` (#${m.orderId})` : ''}`,
            html: o.html,
            text: o.text,
            replyTo: customerEmail || undefined,
            idempotencyKey: `procan_${session.id}_owner`
          });
        } else {
          console.warn('⚠️ Missing OWNER_EMAIL; skipping internal notification');
        }

        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        console.log('✅ Invoice paid', {
          id: invoice.id,
          subscription: invoice.subscription,
          customer: invoice.customer,
          amount_paid: invoice.amount_paid,
          currency: invoice.currency,
          billing_reason: invoice.billing_reason,
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log('⚠️ Invoice payment failed', {
          id: invoice.id,
          subscription: invoice.subscription,
          customer: invoice.customer,
          attempt_count: invoice.attempt_count,
          next_payment_attempt: invoice.next_payment_attempt,
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.log('🛑 Subscription canceled', {
          id: sub.id,
          status: sub.status,
          canceled_at: sub.canceled_at,
        });
        break;
      }

      default:
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).send(err?.message || 'Server error');
  }
};
