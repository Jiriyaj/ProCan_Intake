// api/stripe-webhook.js (Vercel Serverless Function)
// ENV required in Vercel project:
//   STRIPE_SECRET_KEY=sk_test_... (or sk_live_...)
//   STRIPE_WEBHOOK_SECRET=whsec_...
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
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('✅ Payment completed', {
        id: session.id,
        orderId: session.metadata?.orderId,
        amount_total: session.amount_total,
        currency: session.currency,
        customer_email: session.customer_email,
      });

      // TODO: mark paid + send emails
    }

    return res.status(200).send('ok');
  } catch (err) {
    return res.status(500).send(err?.message || 'Webhook handler failed');
  }
};

// Disable body parsing so we can read raw body for signature verification
module.exports.config = { api: { bodyParser: false } };
