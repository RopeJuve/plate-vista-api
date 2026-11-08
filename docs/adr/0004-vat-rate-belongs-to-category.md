# The VAT rate belongs to the category, not the menu item

Each category has a VAT rate (19 % or 7 %), and every menu item in it takes that rate; order lines copy it when the order is placed, like station and category name. We chose this for the same reason as ADR-0001: a per-item setting gets forgotten, and a forgotten VAT rate is a tax error, not just a routing bug.

## Considered Options

- **VAT rate per menu item.** Handles exceptions, but every new item is one more place to get it wrong. Can be added later as an override without migrating data if a real exception appears.

## Consequences

- Existing categories are migrated from their station (bar 19 %, kitchen 7 %), and the owner confirms them.
- Changing a category's rate affects new orders only.
