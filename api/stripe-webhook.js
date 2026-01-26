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
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('✅ Checkout completed', {
          id: session.id,
          mode: session.mode,
          orderId: session.metadata?.orderId,
          customer_email: session.customer_email,
          subscription: session.subscription,
          amount_total: session.amount_total,
          currency: session.currency,
        });
        // TODO: persist order + session/subscription IDs, send confirmation email, etc.
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
        // TODO: mark billing period as paid, release route schedule, etc.
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
        // TODO: notify customer + internal alert, pause service if needed per policy.
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.log('🛑 Subscription canceled', {
          id: sub.id,
          customer: sub.customer,
          status: sub.status,
          canceled_at: sub.canceled_at,
          metadata: sub.metadata,
        });
        // TODO: mark canceled in your system.
        break;
      }

      default:
        // Keep it quiet for noise, but log type for debugging.
        console.log('ℹ️ Unhandled event', event.type);
        break;
    }

    return res.status(200).send('ok');
  } catch (err) {
    return res.status(500).send(err?.message || 'Webhook handler failed');
  }
};

// Disable body parsing so we can read raw body for signature verification
module.exports.config = { api: { bodyParser: false } };
