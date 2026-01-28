// api/create-cash-order.js (Vercel Serverless Function)
// Creates a CASH/CHECK order in Supabase (no Stripe).
//
// REQUIRED ENV (Vercel Project Settings -> Environment Variables):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (server-only; do NOT expose to browser)

function safe(v, max = 500) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function intOrNull(v) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

async function insertCashOrder({ submission, origin }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }

  const b = submission?.business || {};
  const s = submission?.services || {};
  const p = submission?.pricing || {};
  const bill = submission?.billing || {};

  // Your rule: cash/check only allowed for one-time service
  if (!bill.oneTimeOnly) {
    throw new Error('Cash/Check is only allowed for one-time service.');
  }

  const termsUrl = `${origin}/terms.html?return=${encodeURIComponent('/procan-intake.html')}`;

  // Align to your existing orders table schema (see your supabase-schema.sql)
  const row = {
    stripe_session_id: null,
    order_id: safe(submission?.meta?.id, 80) || null,

    biz_name: safe(b.name, 200) || null,
    contact_name: safe(b.contactName, 200) || null,
    customer_email: safe(b.email, 200) || null,
    phone: safe(b.phone, 60) || null,
    address: safe(b.address, 300) || null,

    locations_count: intOrNull(b.locations),
    preferred_service_day: safe(b.preferredServiceDay, 40) || null,
    start_date: safe(bill.startDate, 40) || null,
    notes: safe(submission?.notes, 1000) || null,

    billing_type: 'one_time',
    billing: safe(bill.option, 40) || null,
    term_months: null,
    cadence: safe(s?.trash?.cadence, 40) || null,
    cans: safe(s?.trash?.cans, 40) || null,

    pad_enabled: !!s?.pad?.enabled,
    pad_size: safe(s?.pad?.size, 40) || null,
    pad_cadence: safe(s?.pad?.cadence, 40) || null,

    deep_clean_enabled: !!s?.deepClean?.enabled,
    deep_clean_level: safe(s?.deepClean?.level, 40) || null,
    deep_clean_qty: s?.deepClean?.qty != null ? String(s.deepClean.qty) : null,
    deep_clean_total: num(p.deepCleanTotal, 0) || null,

    discount_code: safe(p.discountCode, 60) || null,
    monthly_total: num(p.monthlyTotal, 0) || null,
    due_today: num(p.dueToday, 0) || null,

    terms_url: safe(termsUrl, 500) || null,
    status: 'new'
  };

  const endpoint = `${supabaseUrl}/rest/v1/orders?select=*`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify([row])
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase insert error (${res.status}): ${t || 'Failed to insert cash order'}`);
  }

  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data[0] : data;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { submission } = req.body || {};
    if (!submission || !submission.business || !submission.pricing || !submission.billing) {
      return res.status(400).json({ error: 'Missing submission payload.' });
    }

    const origin = (req.headers && req.headers.origin) || `https://${req.headers.host}`;
    const order = await insertCashOrder({ submission, origin });

    return res.status(200).json({ ok: true, order });
  } catch (err) {
    console.error('create-cash-order error:', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
};
