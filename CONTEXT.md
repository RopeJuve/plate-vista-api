# Plate Vista

Restaurant ordering: guests order from their table by QR code, staff work the orders at the bar and in the kitchen, and the owner runs the restaurant from the dashboard.

## Language

### Restaurant and people

**Restaurant**:
One business using Plate Vista, identified to guests and staff by its slug. Everything else belongs to exactly one restaurant.
_Avoid_: Tenant (in product language), shop, venue

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
A named section of a restaurant's menu, with its own station, shown to guests in the restaurant's chosen order; every menu item is in exactly one. Its name is unique within the restaurant, ignoring case.
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

### Demo data

**Sample Menu**:
Realistic demo menu items with photos, added to a restaurant for development and demos only.
_Avoid_: Seed data (in product language), test menu
