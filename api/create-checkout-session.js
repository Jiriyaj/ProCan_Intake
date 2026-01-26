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

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { submission } = req.body || {};

    if (!submission || !submission.pricing) {
      return res.status(400).send('Missing submission/pricing');
    }

    const origin = (req.headers && req.headers.origin) || `https://${req.headers.host}`;

    const orderId = safeStr(submission?.meta?.id, 'unknown');
    const biz = safeStr(submission?.business?.name, 'ProCan Client');
    const email = safeStr(submission?.business?.email, '') || undefined;

    const billing = safeStr(submission?.billing?.option || submission?.pricing?.billing || 'monthly'); // monthly|quarterly|annual
    const termMonths = Math.max(1, Math.round(num(submission?.billing?.monthsInTerm, billing === 'quarterly' ? 3 : (billing === 'annual' ? 12 : 1))));

    const oneTimeOnly = !!submission?.billing?.oneTimeOnly;

    // Values are in dollars in the submission payload
    const monthlyTotal = num(submission?.pricing?.monthlyTotal, 0);
    const dueToday = num(submission?.pricing?.dueToday, 0);
    const deepCleanTotal = num(submission?.services?.deepClean?.total, 0);

    // For subscriptions, the recurring charge is the total for the selected billing interval.
    // Example: quarterly => monthlyTotal * 3 (discounts already baked into monthlyTotal).
    const recurringIntervalTotal = Math.max(0, monthlyTotal * termMonths);
    const recurringAmountCents = Math.round(recurringIntervalTotal * 100);

    // For one-time only, charge dueToday as a one-time payment.
    const oneTimeAmountCents = Math.round(Math.max(0, dueToday) * 100);

    const cadence = safeStr(submission?.services?.trash?.cadence, '');
    const cans = safeStr(submission?.services?.trash?.cans, '');
    const serviceLabel = `ProCan Service — ${biz}`;

    // Stripe minimums vary by currency/method; keep a conservative floor for card.
    const minCents = 50;

    let session;
    if (oneTimeOnly) {
      if (oneTimeAmountCents < minCents) return res.status(400).send('Amount too small');

      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: email,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'ProCan One-Time Service',
              description: `${biz}${cadence ? ` • ${cadence}` : ''}${cans ? ` • ${cans} cans` : ''}`
            },
            unit_amount: oneTimeAmountCents,
          },
        }],
        metadata: {
          orderId,
          bizName: biz,
          billing_type: 'one_time',
          billing,
          cadence,
          cans
        },
        success_url: `${origin}/procan-intake.html?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/procan-intake.html?payment=cancelled`,
      });
    } else {
      if (recurringAmountCents < minCents) return res.status(400).send('Recurring amount too small');

      const lineItems = [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'ProCan Sanitation Service (Recurring)',
            description: `${biz}${cadence ? ` • ${cadence}` : ''}${cans ? ` • ${cans} cans` : ''}`
          },
          unit_amount: recurringAmountCents,
          recurring: {
            interval: 'month',
            interval_count: termMonths
          }
        }
      }];
      // One-time deep clean: include as an additional one-time line item on the FIRST invoice (if selected).
      if (deepCleanTotal > 0) {
        const deepCents = Math.round(deepCleanTotal * 100);
        if (deepCents >= minCents) {
          lineItems.push({
            quantity: 1,
            price_data: {
              currency: 'usd',
              product_data: { name: 'Initial Deep Clean (One-Time)' },
              unit_amount: deepCents,
            },
          });
        }
      }

      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email: email,
        line_items: lineItems,
        subscription_data: {
          metadata: {
            orderId,
            bizName: biz,
            billing_type: 'subscription',
            billing,
            cadence,
            cans
          },
          },
        metadata: {
          orderId,
          bizName: biz,
          billing_type: 'subscription',
          billing,
          cadence,
          cans
        },
        success_url: `${origin}/procan-intake.html?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/procan-intake.html?payment=cancelled`,
      });
    }

    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    return res.status(500).send(err?.message || 'Server error');
  }
};
