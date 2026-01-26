// api/create-checkout-session.js (Vercel Serverless Function)
// ENV required in Vercel project:
//   STRIPE_SECRET_KEY=sk_test_... (or sk_live_...)
//
// Install dependency via package.json: "stripe"
const Stripe = require('stripe');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { submission } = req.body || {};

    if (!submission || !submission.pricing || typeof submission.pricing.dueToday !== 'number') {
      return res.status(400).send('Missing submission/pricing.dueToday');
    }

    const dueToday = Number(submission.pricing.dueToday || 0);
    const amountCents = Math.max(0, Math.round(dueToday * 100));
    if (amountCents < 50) return res.status(400).send('Amount too small');

    const origin = (req.headers && req.headers.origin) || `https://${req.headers.host}`;

    const orderId = submission?.meta?.id || 'unknown';
    const biz = submission?.business?.name || 'ProCan Client';
    const email = submission?.business?.email || undefined;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          product_data: { name: 'ProCan Sanitation Service', description: biz },
          unit_amount: amountCents,
        },
      }],
      metadata: { orderId, bizName: biz },
      success_url: `${origin}/procan-intake.html?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/procan-intake.html?payment=cancelled`,
    });

    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    return res.status(500).send(err?.message || 'Server error');
  }
};
