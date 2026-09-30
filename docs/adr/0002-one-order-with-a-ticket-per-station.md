# One order, with a ticket per station

A guest who orders drinks and food in one go gets one order, and that order has one ticket for each station it has items for. Each ticket moves through pending, accepted, preparing, ready and served on its own, so the bar can serve the drinks while the kitchen is still cooking. We chose this because an order used to have a single status: marking the drinks served marked the food served too.

The order keeps an overall status, calculated from its tickets: the slowest ticket that is not cancelled. It is served when every remaining ticket is served, and cancelled only when every ticket is cancelled.

## Considered Options

- **Split on the frontend only.** The staff board hides the other station's lines. The status stays shared, so the bug remains.
- **Two orders, one per station.** Keeps a single status per order, but one tap by the guest becomes two orders: the retry protection (one `clientOrderId`, one order in the reply) no longer fits, the guest's edit and cancel of a pending order would have to act on two orders, and the bill shows two entries.

## Consequences

- Staff can cancel one ticket and keep the other. Its lines come off the order's total and their stock is returned.
- A guest can edit or cancel an order only while every ticket is pending. Once any station has accepted its ticket, a change means a new order.
- Any staff member can move any ticket. The bar and kitchen screens decide what is shown, not what is allowed.
- A status change sent without a station moves every ticket of the order, as it did before tickets existed, so clients that have not been updated keep working.
