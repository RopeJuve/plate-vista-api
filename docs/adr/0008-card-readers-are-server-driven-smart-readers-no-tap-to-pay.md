# Card readers are server-driven Stripe smart readers; no Tap to Pay

In-person card payments go through Stripe smart readers (S700, S710, WisePOS E) registered to the restaurant's Payout Account (ADR-0006). The API drives them server-side: it creates the PaymentIntent from the frozen bill and tells the reader to collect it, and the staff app in the browser only watches. PaymentIntents use manual capture, and the webhook captures one only while its bill is still frozen for it, so a card reader payment is never a Late Payment; otherwise the authorization is cancelled. We skip Tap to Pay because Stripe offers it only in its native iOS/Android SDKs, and Plate Vista is a web app.

## Considered Options

- **Stripe Terminal JS SDK in the browser.** Supports the same smart readers and nothing more, but puts the payment flow in the client and needs connection tokens, while the API must stay the source of truth for amount and status.
- **Bluetooth/USB readers (WisePad 3, M2).** Only the mobile SDKs can connect to them, not a browser.
- **Tap to Pay through a native wrapper (React Native/Capacitor).** A separate app to build, sign and distribute; revisit if staff ask for phone-only payments.

## Consequences

- A restaurant's Bluetooth reader, or a reader from another card company, can only be used as a Card Terminal (recorded by hand).
- A smart reader already registered to another Stripe account must be removed there and registered again to the Payout Account.
- Each restaurant gets one Stripe Terminal Location, created from its legal address; it is a Stripe detail, not a domain concept.
- Simulated readers are driven through Stripe's test helpers, so the whole flow is testable without hardware.
