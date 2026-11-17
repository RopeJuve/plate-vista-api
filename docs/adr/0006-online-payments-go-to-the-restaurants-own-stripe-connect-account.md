# Online payments go to the restaurant's own Stripe Connect account

A guest's online payment is a direct charge on the restaurant's own Stripe account (an Accounts v2 connected account with the merchant configuration), which the owner sets up from the dashboard through Stripe's hosted onboarding; Plate Vista never holds the money. We wanted owners not to deal with Stripe at all, but collecting every payment on the platform's account and paying restaurants out ourselves would make us a payment service under the ZAG (BaFin licence), breaks Stripe's terms, and puts the money with a different business than the one whose TSE signs the payment (ADR-0003). Stripe-hosted onboarding keeps the owner's effort to one guided identity and bank-account check, which Stripe requires of anyone receiving money.

Stripe, not Plate Vista, carries the account's negative balances (refunds and disputes the restaurant cannot cover), and the restaurant pays Stripe's fees itself. Stripe only accepts that with direct charges and the full Stripe Dashboard, so the owner gets their own Stripe Dashboard rather than the lighter Express one; Stripe refuses legacy Express accounts with the platform carrying losses, and we do not want to underwrite restaurants' disputes.

## Considered Options

- **Platform collects and pays out.** No onboarding for owners, but needs a payment licence and splits the seller from the money.
- **Owner pastes their own Stripe API keys.** No Connect, but harder for owners and we would store their secrets.
- **Express accounts with Plate Vista carrying losses.** A lighter dashboard for owners, but we would cover restaurants' unrecovered disputes, and Stripe now refuses to create these as legacy `type: "express"` accounts.

## Consequences

- A restaurant can take online payments only after Stripe makes its card payments capability active (`chargesEnabled`); until then guests pay at the table.
- Account changes arrive as Accounts v2 thin events on their own event destination (`POST /api/v1/webhooks/stripe/accounts`, signed with `STRIPE_ACCOUNT_WEBHOOK_SECRET`), not as v1 `account.updated`.
- Stripe's fees are charged to the restaurant; Plate Vista's cut, if any, is the platform fee on each charge.
- Stripe is not available in Serbia, Bosnia or North Macedonia, so restaurants there cannot pay online this way.
