# The TSE signs each order and each payment, not one transaction per bill

German law (KassenSichV) requires the till's records to be signed by a TSE through fiskaly. We sign every **Order** as its own short `Bestellung` transaction when it is placed, and every **Payment** as its own `Kassenbeleg` transaction; only the payment's signature goes on the receipt. We chose this because orders entered at the table are recordable in their own right in gastronomy, and because a bill stays open for hours, which a single long-running transaction handles badly.

## Considered Options

- **One transaction per bill, started at the first order and finished at payment.** Simpler, but the transaction stays open for the whole visit, the individual orders are never recorded, and a cancelled ticket has no clean representation.

## Consequences

- Signing happens after the reply, never in the request path: ordering and paying are never slowed or blocked by fiskaly. A failed signature is retried; the order or payment stands.
- Cancelling a ticket of a signed order needs its own signed correction (a negative `Bestellung`).
- To be confirmed with a Steuerberater before going live.
