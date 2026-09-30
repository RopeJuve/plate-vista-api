# The station belongs to the category, not the menu item

Orders are routed to the bar or the kitchen by station, and a menu item always takes its station from its category ("Beer" is bar, so every beer goes to the bar); the item itself has no station setting. We chose this because a per-item setting was forgotten in practice (every item defaulted to kitchen, so drinks never reached the bar), and moving an item to another category is the natural way to change where it is made.

## Considered Options

- **Category default, item may override.** Handles the rare exception (an Irish Coffee in "Hot Drinks" made in the kitchen), but brings back the per-item setting that went wrong. Can be added later without migrating data if a real case appears.
- **Item copies the category's station when created.** Silently drifts: changing a category's station would not reach its existing items.

## Consequences

- Changing a category's station affects new orders only. Each order line keeps the station it was sent to, so open tickets never move between screens mid-shift.
