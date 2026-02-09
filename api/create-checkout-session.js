// api/create-checkout-session.js (Vercel Serverless Function)
// ENV required in Vercel project:
//   STRIPE_SECRET_KEY=sk_test_... (or sk_live_...)
// Install dependency via package.json: "stripe"
//
// This endpoint supports:
//  - Recurring plans via Stripe Subscriptions (mode: 'subscription')
//  - Optional one-time clean only (mode: 'payment') when submission.billing.oneTimeOnly is true
//
// For subscriptions, we create a dynamic recurring Price via price_data with:
//  - interval: 'month'
//  - interval_count: 1 (monthly), 3 (quarterly), 12 (annual)
// Amount is the total for the selected billing interval (e.g., quarterly = 3 * monthly total, less any discount already applied).
const Stripe = require('stripe');

function safeStr(v, fallback=''){
  return String(v ?? fallback).trim();
}
function num(v, fallback=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function metaStr(v, maxLen=450){
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length > maxLen ? (s.slice(0, maxLen - 1) + '…') : s;
}
function buildSessionMetadata(submission, origin, computed){
  const b = submission?.business || {};
  const s = submission?.services || {};
  const p = submission?.pricing || {};
  const bill = submission?.billing || {};
  const termsUrl = `${origin}/terms.html?return=${encodeURIComponent('/procan-intake.html')}`;
  return {
    orderId: metaStr(submission?.meta?.id, 120) || 'unknown',
    bizName: metaStr(b.name, 200),
    contactName: metaStr(b.contactName, 200),
    customerEmail: metaStr(b.email, 200),
    phone: metaStr(b.phone, 80),
    address: metaStr(b.address, 300),
    geoLat: metaStr(b.geoLat, 40),
    geoLng: metaStr(b.geoLng, 40),
    geoSource: metaStr(b.geoSource, 40),
    locations: metaStr(b.locations, 40),
    preferredServiceDay: metaStr(b.preferredServiceDay, 40),
    startDate: metaStr(bill.startDate, 40),
    notes: metaStr(submission?.notes, 240),

    billing_type: computed.billing_type,
    billing: metaStr(computed.billing, 40),
    termMonths: metaStr(computed.termMonths, 10),
    cadence: metaStr(computed.cadence, 40),
    cans: metaStr(computed.cans, 40),

    padEnabled: metaStr(!!s?.pad?.enabled, 10),
    padSize: metaStr(s?.pad?.size, 40),
    padCadence: metaStr(s?.pad?.cadence, 40),

    deepCleanEnabled: metaStr(!!s?.deepClean?.enabled, 10),
    deepCleanLevel: metaStr(s?.deepClean?.level, 40),
    deepCleanQty: metaStr(s?.deepClean?.qty, 40),
    deepCleanTotal: metaStr(num(s?.deepClean?.total, 0), 40),

    discountCode: metaStr(p.discountCode, 80),
    monthlyTotal: metaStr(num(p.monthlyTotal, 0), 40),
    dueToday: metaStr(num(p.dueToday, 0), 40),
    normalDueToday: metaStr(num(p.normalDueToday, 0), 40),
    isDeposit: metaStr(!!(computed?.billing_type === 'deposit'), 10),

    termsUrl
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { submission } = req.body || {};

    if (!submission || !submission.pricing) {
      return res.status(400).json({ error: 'Missing submission payload.' });
    }

    const biz = safeStr(submission?.business?.name, 'ProCan Client');
    const email = safeStr(submission?.business?.email, '');
    const orderId = safeStr(submission?.meta?.id, '');
    const cadence = safeStr(submission?.services?.trash?.cadence, 'biweekly');
    const cans = num(submission?.services?.trash?.cans, 0);

    const billing = safeStr(submission?.billing?.option, 'monthly'); // monthly | quarterly | annual
    const termMonths = num(submission?.billing?.monthsInTerm, 1);

    const monthlyTotal = num(submission?.pricing?.monthlyTotal, 0);
    const dueToday = num(submission?.pricing?.dueToday, 0);

    const oneTimeOnly = !!submission?.billing?.oneTimeOnly;
    const captureOnly = !!submission?.billing?.captureOnly;
    const isDeposit = !!(submission?.billing?.depositReservation || submission?.billing?.deposit || submission?.pricing?.isDeposit);

    if (!oneTimeOnly && !isDeposit && monthlyTotal <= 0) {
      return res.status(400).json({ error: 'Invalid monthly total.' });
    }
    if (!captureOnly && dueToday <= 0) {
      return res.status(400).json({ error: 'Invalid due today total.' });
    }
    if (captureOnly && dueToday < 0) {
      return res.status(400).json({ error: 'Invalid due today total.' });
    }

    // Derive origin for redirects and terms link
    const origin = (req.headers && req.headers.origin) || `https://${req.headers.host}`;

    const serviceLabel = `ProCan Service — ${biz}`;

    const computed = {
      billing_type: oneTimeOnly ? 'one_time' : (isDeposit ? 'deposit' : (captureOnly ? 'setup' : 'subscription')),
      billing,
      termMonths,
      cadence,
      cans
    };
    const sessionMetadata = buildSessionMetadata(submission, origin, computed);

    // Stripe expects integer cents
    const dueTodayCents = Math.round(dueToday * 100);

    const lineItems = [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: serviceLabel,
            description: oneTimeOnly
              ? `One-time service. Trash cadence: ${cadence}, cans: ${cans}`
              : (isDeposit
                  ? `Deposit reservation. Launch/start date: ${safeStr(submission?.billing?.startDate,'') || 'TBD'}. Trash cadence: ${cadence}, cans: ${cans}`
                  : `Recurring service. Billing: ${billing} (${termMonths} mo). Trash cadence: ${cadence}, cans: ${cans}`),
          },
          unit_amount: dueTodayCents,
          ...(oneTimeOnly || isDeposit
            ? {}
            : {
                recurring: {
                  interval: 'month',
                  interval_count: termMonths,
                },
              }),
        },
        quantity: 1,
      },
    ];

    // Success/cancel redirect (your intake form can read these params if you want)
    const successUrl = `${origin}/procan-intake.html?paid=1&oid=${encodeURIComponent(orderId)}`;
    const cancelUrl = `${origin}/procan-intake.html?canceled=1`;

    let session;

    // For "deposit" payments (mode=payment) we want to:
    //  1) always create a Stripe Customer
    //  2) save the payment method for future off-session use
    // This lets you later create a subscription at launch WITHOUT customer re-entry.
    let customerId = null;
    if (isDeposit || captureOnly) {
      const customer = await stripe.customers.create({
        email: email || undefined,
        name: biz || undefined,
        metadata: {
          orderId: sessionMetadata.orderId || 'unknown',
          source: isDeposit ? 'procan_intake_deposit' : 'procan_intake_setup',
        },
      });
      customerId = customer.id;
    }

    
    if (captureOnly){
      // Save card only (no charge). Use Setup mode.
      session = await stripe.checkout.sessions.create({
        mode: 'setup',
        payment_method_types: ['card'],
        ...(customerId
          ? { customer: customerId }
          : { customer_email: email || undefined }),
        setup_intent_data: {
          metadata: sessionMetadata,
        },
        metadata: sessionMetadata,
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
    } else if (oneTimeOnly || isDeposit) {
      // One-time payment checkout
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        // IMPORTANT (Stripe constraint): you may specify ONLY ONE of {customer, customer_creation}.
        // We pre-create a customer for deposits (so we can attach a balance credit in the webhook),
        // therefore we only set customer_creation when we do NOT already have a customerId.
        ...(customerId ? {} : { customer_creation: 'always' }),
        payment_method_types: ['card'],
        ...(customerId
          ? { customer: customerId }
          : { customer_email: email || undefined }),
        // Save payment method for later subscription creation (Model A)
        payment_intent_data: {
          setup_future_usage: isDeposit ? 'off_session' : undefined,
          metadata: sessionMetadata,
        },
        line_items: lineItems.map(li => ({
          ...li,
          price_data: {
            ...li.price_data,
            // remove recurring if any
            recurring: undefined,
          },
        })),
        metadata: sessionMetadata,
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
    } else {
      // Subscription checkout
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: email || undefined,
        line_items: lineItems,
        subscription_data: {
          metadata: sessionMetadata,
        },
        metadata: sessionMetadata,
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
    }

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return res.status(500).json({ error: err?.message || 'Server error' });
  }
};
