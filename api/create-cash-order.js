// api/create-cash-order.js (Vercel Serverless Function)
// Records a Cash/Check order in Supabase (no Stripe).
// ENV required in Vercel project:
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=... (server-only; NEVER expose to browser)
// Optional (for emails):
//   RESEND_API_KEY=re_...
//   OWNER_EMAIL=your@email.com
//   FROM_EMAIL="ProCan Sanitation <onboarding@resend.dev>"

function safe(v, max = 500) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function upsertSupabaseCashOrder({ submission, origin }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }

  const endpoint = `${supabaseUrl}/rest/v1/orders?on_conflict=order_id`;

  const b = submission?.business || {};
  const s = submission?.services || {};
  const p = submission?.pricing || {};
  const bill = submission?.billing || {};

  const orderId = safe(submission?.meta?.id, 80) || null;
  const termsUrl = `${origin}/terms.html?return=${encodeURIComponent('/procan-intake.html')}`;

  const dueToday = num(p.dueToday, 0);
  const cents = Math.round(dueToday * 100);

  const row = {
    // Key fields
    order_id: orderId,
    stripe_session_id: null,

    // Cash order lifecycle
    paid_at: null,
    status: 'cash',
    mode: 'cash',
    amount_total: cents,

    // Contact
    customer_email: safe(b.email, 200) || null,
    owner_email: safe(process.env.OWNER_EMAIL, 200) || null,
    biz_name: safe(b.name, 200) || null,
    contact_name: safe(b.contactName, 200) || null,
    phone: safe(b.phone, 60) || null,

    // Service details
    address: safe(b.address, 300) || null,
    locations: safe(b.locations, 120) || null,
    preferred_service_day: safe(b.preferredServiceDay, 40) || null,
    start_date: safe(bill.startDate, 40) || null,
    cadence: safe(s?.trash?.cadence, 40) || null,
    cans: s?.trash?.cans ? Number(s.trash.cans) : null,

    pad_enabled: !!s?.pad?.enabled,
    pad_size: safe(s?.pad?.size, 40) || null,
    pad_cadence: safe(s?.pad?.cadence, 40) || null,

    deep_clean_enabled: !!s?.deepClean?.enabled,
    deep_clean_level: safe(s?.deepClean?.level, 40) || null,
    deep_clean_qty: s?.deepClean?.qty ? Number(s.deepClean.qty) : null,

    billing: safe(bill.option, 40) || null,
    billing_type: safe(bill.oneTimeOnly ? 'one_time' : 'subscription', 40) || null,

    notes: safe(submission?.notes, 1000) || null,
    terms_url: safe(termsUrl, 500) || null,
    raw_metadata: submission || {},
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
    throw new Error(`Supabase upsert error (${res.status}): ${t || 'Failed to upsert cash order'}`);
  }

  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data[0] : data;
}

async function sendResendEmail({ to, subject, html, text, replyTo, idempotencyKey }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL;
  if (!key || !from) return null; // optional

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

function renderCashEmailCustomer({ submission, origin }) {
  const b = submission?.business || {};
  const s = submission?.services || {};
  const p = submission?.pricing || {};
  const bill = submission?.billing || {};
  const orderId = safe(submission?.meta?.id, 80) || '—';
  const termsUrl = `${origin}/terms.html?return=${encodeURIComponent('/procan-intake.html')}`;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.4;">
      <h2 style="margin:0 0 8px 0;">${safe(b.name, 200) || 'ProCan Client'} — Order recorded</h2>
      <p style="margin:0 0 14px 0;color:#444;">
        We recorded your order as <b>Cash/Check</b>. We’ll follow up to confirm routing details.
      </p>
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;">
        <div style="font-weight:600;margin-bottom:6px;">Summary</div>
        <div>Due today: <b>$${(num(p.dueToday,0)).toFixed(2)}</b> (Cash/Check)</div>
        <div>Service address: ${safe(b.address, 300) || '—'}</div>
        <div>Preferred service day: ${safe(b.preferredServiceDay, 40) || '—'}</div>
        <div>Start date: ${safe(bill.startDate, 40) || '—'}</div>
        <div style="margin-top:8px;">Trash cadence: ${safe(s?.trash?.cadence, 40) || '—'} • Cans: ${safe(s?.trash?.cans, 40) || '—'}</div>
      </div>
      <p style="margin:14px 0 0 0;">Terms &amp; Conditions: <a href="${termsUrl}">${termsUrl}</a></p>
      <p style="margin:14px 0 0 0;color:#6b7280;font-size:12px;">Order ID: ${orderId}</p>
    </div>
  `.trim();

  const text = [
    `${safe(b.name, 200) || 'ProCan Client'} — Order recorded`,
    '',
    'We recorded your order as Cash/Check. We’ll follow up to confirm routing details.',
    '',
    `Due today: $${num(p.dueToday,0).toFixed(2)} (Cash/Check)`,
    `Service address: ${safe(b.address, 300) || '—'}`,
    `Preferred service day: ${safe(b.preferredServiceDay, 40) || '—'}`,
    `Start date: ${safe(bill.startDate, 40) || '—'}`,
    `Trash cadence: ${safe(s?.trash?.cadence, 40) || '—'} • Cans: ${safe(s?.trash?.cans, 40) || '—'}`,
    '',
    `Terms & Conditions: ${termsUrl}`,
    '',
    `Order ID: ${orderId}`,
  ].join('\n');

  return { html, text, termsUrl, orderId };
}

function renderCashEmailOwner({ submission }) {
  const b = submission?.business || {};
  const p = submission?.pricing || {};
  const s = submission?.services || {};
  const bill = submission?.billing || {};
  const orderId = safe(submission?.meta?.id, 80) || '—';

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.4;">
      <h2 style="margin:0 0 8px 0;">💵 New cash/check order</h2>
      <p style="margin:0 0 14px 0;color:#444;">Order ID: <b>${orderId}</b></p>
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;">
        <div><b>Business:</b> ${safe(b.name,200) || '—'}</div>
        <div><b>Contact:</b> ${safe(b.contactName,200) || '—'}</div>
        <div><b>Email:</b> ${safe(b.email,200) || '—'}</div>
        <div><b>Phone:</b> ${safe(b.phone,60) || '—'}</div>
        <div><b>Address:</b> ${safe(b.address,300) || '—'}</div>
        <div><b>Start date:</b> ${safe(bill.startDate,40) || '—'}</div>
        <div style="margin-top:10px;"><b>Due today (cash):</b> $${num(p.dueToday,0).toFixed(2)}</div>
        <div style="margin-top:10px;"><b>Services</b></div>
        <div>Trash: ${safe(s?.trash?.cadence,40) || '—'} • ${safe(s?.trash?.cans,40) || '—'} cans</div>
      </div>
    </div>
  `.trim();

  const text = [
    'New cash/check order',
    `Order ID: ${orderId}`,
    '',
    `Business: ${safe(b.name,200) || '—'}`,
    `Contact: ${safe(b.contactName,200) || '—'}`,
    `Email: ${safe(b.email,200) || '—'}`,
    `Phone: ${safe(b.phone,60) || '—'}`,
    `Address: ${safe(b.address,300) || '—'}`,
    `Start date: ${safe(bill.startDate,40) || '—'}`,
    `Due today (cash): $${num(p.dueToday,0).toFixed(2)}`,
    `Trash: ${safe(s?.trash?.cadence,40) || '—'} • ${safe(s?.trash?.cans,40) || '—'} cans`,
  ].join('\n');

  return { html, text, orderId };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { submission } = req.body || {};
    if (!submission || !submission.business || !submission.pricing) {
      return res.status(400).json({ error: 'Missing submission payload.' });
    }

    const origin = (req.headers && req.headers.origin) || `https://${req.headers.host}`;

    // Write into Supabase
    const row = await upsertSupabaseCashOrder({ submission, origin });

    // Optional: send customer email first, then owner email
    const customerEmail = safe(submission?.business?.email, 200);
    const ownerEmail = safe(process.env.OWNER_EMAIL, 200);

    if (process.env.RESEND_API_KEY && process.env.FROM_EMAIL) {
      if (customerEmail) {
        const c = renderCashEmailCustomer({ submission, origin });
        await sendResendEmail({
          to: customerEmail,
          subject: 'ProCan — Order recorded (Cash/Check)',
          html: c.html,
          text: c.text,
          replyTo: ownerEmail || undefined,
          idempotencyKey: `cash-customer-${c.orderId}`,
        });
      }

      if (ownerEmail) {
        const o = renderCashEmailOwner({ submission });
        await sendResendEmail({
          to: ownerEmail,
          subject: 'ProCan — New cash/check order',
          html: o.html,
          text: o.text,
          idempotencyKey: `cash-owner-${o.orderId}`,
        });
      }
    }

    return res.status(200).json({ ok: true, order: row });
  } catch (err) {
    console.error('create-cash-order error:', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
};
