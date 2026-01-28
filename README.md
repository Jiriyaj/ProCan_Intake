Build v2

# ProCan Intake (preserved) + Stripe Checkout (Vercel)

This package keeps your existing intake logic intact and ONLY adds Stripe Checkout at the final step.

## Deploy
1) Upload this folder to a GitHub repo.
2) Import into Vercel.

## Vercel Environment Variables
Set these in Vercel -> Project -> Settings -> Environment Variables:
- STRIPE_SECRET_KEY = your Stripe secret key (sk_test_... or sk_live_...)
- STRIPE_WEBHOOK_SECRET = your webhook signing secret (whsec_...)

## Stripe Webhook
In Stripe Dashboard -> Developers -> Webhooks:
- Add endpoint: https://YOUR-VERCEL-DOMAIN/api/stripe-webhook
- Events: checkout.session.completed

## Asset
The header expects: /assets/procan-intake-logo.png
Copied from: /mnt/data/procan-intake-logo.png
# ProCan_Intake
