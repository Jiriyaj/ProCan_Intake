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


function getZipFromAddress(address){
  const s = String(address||'');
  const m = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : '';
}
function inferZone(address){
  const zip = getZipFromAddress(address);
  if (zip) return zip;
  const a = String(address||'').trim();
  if (a) return a.slice(0, 10).toUpperCase();
  return 'default';
}
function normalizeFrequencyFromCadence(cadence){
  const c = String(cadence||'').toLowerCase();
  if (c.includes('bi')) return 'biweekly';
  return 'monthly';
}
function parseCansField(cans){
  const n = parseInt(String(cans ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}
}

/**
 * NEW: write paid orders into Supabase via REST
 * - Uses service role key (server-only) to bypass RLS safely.
 * - Upserts on stripe_session_id so retries don’t duplicate rows.
 */
async function upsertSupabaseOrder({ session, m }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.log('ℹ️ Supabase env not set; skipping Supabase upsert');
    return null;
  }

  const endpoint = `${supabaseUrl}/rest/v1/orders?on_conflict=stripe_session_id`;

  // Prevent "zombie" orders: if an order was cancelled/archived in Supabase, do NOT resurrect it.
  async function fetchExistingLifecycle(){
    try{
      const url = `${supabaseUrl}/rest/v1/orders?select=id,is_deleted,status&stripe_session_id=eq.${encodeURIComponent(session.id)}&limit=1`;
      const r = await fetch(url, {
        method:'GET',
        headers:{
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type':'application/json'
        }
      });
      if (!r.ok) return null;
      const d = await r.json().catch(()=>[]);
      const row = Array.isArray(d) ? d[0] : d;
      return row || null;
    }catch(e){
      return null;
    }
  }

  const existing = await fetchExistingLifecycle();
  if (existing){
    const st = String(existing.status || '').toLowerCase();
    if (existing.is_deleted === true || st.startsWith('cancelled')){
      console.log('ℹ️ Not upserting: order is cancelled/archived in Supabase (prevents resurrection).', existing.id);
      return existing;
    }
  }

  const i = (v) => {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  const isDeposit = String(m.isDeposit || '').toLowerCase() === 'true' || safe(m.billing_type, 40) === 'deposit';

  const depositAmount = isDeposit ? (n(m.dueToday) ?? (Number(session.amount_total || 0) / 100)) : null;
  const normalDueToday = isDeposit ? n(m.normalDueToday) : null;

  // Base row aligned to your existing orders table schema
  const baseRow = {
    stripe_session_id: session.id,
    order_id: safe(m.orderId, 80) || null,

    biz_name: safe(m.bizName, 200) || null,
    contact_name: safe(m.contactName, 200) || null,
    customer_email: safe(m.customerEmail || session.customer_details?.email || session.customer_email, 200) || null,
    phone: safe(m.phone, 60) || null,
    address: safe(m.address, 300) || null,

    lat: (m.geoLat != null && String(m.geoLat).trim() !== '') ? Number(m.geoLat) : null,
    lng: (m.geoLng != null && String(m.geoLng).trim() !== '') ? Number(m.geoLng) : null,

    locations_count: i(m.locationsCount || m.locations),
    preferred_service_day: safe(m.preferredServiceDay, 40) || null,
    start_date: safe(m.startDate, 40) || null,
    notes: safe(m.notes, 1000) || null,

    billing_type: safe(m.billing_type, 40) || null,
    billing: safe(m.billing, 40) || null,
    term_months: i(m.term_months || m.termMonths),

    cadence: safe(m.cadence, 40) || null,
    service_frequency: safe(m.cadence, 40) || null,
    billing_interval: safe(m.billing, 40) || null,
    cans: safe(m.cans, 40) || null,

    pad_enabled: String(m.padEnabled || '').toLowerCase() === 'true',
    pad_size: safe(m.padSize, 40) || null,
    pad_cadence: safe(m.padCadence, 40) || null,

    deep_clean_enabled: String(m.deepCleanEnabled || '').toLowerCase() === 'true',
    deep_clean_level: safe(m.deepCleanLevel, 40) || null,
    deep_clean_qty: m.deepCleanQty != null ? String(m.deepCleanQty) : null,
    deep_clean_total: n(m.deepCleanTotal),

    discount_code: safe(m.discountCode, 60) || null,
    monthly_total: n(m.monthlyTotal),
    due_today: n(m.dueToday),

    terms_url: safe(m.termsUrl, 500) || null,

    // Keep status consistent with your dashboard workflow
    status: 'new',
  };

  // Extended fields (safe to include if you've added columns)
  const extendedRow = {
    ...baseRow,
    stripe_customer_id: session.customer || null,
    stripe_payment_intent_id: session.payment_intent || null,
    is_deposit: isDeposit,
    deposit_amount: depositAmount,
    normal_due_today: normalDueToday,
    stripe_subscription_id: session.subscription || m.createdSubscriptionId || null,
  };

  async function doUpsert(payloadRow){
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify([payloadRow]),
    });
  }

  // Try extended first; if schema doesn't include new columns yet, retry with base.
  let res = await doUpsert(extendedRow);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const missingCol = /column\s+"(stripe_customer_id|is_deposit|deposit_amount|normal_due_today|stripe_payment_intent_id|stripe_subscription_id)"\s+of\s+relation\s+"orders"\s+does\s+not\s+exist/i.test(t);
    if (missingCol) {
      console.log('ℹ️ Orders table missing extended columns; retrying base upsert');
      res = await doUpsert(baseRow);
      if (!res.ok) {
        const t2 = await res.text().catch(() => '');
        throw new Error(`Supabase upsert error (${res.status}): ${t2 || 'Failed to upsert order'}`);
      }
    } else {
      throw new Error(`Supabase upsert error (${res.status}): ${t || 'Failed to upsert order'}`);
    }
  }

  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data[0] : data;
}


/**
 * NEW: upsert customer (for routing/availability) into public.customers.
 * Uses stripe_customer_id as the stable key.
 */
async function upsertSupabaseCustomer({ session, m }){
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return null;

  const stripeCustomerId = session.customer || null;
  if (!stripeCustomerId) return null;

  const endpoint = `${supabaseUrl}/rest/v1/customers?on_conflict=stripe_customer_id`;

  const isDeposit = String(m.isDeposit || '').toLowerCase() === 'true' || safe(m.billing_type, 40) === 'deposit';
  const isSetup = safe(m.billing_type, 40) === 'setup' || session.mode === 'setup';
  const status = isDeposit ? 'deposited' : (isSetup ? 'lead' : 'active');

  const row = {
    biz_name: safe(m.bizName, 200) || null,
    contact_name: safe(m.contactName, 200) || null,
    customer_email: safe(m.customerEmail || session.customer_details?.email || session.customer_email, 200) || null,
    phone: safe(m.phone, 60) || null,
    address: safe(m.address, 300) || null,

    lat: (m.geoLat != null && String(m.geoLat).trim() !== '') ? Number(m.geoLat) : null,
    lng: (m.geoLng != null && String(m.geoLng).trim() !== '') ? Number(m.geoLng) : null,
    zone: inferZone(m.address),
    frequency: normalizeFrequencyFromCadence(m.cadence),
    cans: parseCansField(m.cans),
    preferred_window: safe(m.preferredServiceDay, 40) || null,
    start_after: safe(m.startDate, 40) ? safe(m.startDate, 40) : null,

    status,
    deposit_amount: isDeposit ? Number(m.dueToday || 25) : 0,
    deposit_paid_at: isDeposit ? new Date().toISOString() : null,

    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: session.subscription || m.createdSubscriptionId || null,
    pm_saved: (isDeposit || isSetup) ? true : false,
    created_at: new Date().toISOString()
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

  if (!res.ok){
    const t = await res.text().catch(()=> '');
    throw new Error(`Supabase customer upsert error (${res.status}): ${t || 'Failed to upsert customer'}`);
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

// IMPORTANT:
// - Stripe retries webhooks when we return non-2xx.
// - Email delivery failures must NOT fail the webhook (or you'll get duplicates).
async function safeSendResendEmail(args) {
  try {
    return await sendResendEmail(args);
  } catch (e) {
    console.error('❌ Email send failed (continuing):', e?.message || e);
    return null;
  }
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
    (session.mode === 'setup' || m.billing_type === 'setup')
      ? `Payment method saved: No charge today`
      : (m.billing_type === 'one_time'
          ? `Paid today: ${dash(moneyFromCents(session.amount_total))}`
          : `Paid today: ${dash(moneyFromCents(session.amount_total))} (first billing)`);

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

        // Allow paid checkouts AND setup-mode checkouts (no charge, card saved).
        const isSetup = session.mode === 'setup';
        if (!isSetup && session.payment_status && session.payment_status !== 'paid'){
          console.log('ℹ️ Checkout completed but not paid yet (skipping email)', {
            id: session.id,
            payment_status: session.payment_status,
            mode: session.mode
          });
          break;
        }

        const m = session.metadata || {};

        // ✅ Deposit credit: convert the deposit payment into a customer credit so the first invoice is reduced.
        // IMPORTANT: This must run regardless of whether Supabase persistence is enabled.
        // Stripe does NOT automatically treat a standalone deposit payment as a future credit.
        // We use an idempotency key so webhook retries do not duplicate the credit.
        try {
          const isDeposit = String(m.isDeposit || '').toLowerCase() === 'true' || String(m.billing_type || '').toLowerCase() === 'deposit';
          if (isDeposit && session.customer) {
            const depositCents =
              (typeof session.amount_total === 'number' && session.amount_total > 0)
                ? session.amount_total
                : Math.round((Number(m.dueToday || 0) || 0) * 100);

            if (depositCents > 0) {
              await stripe.customers.createBalanceTransaction(
                session.customer,
                {
                  amount: -depositCents, // negative = credit
                  currency: (session.currency || 'usd'),
                  description: 'Deposit credited toward first invoice',
                  metadata: { checkout_session_id: session.id }
                },
                { idempotencyKey: `deposit-credit-${session.id}` }
              );
              console.log('✅ Deposit credit created', { session_id: session.id, customer: session.customer, depositCents });
            }
          }
        } catch (e) {
          // Never fail the webhook because of deposit credit; log and continue.
          console.error('❌ Deposit credit failed:', e?.message || e);
        }

        // If this was a DEPOSIT checkout (mode=payment), create a subscription now but delay billing until the route start date.
        // We create the subscription in trial and later the dashboard will update trial_end to the scheduled first service date.
        try{
          const isDeposit = String(m.isDeposit || '').toLowerCase() === 'true' || String(m.billing_type||'').toLowerCase() === 'deposit';
          const hasCustomer = !!session.customer;
          const alreadyHasSub = !!session.subscription;
          if (isDeposit && hasCustomer && !alreadyHasSub){
            const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
            // Determine the payment method from the PaymentIntent
            let pmId = null;
            if (session.payment_intent){
              const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
              pmId = pi.payment_method || null;
            }
            if (pmId){
              await stripe.customers.update(session.customer, {
                invoice_settings: { default_payment_method: pmId }
              });
            }

            const termMonths = parseInt(String(m.termMonths || m.term_months || 1), 10) || 1;
            const monthlyTotal = Number(m.monthlyTotal || 0) || 0;
            const amountCents = Math.round(Math.max(0, monthlyTotal * termMonths) * 100);

            // Safety: if monthlyTotal isn't present, do not create a subscription.
            if (amountCents > 0){
              const now = Math.floor(Date.now()/1000);
              const trialEnd = now + (365*24*60*60); // placeholder; will be updated when route is scheduled

              const productName = `ProCan Service — ${String(m.bizName || '').trim() || 'ProCan Client'}`;

              // Subscriptions API does not accept `product_data` inside `price_data`.
              // Create a Product + Price, then subscribe using the Price ID.
              const product = await stripe.products.create({
                name: productName,
              });

              const price = await stripe.prices.create({
                currency: 'usd',
                unit_amount: amountCents,
                recurring: { interval: 'month', interval_count: termMonths },
                product: product.id,
              });

              const sub = await stripe.subscriptions.create({
                customer: session.customer,
                collection_method: 'charge_automatically',
                default_payment_method: pmId || undefined,
                trial_end: trialEnd,
                proration_behavior: 'none',
                items: [{ price: price.id }],
                metadata: m
              });

              // Stash for Supabase upsert
              m.createdSubscriptionId = sub.id;
              m.createdPaymentMethodId = pmId || '';
            }
          }
        }catch(e){
          console.error('❌ Deposit subscription create failed:', e?.message||e);
        }

        const ownerEmail = safe(process.env.OWNER_EMAIL, 200);
        const testEmailTo = safe(process.env.TEST_EMAIL_TO, 200);

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
          try { await upsertSupabaseCustomer({ session, m }); } catch(e){ console.error('❌ Supabase customer upsert failed:', e?.message||e); }
          if (saved?.id) console.log('✅ Supabase upsert ok', { order_row_id: saved.id });
        } catch (e) {
          console.error('❌ Supabase upsert failed (continuing to email anyway):', e?.message || e);
        }

        // In Resend "testing" mode, you can only send to your own email.
        // If TEST_EMAIL_TO is set, force ALL emails to that address for seamless testing.
        const customerTo = testEmailTo || customerEmail;
        const ownerTo = testEmailTo || ownerEmail;

        // Customer email FIRST
        if (customerTo){
          const c = renderCustomerEmail({ m, session });
          await safeSendResendEmail({
            to: customerTo,
            subject: `ProCan — Order confirmed${m.orderId ? ` (#${m.orderId})` : ''}`,
            html: c.html,
            text: c.text,
            replyTo: ownerEmail || undefined,
            idempotencyKey: `procan_${session.id}_customer`
          });
        }

        // Owner email SECOND
        if (ownerTo){
          const o = renderOwnerEmail({ m, session });
          await safeSendResendEmail({
            to: ownerTo,
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