# WebSocket protocol v2

Orders change only through this socket. REST reads the current board; it does not create or edit orders.

## Connection

`GET /ws?token=<jwt>`

The token is an employee JWT or a guest table JWT from `POST /api/v1/auth/table/:qrCode`. Rooms are taken from that token:

- guest: `r:{restaurantId}:session:{sessionId}`
- employee: `r:{restaurantId}:staff`

## Client → server

```json
{ "type": "order.create", "requestId": "uuid", "payload": { "clientOrderId": "uuid", "items": [{ "productId": "...", "quantity": 2, "notes": "" }], "tableId": "...", "sessionId": "..." } }
{ "type": "order.update", "requestId": "uuid", "payload": { "orderId": "...", "items": [{ "productId": "...", "quantity": 1 }] } }
{ "type": "order.status", "requestId": "uuid", "payload": { "orderId": "...", "status": "accepted" } }
{ "type": "order.cancel", "requestId": "uuid", "payload": { "orderId": "...", "reason": "guest left" } }
```

`tableId` or `sessionId` is required for staff `order.create`. Guests are bound to the session in their token. Any table number in the payload is ignored.

## Server → requester

Exactly one ack per message, carrying the same `requestId`:

```json
{ "type": "ack", "requestId": "uuid", "ok": true, "data": { "order": {} } }
{ "type": "ack", "requestId": "uuid", "ok": false, "error": { "code": "OUT_OF_STOCK", "message": "..." } }
```

Error codes: `VALIDATION`, `NOT_FOUND`, `OUT_OF_STOCK`, `FORBIDDEN`, `INVALID_TRANSITION`, `SESSION_CLOSED`, `INTERNAL`.

An unknown `type` is `VALIDATION`. A socket that exceeds 10 messages in 10 seconds is acked with `VALIDATION` and is not processed. An expired token is closed with code `4001`.

## Server → room

```json
{ "type": "event", "event": "order.created", "data": { "order": {} } }
{ "type": "event", "event": "order.updated", "data": { "order": {} } }
{ "type": "event", "event": "order.statusChanged", "data": { "orderId": "...", "status": "accepted" } }
{ "type": "event", "event": "session.closed", "data": { "sessionId": "...", "tableId": "..." } }
{ "type": "event", "event": "menu.updated", "data": { "menuItemId": "...", "inStock": false } }
```

Order events go to that session's room and the staff room. Menu updates go to every room for the restaurant.

Status moves `pending → accepted → preparing → ready → served`. `cancelled` is allowed from `pending` or `accepted` only. Adding food during a meal creates a new order (round) in the same session. A pending order can still be edited; later statuses cannot.

Money on an order is integer cents (`unitPriceCents`, `lineTotalCents`, `totalCents`), copied from the menu at creation.

## Deployment

Vercel serves this Express app and does not own sockets. Render runs `src/server.js`, which listens and attaches `/ws`. A Vercel-side change that must be live calls `POST {RENDER_INTERNAL_URL}/internal/emit` with header `x-internal-secret`. Requests without that secret get `401`.
