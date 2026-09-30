# WebSocket protocol v2.2

Orders change only through this socket. REST reads the current board; it does not create or edit orders.

This release is **2.2**. Clients connect with `/ws?v=2`. A missing `v` defaults to `2`. An unknown version is closed with code `4000` and reason `unsupported protocol version`.

## Changelog

### 2.2

- An order has one **ticket** for each station it has items for, and each ticket has its own status. `Order.tickets` is new; `Order.status` is now worked out from the tickets.
- `order.status` and `order.cancel` take an optional `station`. Without it they act on the whole order, so 2.1 clients keep working.
- `order.statusChanged` also carries `tickets`, `totalCents`, and `station` when one ticket was named.
- Staff can cancel one ticket. Its lines stay on the order but come off `totalCents`.
- An order can be edited, and cancelled by a guest, only while every ticket is `pending`.

### 2.1

- Documented `Order`, `Session`, and `GET /staff/board` shapes. Every order payload is produced by `serializeOrder()`.
- Duplicate `clientOrderId` is a successful replay and emits no new event.
- Errors may include `details`. Zod failures use `details.fields`. Rate limits use `RATE_LIMITED`.
- Permission matrix for guest and staff. `rev` on every order and on `order.statusChanged`.
- `session.opened` when the first order opens a session. `session.paid` is reserved and not implemented.
- Staff may create an order with only `tableId`.
- Close codes, 30s heartbeat, short-lived WebSocket tickets, full `menu.updated` items, and documented limits.

### 2.0

- Request ids, acks, and delta events. Tenant rooms. Integer cents.

## Connection

```
GET /ws?v=2&ticket=<ws-jwt>
GET /ws?v=2&token=<jwt>     # deprecated for one release; prefer ticket
```

`POST /api/v1/ws-ticket` (authenticated) returns `{ "ticket": "<jwt>", "expiresIn": 60 }`. The ticket is a JWT with `purpose: "ws"`, the same claims as the caller, and a 60 second expiry. `/ws?ticket=` accepts only tokens whose `purpose` is `"ws"`. A normal API JWT is rejected. A ticket older than 60 seconds is rejected at connect time; once connected, the socket stays open after the ticket expires.

`?token=` still accepts an employee or guest API JWT while `ALLOW_LEGACY_WS_TOKEN` is not `false`. With `ALLOW_LEGACY_WS_TOKEN=false` it is closed with `4003`. Do not send long-lived tokens in the URL after clients move to tickets.

The token is an employee JWT or a guest table JWT from `POST /api/v1/auth/table/:qrCode`. Rooms are taken from that token:

- guest: `r:{restaurantId}:session:{sessionId}`
- employee: `r:{restaurantId}:staff`

The server pings every 30 seconds. A socket that misses one pong is terminated on the next sweep and removed from all rooms (about 60 seconds).

## Close codes

| Code | Meaning | Client action |
|---|---|---|
| `4000` | unsupported protocol version | stop; this client is too old or too new |
| `4001` | token expired | refresh token / re-login |
| `4003` | forbidden (bad token, wrong restaurant) | log out |
| `4004` | session closed | guest: show thank-you screen, don't reconnect |
| `4008` | too many violations (3 rate-limit hits) | wait, then reconnect |
| `1001` | server shutting down (SIGTERM) | reconnect with backoff |
| `1009` | message larger than 16 KB | shrink the payload and reconnect |

Closing a session sends `session.closed`, then closes the guest sockets of that session with `4004`. Staff sockets stay open.

## Objects

Dates are ISO-8601 strings. Money is integer cents. No Mongoose internals (`__v`, populated documents) are included.

### Order

```jsonc
{
  "_id": "string",
  "restaurantId": "string",
  "sessionId": "string",
  "tableId": "string",
  "clientOrderId": "string",
  "status": "pending|accepted|preparing|ready|served|cancelled",
  "rev": 1,
  "tickets": [{
    "station": "kitchen|bar",
    "status": "pending|accepted|preparing|ready|served|cancelled",
    "cancelReason": "string"
  }],
  "items": [{
    "productId": "string",
    "title": "string",
    "unitPriceCents": 450,
    "quantity": 2,
    "lineTotalCents": 900,
    "notes": "string",
    "station": "kitchen|bar"
  }],
  "totalCents": 900,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

`tickets` has one entry for each station the order has items for, kitchen first. A line belongs to the ticket of its `station`. An order of drinks only has one ticket.

`status` is the order as a whole: the slowest ticket that is not cancelled (`bar: served` + `kitchen: preparing` is `preparing`). It is `cancelled` only when every ticket is.

`totalCents` leaves out the lines of a cancelled ticket. A fully cancelled order keeps the total of what was cancelled.

`rev` is an integer that starts at 1 and increments by exactly 1 on every change, in the same write. It is present on every order payload and on `order.statusChanged`. clients must ignore events with rev <= the stored rev.

### Session

```jsonc
{
  "_id": "string",
  "tableId": "string",
  "tableNumber": 1,
  "status": "open|paying|closed",
  "openedAt": "ISO-8601",
  "closedAt": "ISO-8601|null"
}
```

### GET /api/v1/staff/board

Staff snapshot of open sessions and their non-cancelled orders. Order objects are byte-identical to ack and event orders.

```jsonc
{
  "sessions": [/* Session + "joinCode": "K7QM" */],
  "recentlyClosed": [/* Session + "totalCents": 1800 — closed in the last 12 hours, newest first, max 50 */],
  "orders": [/* Order — open sessions only */],
  "tables": [{
    "_id": "string",
    "tableNumber": 1,
    "capacity": 4,
    "status": "vacant|occupied|reserved",
    "qrCode": "string"
  }]
}
```

### GET /api/v1/sessions/:id/bill

Staff can read any session of their restaurant. A guest can read only the session in their table token. Works for open and closed sessions. Cancelled orders are excluded.

```jsonc
{ "sessionId": "string", "session": {/* Session */}, "orders": [/* Order */], "totalCents": 1800 }
```

An order that races a session close is rejected with `SESSION_CLOSED`; it never lands in a closed session.

## Client → server

```json
{ "type": "order.create", "requestId": "uuid", "payload": { "clientOrderId": "uuid", "items": [{ "productId": "...", "quantity": 2, "notes": "" }], "tableId": "...", "sessionId": "..." } }
{ "type": "order.update", "requestId": "uuid", "payload": { "orderId": "...", "items": [{ "productId": "...", "quantity": 1 }] } }
{ "type": "order.status", "requestId": "uuid", "payload": { "orderId": "...", "status": "accepted", "station": "bar" } }
{ "type": "order.cancel", "requestId": "uuid", "payload": { "orderId": "...", "reason": "guest left", "station": "kitchen" } }
```

`station` is optional on both:

- `order.status` with a `station` moves that ticket. Without one it moves the ticket (or tickets) holding the order back, the ones at the order's own `status`; when all tickets are level that is every ticket.
- `order.cancel` with a `station` cancels that ticket. Without one it cancels every ticket that is not already cancelled, and fails with `INVALID_TRANSITION` if any of them is past `accepted`.
- A `station` the order has no ticket for is `NOT_FOUND`.

### Permissions

| Message | Guest | Staff |
|---|---|---|
| `order.create` | own session only | yes (needs `tableId` or `sessionId`) |
| `order.update` | own session, every ticket `pending` | every ticket `pending` |
| `order.status` | `FORBIDDEN` | yes, any ticket |
| `order.cancel` | own session, whole order, no ticket started | a ticket that is `pending` / `accepted` |

A guest `order.cancel` with a `station` is `FORBIDDEN`. Staff of any position may move or cancel any ticket; the bar and kitchen screens decide what is shown, not what is allowed.

A guest is bound to the session in their token. `tableId` or `sessionId` in a guest payload is ignored. A guest acting on another session's order receives `NOT_FOUND`. Any table number in a payload is ignored for routing.

Staff `order.create` with only `tableId` joins that table's open session. If the table is vacant, the server opens a session (same unique-index protection as a guest's first order). The first order that opens a session emits `session.opened` to the staff room, then `order.created`.

Resending `order.create` with a `clientOrderId` that already exists in this restaurant returns `ok: true` with the existing order and emits no new event.

## Server → requester

Exactly one ack per message, carrying the same `requestId`:

```json
{ "type": "ack", "requestId": "uuid", "ok": true, "data": { "order": {} } }
{ "type": "ack", "requestId": "uuid", "ok": false, "error": { "code": "OUT_OF_STOCK", "message": "..." } }
```

Error codes: `VALIDATION`, `NOT_FOUND`, `OUT_OF_STOCK`, `FORBIDDEN`, `INVALID_TRANSITION`, `SESSION_CLOSED`, `RATE_LIMITED`, `INTERNAL`.

`details` is optional:

```jsonc
{ "code": "OUT_OF_STOCK", "message": "Out of stock", "details": { "productIds": ["..."] } }
{ "code": "VALIDATION", "message": "...", "details": { "fields": { "items.0.quantity": "must be >= 1" } } }
{ "code": "INVALID_TRANSITION", "message": "...", "details": { "from": "ready", "to": "pending" } }
{ "code": "RATE_LIMITED", "message": "Too many messages", "details": { "retryAfterMs": 1000 } }
```

An unknown `type` is `VALIDATION`. The 11th message within 10 seconds is `RATE_LIMITED`, not `VALIDATION`. A third rate-limit violation closes the socket with `4008`. An expired token is closed with code `4001`.

## Server → room

```json
{ "type": "event", "event": "session.opened", "data": { "session": { "joinCode": "K7QM" } } }
{ "type": "event", "event": "order.created", "data": { "order": {} } }
{ "type": "event", "event": "order.updated", "data": { "order": {} } }
{ "type": "event", "event": "order.statusChanged", "data": { "orderId": "...", "status": "pending", "rev": 2, "tickets": [], "totalCents": 1800, "station": "bar" } }
{ "type": "event", "event": "session.closed", "data": { "sessionId": "...", "tableId": "..." } }
{ "type": "event", "event": "menu.updated", "data": { "_id": "...", "title": "...", "priceCents": 450, "inStock": true, "category": "food", "archived": false } }
```

`session.paid` is reserved for a later Stripe flow and is not emitted yet.

`order.statusChanged` carries the order's `status`, all its `tickets`, and its `totalCents` after the change; `station` is present when the message named one. Cancel emits it too, with `reason`; `status` is `"cancelled"` only when that was the order's last ticket. `session.opened` goes to the staff room only, and only when that order opened the session. Other order events go to that session's room and the staff room.

`menu.updated` is sent on any menu change (create, price, name, stock, archive) and carries the full item. Clients should replace the item in their menu cache.

Menu updates go to every room for the restaurant.

Each ticket moves `pending → accepted → preparing → ready → served` on its own, so the bar can serve the drinks while the kitchen is still cooking. Staff can cancel a ticket that is `pending` or `accepted`; the guest who owns the session can cancel the order while no ticket has started. Adding food during a meal creates a new order in the same session. An order can be edited while every ticket is `pending`; the edit rebuilds the tickets from the new items.

Money on an order is integer cents (`unitPriceCents`, `lineTotalCents`, `totalCents`), copied from the menu at creation.

## Limits

| Limit | Value | Error |
|---|---|---|
| Message size | 16 KB | socket closed with `1009` |
| Rate limit | 10 messages / 10 seconds per socket | ack `RATE_LIMITED` with `details.retryAfterMs` |
| Items per order | 50 | ack `VALIDATION`, `details.fields.items` |
| Quantity per item | 99 | ack `VALIDATION`, `details.fields["items.0.quantity"]` |
| Notes length | 200 characters | ack `VALIDATION`, `details.fields["items.0.notes"]` |

## Deployment

Vercel serves this Express app and does not own sockets. Render runs `src/server.js`, which listens and attaches `/ws`. A Vercel-side change that must be live calls `POST {RENDER_INTERNAL_URL}/internal/emit` with header `x-internal-secret`. Requests without that secret get `401`.
