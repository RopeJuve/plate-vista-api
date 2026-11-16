# Online payments go to the restaurant's own Stripe Connect account

A guest's online payment is a direct charge on the restaurant's own Stripe Express account, which the owner sets up from the dashboard through Stripe's hosted onboarding; Plate Vista never holds the money. We wanted owners not to deal with Stripe at all, but collecting every payment on the platform's account and paying restaurants out ourselves would make us a payment service under the ZAG (BaFin licence), breaks Stripe's terms, and puts the money with a different business than the one whose TSE signs the payment (ADR-0003). Express onboarding keeps the owner's effort to one guided identity and bank-account check, which Stripe requires of anyone receiving money.

## Considered Options

- **Platform collects and pays out.** No onboarding for owners, but needs a payment licence and splits the seller from the money.
- **Owner pastes their own Stripe API keys.** No Connect, but harder for owners and we would store their secrets.

## Consequences

- A restaurant can take online payments only after its onboarding is complete (`chargesEnabled`); until then guests pay at the table.
- Stripe's fees are charged to the restaurant; Plate Vista's cut, if any, is the platform fee on each charge.
- Stripe is not available in Serbia, Bosnia or North Macedonia, so restaurants there cannot pay online this way.
