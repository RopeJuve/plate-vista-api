# Third-party APIs: Stripe and fiskaly

Stripe and fiskaly change their APIs faster than an agent's training data, so a call written from memory can be one the live API refuses. Our test doubles (`test/support/fakeStripe.js`, `test/support/fakeFiskaly.js`) were written from the same memory as the code, so green tests prove nothing about the API itself.

## Before adding or changing a call

1. Find the API version we actually run (below), not the one you remember.
2. Read that version's API reference for every parameter you send and every field you read, plus the changelog since it, at `docs.stripe.com/changelog` or fiskaly's SIGN DE v2 docs.
3. Change the test double to behave as the live API does, including refusing what it refuses, before you change the code.
4. Stripe: run `npm run test:stripe` and see it pass.

## Stripe

- The only file that calls Stripe is `src/modules/payouts/stripe.js`. Add new calls there.
- **API version:** the `stripe` package fixes it, and we don't override it. It's in `node_modules/stripe/cjs/apiVersion.js` (`2026-10-28.endive` as of stripe 23.1). Upgrading the package changes the API version, so read the changelog for every version in between.
- **Known break:** this API version refuses `payment_method_types` on PaymentIntents, SetupIntents and Checkout Sessions. Terminal PaymentIntents use `allowed_payment_method_types: ["card_present"]`.
- **Contract test:** `test/stripe/stripe-contract.test.js` runs our real calls against Stripe test mode, with a Simulated Reader for Terminal. It runs through `npm run test:stripe`, which reads `.env`, and skips without a test-mode `STRIPE_SECRET_KEY` and `STRIPE_TEST_ACCOUNT_ID`. CI runs it with the `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_ACCOUNT_ID` repo secrets. Give every new call in `stripe.js` a case there.

## fiskaly

- The only file that calls fiskaly is `src/modules/tse/fiskaly.client.js`, using KassenSichV SIGN DE **v2** (`FISKALY_BASE_URL`, default `https://kassensichv-middleware.fiskaly.com/api/v2`).
- There is no contract test against fiskaly's test environment yet, so a change here needs the docs check above done by hand.
