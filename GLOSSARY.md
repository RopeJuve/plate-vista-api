# Plate Vista

Restaurant ordering: guests order from their table by QR code, staff work the orders at the bar and in the kitchen, and the owner runs the restaurant from the dashboard.

## Language

### Restaurant and people

**Restaurant**:
One business using Plate Vista, identified to guests and staff by its slug. Everything else belongs to exactly one restaurant.
_Avoid_: Tenant (in product language), shop, venue

**Restaurant Profile**:
What guests see about a restaurant: its logo, its address, and its weekly opening hours. Separate from the legal details a receipt needs; a profile without an address of its own shows the legal address. Opening hours are shown to guests only and never stop them ordering.
_Avoid_: About page, branding, public details

**Opening Hours**:
The times in a restaurant's own timezone, per weekday, when it is open; a day has up to three ranges, and a range that closes before it opens runs past midnight.
_Avoid_: Business hours, service times

**Owner**:
The person who registered the restaurant and manages it from the dashboard; signs in with their email.
_Avoid_: Admin (an admin is a staff role below the owner)

**Staff**:
Anyone working in a restaurant other than its owner (admin, bar, kitchen), signing in with the restaurant's slug and their username.
_Avoid_: Employee (in product language), user

### Menu

**Menu Item**:
Something a guest can order, with a price, an optional description, and an optional image.
_Avoid_: Product, dish (a menu item may be a drink)

**Category**:
A named section of a restaurant's menu, with its own station and VAT rate, shown to guests in the restaurant's chosen order; every menu item is in exactly one. Its name is unique within the restaurant, ignoring case.
_Avoid_: Menu section, type

**Default Categories**:
The standard set of categories every restaurant starts with, which the owner may rename, reorder, or delete.

**Station**:
Where a menu item is prepared and its orders are worked: the bar or the kitchen. It belongs to the item's category, never to the item itself.
_Avoid_: Department, area

**Placeholder Image**:
What guests and staff see for a menu item that has no image of its own: a glass for bar items, a plate for kitchen items.

### Ordering

**Order**:
What a table sends in one go: one or more menu items with quantities, placed by a guest or by staff for them. It appears once on the bill, however many stations prepare it, and it is only as far along as its slowest ticket.
_Avoid_: Ticket (a ticket is one station's part of an order), round

**Ticket**:
The part of an order that one station works, with its own progress. An order has one ticket for each station it has items for, so drinks can be served while the food is still cooking.
_Avoid_: Order, sub-order

### Paying

**Bill**:
Everything a table orders during one visit, from its first order until staff close the table; its total leaves out cancelled tickets. Guests pay for the whole bill, not for each order, and once paid it takes no more orders or cancellations. While a payment is in progress (a guest paying online, or a card reader waiting for the card) the bill is frozen: it takes no orders or cancellations until that payment completes, fails, or is cancelled or abandoned. A bill has at most one payment in progress.
_Avoid_: Check, tab, order (an order is one round on the bill)

**Payment**:
Settling a bill, in cash, by card on a card reader or at a card terminal, or online. Staff record cash and card terminal payments; the payment provider records card reader and online payments; the guest's device never does.
_Avoid_: Checkout (in product language), transaction (a transaction is the till's record)

**Card Reader**:
A Stripe card reader registered to the restaurant, which staff send a bill's payment to from Plate Vista; the amount always comes from the bill, never typed on the reader. If the bill is settled some other way before the card goes through, the guest's card is released and never charged. The owner or an admin adds and removes card readers.
_Avoid_: Terminal (a card terminal is one Plate Vista does not talk to), POS device

**Simulated Reader**:
A card reader that exists only while Plate Vista runs against Stripe's test mode, for trying card reader payments without hardware.
_Avoid_: Test reader, fake reader

**Card Terminal**:
Any card machine at the restaurant that Plate Vista does not talk to; staff take the card on it and record the payment by hand.
_Avoid_: Card reader, EC-Gerät (in English copy)

**Late Payment**:
An online payment that completes after its bill was already paid, was no longer frozen, or its table was closed; it is refunded in full automatically and is never a Payment.
_Avoid_: Double payment, overpayment

**Payout Account**:
The restaurant's own account at Stripe, which guests' online and card reader payments are paid into. The owner sets it up from the dashboard on a Stripe-hosted page, and only the owner may manage it.
_Avoid_: Connect account, Stripe account (in product language)

**Receipt**:
The guest's record of a payment: what was bought, VAT per rate, total, payment method, and the TSE signature. Guests open it by link or QR code, without signing in.
_Avoid_: Invoice, Beleg (in English copy), bill

**Receipt Number**:
The number that identifies a receipt: the TSE's transaction number for its payment, so it exists only once the payment is signed.
_Avoid_: Bill number, invoice number

**Service Period**:
The time a receipt covers: from the bill's first order that was not wholly cancelled to its payment.
_Avoid_: Visit duration, Leistungszeitraum (in English copy)

**Hospitality Section**:
The part of a receipt a business guest fills in by hand to deduct a meal as entertainment: who was hosted, the occasion, place and date, and a signature.
_Avoid_: Bewirtungsbeleg (in English copy), expense form

**TSE**:
The certified signing device German law requires for a till, rented from fiskaly; every order and every payment is signed by the restaurant's TSE.
_Avoid_: Fiscal printer, Kasse

**VAT Rate**:
The tax rate a menu item is sold at, taken from its category: 19 % (normal) or 7 % (reduced, e.g. food eaten in).
_Avoid_: Tax class, MwSt (in English copy)

### Demo data

**Sample Menu**:
Realistic demo menu items with photos, added to a restaurant for development and demos only.
_Avoid_: Seed data (in product language), test menu
