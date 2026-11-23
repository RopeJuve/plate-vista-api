# Payments contract

The API contract for paying a **Bill**, signing with the **TSE**, and the guest's **Receipt** (#19, #20). Later API tickets implement it, and the frontend (`RopeJuve/plate-vista-react`) builds its mocks from it.

Background:

- [ADR-0003: The TSE signs each order and each payment](adr/0003-tse-signs-each-order-and-each-payment.md)
- [ADR-0004: The VAT rate belongs to the category](adr/0004-vat-rate-belongs-to-category.md)
- [ADR-0005: TSE signing runs on the Render server](adr/0005-tse-signing-runs-on-render.md)
- [ADR-0008: Card readers are server-driven Stripe smart readers; no Tap to Pay](adr/0008-card-readers-are-server-driven-smart-readers-no-tap-to-pay.md)
- [`GLOSSARY.md` → Paying](../GLOSSARY.md#paying): Bill, Payment, Receipt, TSE, VAT Rate

The realtime part is in [`src/realtime/PROTOCOL.md`](../src/realtime/PROTOCOL.md) as v2.3, v2.5 for online payments, and v2.7 for card reader payments.

**Change rule:** this document is the contract between the API and `RopeJuve/plate-vista-react`. Any change to it (a path, a field, an error code, an event) is made here first, in its own commit, before the code that implements it, and the change is announced with a comment on every affected React issue.

## Conventions

All paths are under `/api/v1`. The tenant comes from the auth token, like existing routes. Errors use the existing `AppError` shape. Money is integer cents; dates are ISO-8601 strings.

## Enums

```ts
VatRate         = 'NORMAL' | 'REDUCED_1'                   // 19 % | 7 %
PaymentMethod   = 'CASH' | 'CARD_TERMINAL' | 'CARD_READER' | 'ONLINE'
                  // ONLINE only from Stripe: its webhook, or Stripe read back while the bill is frozen
                  // CARD_READER only from Stripe: the webhook that captures the card reader payment
SignatureStatus = 'PENDING' | 'SIGNED' | 'FAILED'
```

## Changes to existing shapes

```ts
Category (existing)    + vatRate: VatRate
Order line (existing)  + vatRate: VatRate   // copied when the order is placed
```

## Restaurant legal details (owner, admin)

```
GET /restaurant/legal  -> 200 LegalDetails (fields null until filled in)
PUT /restaurant/legal  LegalDetails -> 200 LegalDetails | 400 VALIDATION
```

```ts
LegalDetails = {
  legalName,
  address: { street, zip, city, country: 'DE' },
  taxNumber?,
  vatId?,
}
// taxNumber or vatId is required
```

## TSE (owner, admin)

```
GET  /tse          -> 200 TseStatus
POST /tse/setup    -> 200 TseStatus
                   -> 422 RESTAURANT_DETAILS_MISSING
                   -> 502 TSE_SETUP_FAILED          (calling again resumes)
GET  /tse/failed   -> 200 { items: FailedSignature[] }   // newest first
POST /tse/failed/:kind/:id/retry -> 200 { status: SignatureStatus }
```

```ts
TseStatus = { active: bool, tssSerial?, clientId?, setupAt?, failedSignatures: int }

FailedSignature = {
  kind: 'PAYMENT' | 'ORDER',
  id,
  tableNumber,
  at,
  amountCents,
  error,
  retryCount,
}
```

## Payments (any staff)

```
POST /sessions/:id/payments
  { method: 'CASH' | 'CARD_TERMINAL', clientPaymentId: string, expectedTotalCents: int }
  -> 201 Payment
  -> 200 Payment                         same clientPaymentId again (replay)
  -> 409 BILL_PAID
  -> 409 BILL_CHANGED { totalCents }     a new order or cancel changed the total
  -> 412 TSE_NOT_ACTIVE
  -> 422 BILL_EMPTY                      total is 0: close the table instead
  -> 404

GET /sessions/:id/bill (existing)  + payment: Payment | null
GET /sessions/:id/receipt-token    guest of this session (also closed) or staff; 60/min per IP
  -> 200 { receiptToken }            the bill has a Payment (any method)
  -> 202 { status: 'PAYING' }        session is paying: online or card reader payment in progress
  -> 404                             no payment and not paying
GET /staff/board (existing)        sessions[] + payment: Payment | null   (PROTOCOL 2.4)
```

```ts
Payment = {
  id,
  sessionId,
  method,
  amountCents,
  paidAt,
  receiptToken,
  signature: { status: SignatureStatus },
}
```

**Bill lock:** `order.create`, `order.update` and ticket cancel on a paid bill fail with `BILL_PAID`.

## Closing a table

```
POST /sessions/:id/close (existing)          -> 409 BILL_UNPAID when the bill is above 0 and unpaid
POST /sessions/:id/close { unpaidReason }    owner/admin only: closes anyway, reason stored
```

## Receipt (public, no auth, rate-limited)

```
GET /receipts/:receiptToken -> 200 Receipt | 404
```

```ts
Receipt = {
  restaurant: { name, legalName, address, taxNumber?, vatId? },
  receiptNumber: number | null,        // the TSE transaction number (ADR-0007); null until the payment is signed
  tableNumber?,
  servicePeriod: { start, end },       // first order not wholly cancelled → paidAt
  lines: [{ title, quantity, unitPriceCents, lineTotalCents, vatRate }],  // merged by item + unit price + VAT rate across the bill (a rate change mid-visit gives two lines, each taxed right)
  totalsByVat: [{ vatRate, netCents, vatCents, grossCents }],
  totalCents,
  method,
  paymentDetails?: {                   // ONLINE (below) or CARD_READER (CardPresentDetails, see Card reader payments), kept from Stripe when the payment was recorded; absent if Stripe could not be read
    type,                              // Stripe's payment method type: card, paypal, klarna, sepa_debit, ...
    brand?, last4?, funding?,          // cards only (funding: credit | debit | prepaid | unknown)
    wallet?,                           // apple_pay | google_pay | link | ..., cards only
    authorizationCode?,                // cards only, when the network gave one
    transactionId?,                    // the Stripe PaymentIntent id
    authorizedAt?,
  },
  paidAt,
  signature: {
    status: SignatureStatus,
    txNumber?, timeStart?, timeEnd?, value?,
    counter?, tssSerial?, clientSerial?, qrCodeData?,
  },
}
```

## Realtime (PROTOCOL v2.3)

Sent to the staff room and the session's room unless noted.

```ts
bill.paid          { sessionId, paymentId, receiptToken, method, totalCents }
payment.signed     { paymentId, receiptToken }
payment.signFailed { paymentId }          // staff room only
```

## Online payments (Stripe)

The guest pays the whole **Bill** online through Stripe; the money goes to the restaurant's **Payout Account** ([ADR-0006](adr/0006-online-payments-go-to-the-restaurants-own-stripe-connect-account.md)). Only the Stripe webhook records an online Payment; neither the guest's device nor the frontend ever does. API tickets: #61 (Payout Account), #62 (switch, `canPayOnline`), #63 (start, freeze), #64 (webhook), #65 (Late Payment refund), #66 (unfreeze).

Every route here answers 503 `STRIPE_NOT_CONFIGURED` when the server has no Stripe keys.

### Payout Account (owner only; admin, bar, kitchen, guest → 403)

```
POST  /restaurant/payout-account  -> 200 { url }          // Stripe-hosted onboarding; send the browser there
GET   /restaurant/payout-account  -> 200 PayoutAccount
PATCH /restaurant/payout-account  { onlinePaymentsEnabled: bool } -> 200 PayoutAccount | 400 VALIDATION | 409 PAYOUT_ACCOUNT_MISSING
```

```ts
PayoutAccount = { connected: bool, chargesEnabled: bool, detailsSubmitted: bool, onlinePaymentsEnabled: bool }
// connected:        a Payout Account was created (onboarding started)
// detailsSubmitted: the owner has nothing left to fill in; Stripe may still be reviewing
// chargesEnabled:   Stripe made card payments active; online payments can run
// onlinePaymentsEnabled: the owner's switch, default true
```

Stripe sends the owner back to the dashboard:

- `return_url` = `${DASHBOARD_URL}/admin/kasse?payout=return`: the owner left or finished the form. Read `GET` again; Stripe may still be reviewing.
- `refresh_url` = `${DASHBOARD_URL}/admin/kasse?payout=refresh`: the link expired. `POST` again for a fresh link and redirect; the same account is reused.

Until `chargesEnabled`, every `GET` reads the account from Stripe, so the status is current when the owner comes back. After that, Stripe's Accounts v2 events keep it current: create an event destination with **thin** payloads for the `v2.core.account[requirements].updated` and `v2.core.account[configuration.merchant].capability_status_updated` events, pointing at `POST /api/v1/webhooks/stripe/accounts`, and put its signing secret in `STRIPE_ACCOUNT_WEBHOOK_SECRET`.

### The bill

```
GET /sessions/:id/bill (existing)  + canPayOnline: bool
```

`canPayOnline` is true only when the Payout Account has `chargesEnabled`, `onlinePaymentsEnabled` is on, the TSE is active, the session is `open`, the bill is unpaid with `totalCents > 0`, and Stripe is configured. Guests see nothing else about the Payout Account.

**Frozen bill:** while a guest is paying online, or staff take a card reader payment, the session's `status` is `paying` (see **Bill** in `GLOSSARY.md`). New orders and ticket cancels fail with 409 `BILL_FROZEN`; staff can still move tickets forward.

### Paying online (the session's guest, or staff)

```
POST /sessions/:id/online-payment
  -> 200 { url, expiresAt }                 send the browser to url (Stripe); expiresAt is at most 30 min away
                                             frozen already: the same url again, for anyone at the table
  -> 409 ONLINE_PAYMENT_UNAVAILABLE         canPayOnline is false
  -> 502 PAYMENT_PROVIDER_ERROR             Stripe failed; the bill stays open
  -> 404                                     a guest token for another session

POST /sessions/:id/online-payment/cancel    guest of this session, owner, admin (bar/kitchen → 403)
  -> 200 { status }                          unfrozen (`open`), or was not frozen (the session's status)
  -> 409 BILL_PAYING_ONLINE                  the guest has just paid; wait for bill.paid
  -> 502 PAYMENT_PROVIDER_ERROR              guest only: Stripe failed; the bill stays frozen until it expires
  -> 404                                     a guest token for another session
```

Every unfreeze expires the Stripe Checkout Session first, then the session is `open` and `bill.unfrozen` goes out.

Stripe sends the guest back to their own table page, so the app finds the guest token there:

- `success_url` = `${GUEST_APP_URL}/r/:slug/t/:qrCode?payment=return`: wait for `bill.paid`, polling `GET /sessions/:id/receipt-token` as a backup (202 `PAYING` = not confirmed yet, 404 = not paid and no longer frozen).
- `cancel_url` = `${GUEST_APP_URL}/r/:slug/t/:qrCode?payment=cancelled`: call `POST /sessions/:id/online-payment/cancel`.

**Staff win:** recording cash or card (`POST /sessions/:id/payments`) or closing the table on a frozen bill unfreezes it first. When the guest has already paid online, the paid Checkout Session is read from Stripe and recorded as the online Payment right there (the webhook may never arrive), so cash answers 409 `BILL_PAID` and close goes ahead; only if Stripe cannot be read then do they answer 409 `BILL_PAYING_ONLINE`. When Stripe cannot be reached, staff still win: the bill unfreezes and the payment or close goes ahead; a guest payment that completes anyway is a Late Payment and is refunded. A close that would fail with `BILL_UNPAID` fails before touching the guest's payment.

When the webhook records the online Payment (or the server records it after reading the paid Checkout Session from Stripe: on a `receipt-token` poll, an unfreeze, a staff payment or a close), `bill.paid` arrives with `method: 'ONLINE'`, and the Payment, receipt and TSE signing are the same as for cash.

### Late Payments (owner, admin)

A **Late Payment** (see `GLOSSARY.md`) is refunded in full automatically and never becomes a Payment.

```
GET /restaurant/online-payment-refunds?limit=50&before=<refundedAt>
  -> 200 { items: OnlinePaymentRefund[], nextBefore: string | null }   // newest first; limit 1–100, default 50
```

```ts
OnlinePaymentRefund = {
  id,
  sessionId,
  tableNumber,
  amountCents,
  reason: 'BILL_ALREADY_PAID' | 'BILL_NOT_FROZEN' | 'SESSION_CLOSED',
  refundedAt,
}
```

### Errors

| Code | Status | When |
|---|---|---|
| `STRIPE_NOT_CONFIGURED` | 503 | the server has no Stripe keys |
| `ONLINE_PAYMENT_UNAVAILABLE` | 409 | start while `canPayOnline` is false |
| `PAYOUT_ACCOUNT_MISSING` | 409 | switching online payments before onboarding started (`connected: false`) |
| `PAYMENT_PROVIDER_ERROR` | 502 | Stripe failed when starting, or when a guest cancels |
| `BILL_FROZEN` | 409 | order or ticket cancel while the bill is frozen |
| `BILL_PAYING_ONLINE` | 409 | unfreeze, staff payment or close when the guest has just paid online |

### Realtime (PROTOCOL v2.5)

```ts
bill.frozen             { sessionId, expiresAt }                        // staff room + session room
bill.unfrozen           { sessionId }                                   // staff room + session room
online_payment.refunded { refund: OnlinePaymentRefund }                 // staff room only
```

## Card reader payments (Stripe Terminal)

Staff send a **Bill**'s payment to a **Card Reader**, and the guest taps or inserts their card there. The API drives the reader server-side and the staff app only watches ([ADR-0008](adr/0008-card-readers-are-server-driven-smart-readers-no-tap-to-pay.md)); the money goes to the restaurant's **Payout Account** ([ADR-0006](adr/0006-online-payments-go-to-the-restaurants-own-stripe-connect-account.md)). The amount is always the bill's total; nobody types it on the reader. Only Stripe's webhook records a card reader Payment, never the staff app.

Every route here answers 503 `STRIPE_NOT_CONFIGURED` when the server has no Stripe keys. **Test mode** means the server runs with Stripe test keys; only then do **Simulated Readers** exist.

**Stripe setup (manual, once per mode, #91):** the connected-accounts webhook destination that already sends `checkout.session.completed` to `POST /api/v1/webhooks/stripe` (signing secret in `STRIPE_WEBHOOK_SECRET`) must also send these events, in test mode and in live mode:

| Event | Without it |
|---|---|
| `payment_intent.amount_capturable_updated` | an authorized card is captured and recorded only when the server asks Stripe (a `receipt-token` poll, a cancel, a staff payment, a close, or expiry) |
| `payment_intent.payment_failed` | a declined card is not reported; the attempt runs until it expires |
| `terminal.reader.action_failed` | a reader that fails (offline, timed out, cancelled on the reader) is not reported; the attempt runs until it expires |

### Shapes

```ts
CardReader = {
  id,                                   // our id, not Stripe's
  name,                                 // 1–40 characters, trimmed; chosen by the owner or admin
  deviceType,                           // Stripe's device type: 'stripe_s700' | 'stripe_s710' | 'bbpos_wisepos_e' | 'simulated_wisepos_e' | ...
  serialNumber,
  status: 'online' | 'offline',         // as Stripe last reported it, at most 30 s old
  simulated: bool,                      // a Simulated Reader (test mode only)
  busyWith: { sessionId, tableNumber } | null,   // the bill whose card reader payment it is taking now
  addedAt,
}

CardReaderPayment = {                   // one attempt to take a bill's payment on a reader
  id,
  sessionId,
  reader: { id, name, simulated },
  amountCents,                          // the bill's total when the attempt started
  status: 'IN_PROGRESS' | 'FAILED',     // once paid it is a Payment; once cancelled or expired it is gone
  failure: { reason: PaymentFailureReason, message } | null,   // FAILED only
  startedAt,
  expiresAt,                            // IN_PROGRESS: at most 5 min after startedAt
}

PaymentFailureReason =
  | 'DECLINED'               // the card was declined, no more detail
  | 'INSUFFICIENT_FUNDS'
  | 'LOST_OR_STOLEN_CARD'
  | 'EXPIRED_CARD'
  | 'PROCESSING_ERROR'       // the card network failed; trying again may work
  | 'CANCELLED_ON_READER'    // someone pressed cancel on the reader
  | 'READER_OFFLINE'         // the reader lost its connection during the payment
  | 'OTHER'
// message: one English sentence staff can read as is, e.g. "The card was declined for insufficient funds."
//          The React app may translate by `reason` instead.

BillFreeze = {                          // why the bill is frozen (session status 'paying')
  kind: 'ONLINE' | 'CARD_READER',
  readerName: string | null,            // CARD_READER only
  totalCents,
  expiresAt,
}
```

### Card Readers (owner, admin; bar, kitchen, guest → 403)

```
GET    /restaurant/card-readers
  -> 200 { items: CardReader[], testMode: bool, payoutAccountReady: bool }   // items by name
POST   /restaurant/card-readers  { registrationCode, name }
  -> 201 CardReader
  -> 400 VALIDATION
  -> 409 PAYOUT_ACCOUNT_NOT_READY
  -> 422 RESTAURANT_DETAILS_MISSING      the Stripe Location needs the legal address (GET /restaurant/legal)
  -> 422 CARD_READER_CODE_INVALID
  -> 502 PAYMENT_PROVIDER_ERROR
POST   /restaurant/card-readers/simulated  { name }
  -> 201 CardReader                      simulated: true, status: 'online'
  -> 400 VALIDATION
  -> 409 SIMULATED_READER_LIVE_MODE
  -> 409 PAYOUT_ACCOUNT_NOT_READY
  -> 422 RESTAURANT_DETAILS_MISSING
  -> 502 PAYMENT_PROVIDER_ERROR
DELETE /restaurant/card-readers/:id
  -> 204                                 removed here and at Stripe; the device can be registered again with a new code
  -> 409 CARD_READER_BUSY { tableNumber }   it is taking a payment; cancel that first
  -> 404
  -> 502 PAYMENT_PROVIDER_ERROR          the reader stays
```

`payoutAccountReady` is the Payout Account's `chargesEnabled`, so an admin (who cannot read the Payout Account) knows why adding is disabled. `testMode` says whether "Add simulated reader" is shown. The registration code is the one the reader shows on screen (Settings → Generate pairing code). Card reader names need not be unique.

```jsonc
// GET /api/v1/restaurant/card-readers
{
  "items": [
    { "id": "6650c0ffee0000000000a001", "name": "Bar", "deviceType": "stripe_s700", "serialNumber": "STRM26138003393", "status": "online", "simulated": false, "busyWith": null, "addedAt": "2026-11-20T09:12:00.000Z" },
    { "id": "6650c0ffee0000000000a002", "name": "Terrasse", "deviceType": "bbpos_wisepos_e", "serialNumber": "WSC513105011295", "status": "offline", "simulated": false, "busyWith": null, "addedAt": "2026-11-20T09:15:00.000Z" },
    { "id": "6650c0ffee0000000000a003", "name": "Test reader", "deviceType": "simulated_wisepos_e", "serialNumber": "SIMULATED-1", "status": "online", "simulated": true, "busyWith": { "sessionId": "6650c0ffee0000000000b001", "tableNumber": 4 }, "addedAt": "2026-11-21T14:00:00.000Z" }
  ],
  "testMode": true,
  "payoutAccountReady": true
}

// POST /api/v1/restaurant/card-readers
{ "registrationCode": "simulated-wpe", "name": "Bar" }
// -> 201 one CardReader as above

// POST /api/v1/restaurant/card-readers/simulated
{ "name": "Test reader" }
// -> 201 one CardReader with "simulated": true, "status": "online"

// DELETE /api/v1/restaurant/card-readers/6650c0ffee0000000000a002   (no body) -> 204, no body

// 409
{ "code": "PAYOUT_ACCOUNT_NOT_READY", "message": "The Payout Account cannot take payments yet." }
{ "code": "SIMULATED_READER_LIVE_MODE", "message": "Simulated readers exist only in test mode." }
{ "code": "CARD_READER_BUSY", "message": "The card reader is taking a payment.", "details": { "tableNumber": 4 } }

// 422
{ "code": "CARD_READER_CODE_INVALID", "message": "The registration code is invalid, expired or already used." }
```

### Availability: the pay panel

```
GET /sessions/:id/bill (existing)
  + freeze: BillFreeze | null                        // everyone; null unless the session is 'paying'
  + cardReader: CardReaderAvailability               // staff only; absent for guests
  + cardReaderPayment: CardReaderPayment | null      // staff only; absent for guests
```

```ts
CardReaderAvailability = {
  state: 'OFFERED' | 'DISABLED' | 'HIDDEN',
  reason: CardReaderUnavailableReason | null,   // DISABLED only
  readers: CardReader[],                        // [] when HIDDEN; online and not busy ones can be picked
}

CardReaderUnavailableReason =        // the first that applies, in this order
  | 'PAYOUT_ACCOUNT_NOT_READY'       // the Payout Account cannot take charges yet
  | 'TSE_NOT_ACTIVE'
  | 'BILL_PAID'
  | 'BILL_EMPTY'                     // total is 0
  | 'PAYMENT_IN_PROGRESS'            // the bill is frozen (see `freeze`, and `cardReaderPayment` for a card reader)
  | 'NO_READER_AVAILABLE'            // every reader is offline or busy with another bill
```

- **HIDDEN**: Stripe is not configured, the restaurant has no card readers, or the session is closed. The panel shows no "Card reader" button.
- **DISABLED**: the button is shown greyed out with the reason.
- **OFFERED**: staff pick one of the online, not busy `readers` and start.

`cardReaderPayment` is the bill's current attempt: `IN_PROGRESS` while the bill is frozen for it, or the last `FAILED` one so the panel can show the reason and offer Retry. It is `null` after a cancel, an expiry, a payment or a close; a new start replaces it. Reader status changes have no realtime event; the panel reads the bill again when it opens and after each event below.

```jsonc
// GET /api/v1/sessions/6650c0ffee0000000000b001/bill (staff), extract
{
  "totalCents": 4250,
  "payment": null,
  "canPayOnline": false,
  "freeze": { "kind": "CARD_READER", "readerName": "Bar", "totalCents": 4250, "expiresAt": "2026-11-22T19:05:00.000Z" },
  "cardReader": { "state": "DISABLED", "reason": "PAYMENT_IN_PROGRESS", "readers": [ /* CardReader[] */ ] },
  "cardReaderPayment": {
    "id": "6650c0ffee0000000000c001",
    "sessionId": "6650c0ffee0000000000b001",
    "reader": { "id": "6650c0ffee0000000000a001", "name": "Bar", "simulated": false },
    "amountCents": 4250,
    "status": "IN_PROGRESS",
    "failure": null,
    "startedAt": "2026-11-22T19:00:00.000Z",
    "expiresAt": "2026-11-22T19:05:00.000Z"
  }
}

// the same bill after a decline
{
  "freeze": null,
  "cardReader": { "state": "OFFERED", "reason": null, "readers": [ /* ... */ ] },
  "cardReaderPayment": {
    "id": "6650c0ffee0000000000c001", "sessionId": "6650c0ffee0000000000b001",
    "reader": { "id": "6650c0ffee0000000000a001", "name": "Bar", "simulated": false },
    "amountCents": 4250, "status": "FAILED",
    "failure": { "reason": "INSUFFICIENT_FUNDS", "message": "The card was declined for insufficient funds." },
    "startedAt": "2026-11-22T19:00:00.000Z", "expiresAt": "2026-11-22T19:05:00.000Z"
  }
}
```

### Paying on a card reader (any staff: owner, admin, bar, kitchen; guest → 403)

The same staff who can record cash.

```
POST /sessions/:id/card-reader-payment  { readerId, expectedTotalCents }
  -> 200 CardReaderPayment               IN_PROGRESS; the bill is frozen and the reader asks for the card
                                         the same reader already in progress for this bill: the same attempt again, no new event
  -> 400 VALIDATION
  -> 409 BILL_PAID
  -> 409 BILL_CHANGED { totalCents }
  -> 422 BILL_EMPTY
  -> 409 PAYMENT_IN_PROGRESS { kind: 'ONLINE' | 'CARD_READER', readerName: string | null }
  -> 409 CARD_READER_BUSY { tableNumber: number | null }
  -> 409 CARD_READER_OFFLINE
  -> 409 CARD_READER_PAYMENT_UNAVAILABLE { reason: 'PAYOUT_ACCOUNT_NOT_READY' | 'TSE_NOT_ACTIVE' }
  -> 502 PAYMENT_PROVIDER_ERROR          the bill stays open
  -> 404                                 session or reader not found

POST /sessions/:id/card-reader-payment/cancel
  -> 200 { status }                      unfrozen (`open`), or nothing was in progress (the session's status)
  -> 409 BILL_PAID                       the card already went through; bill.paid is on its way or arrived
  -> 404

POST /sessions/:id/card-reader-payment/retry  { expectedTotalCents }
  -> 200 CardReaderPayment               IN_PROGRESS again on the failed attempt's reader
  -> 404                                 no FAILED attempt to retry
  -> every error of starting
```

```jsonc
// POST /api/v1/sessions/6650c0ffee0000000000b001/card-reader-payment
{ "readerId": "6650c0ffee0000000000a001", "expectedTotalCents": 4250 }
// -> 200 the CardReaderPayment shown under Availability (IN_PROGRESS)

// 409
{ "code": "CARD_READER_BUSY", "message": "The card reader is taking another table's payment.", "details": { "tableNumber": 7 } }
{ "code": "PAYMENT_IN_PROGRESS", "message": "A payment is already in progress for this bill.", "details": { "kind": "ONLINE", "readerName": null } }
{ "code": "CARD_READER_PAYMENT_UNAVAILABLE", "message": "Card reader payments are not available.", "details": { "reason": "TSE_NOT_ACTIVE" } }

// POST /api/v1/sessions/6650c0ffee0000000000b001/card-reader-payment/cancel   (no body)
// -> 200
{ "status": "open" }

// POST /api/v1/sessions/6650c0ffee0000000000b001/card-reader-payment/retry
{ "expectedTotalCents": 4250 }
// -> 200 the CardReaderPayment with status "IN_PROGRESS", failure null, new startedAt and expiresAt (same id)
```

What happens next arrives over the socket (see Realtime below):

- **Card goes through:** Stripe's webhook captures the authorization while the bill is still frozen for this attempt and records the Payment (`method: 'CARD_READER'`), then `bill.paid`. The bill is never unfrozen in between; receipt and TSE signing are the same as for cash.
- **Card declined, or the reader fails:** `bill.paymentFailed`, then `bill.unfrozen` with reason `FAILED`. The attempt stays on the bill as `FAILED` until Retry, a new start, cancel, a payment, or close. Retry uses the same reader; while the bill was open in between, guests may have ordered, so `expectedTotalCents` may now answer `BILL_CHANGED`.
- **Nobody presents a card before `expiresAt`:** the reader is cleared, then `bill.unfrozen` with reason `EXPIRED`.
- **Cancel:** the reader is cleared and any authorization released, then `bill.unfrozen` with reason `CANCELLED`. Staff always win a cancel: if Stripe cannot be reached the bill unfreezes anyway, and a card that still goes through is released, never charged.
- **Staff record cash or card terminal, or close the table** while the bill is frozen for a card reader: staff win, as for online payments. The reader is cleared and any authorization released, `bill.unfrozen` with reason `STAFF_PAYMENT`, then `bill.paid` (or `session.closed`). If the card already went through, cash answers 409 `BILL_PAID` and close goes ahead. A close that would fail with `BILL_UNPAID` fails before touching the reader.

While the bill is frozen for a card reader: orders and ticket cancels fail with 409 `BILL_FROZEN`, `canPayOnline` is false (starting online answers `ONLINE_PAYMENT_UNAVAILABLE`), and `POST /sessions/:id/online-payment/cancel` answers 200 `{ status: 'paying' }` without touching it. `POST /sessions/:id/payments` still takes only `CASH` and `CARD_TERMINAL`; `CARD_READER` there is 400 `VALIDATION`.

### Test cards (test mode, Simulated Reader only)

```
POST /sessions/:id/card-reader-payment/test-card  { card: TestCard }
  -> 200 CardReaderPayment               still IN_PROGRESS; the outcome follows as events
  -> 409 SIMULATED_READER_LIVE_MODE      the server is in live mode
  -> 409 CARD_READER_NOT_SIMULATED       the attempt is on a real reader
  -> 404                                 no IN_PROGRESS attempt on this bill
  -> 502 PAYMENT_PROVIDER_ERROR
```

| `TestCard` | Stripe test card | Outcome |
|---|---|---|
| `APPROVED` | 4242 4242 4242 4242 (Visa, credit, contactless) | `bill.paid` |
| `DECLINED` | 4000 0000 0000 0002 | `bill.paymentFailed` `DECLINED` |
| `INSUFFICIENT_FUNDS` | 4000 0000 0000 9995 | `bill.paymentFailed` `INSUFFICIENT_FUNDS` |
| `LOST_CARD` | 4000 0000 0000 9987 | `bill.paymentFailed` `LOST_OR_STOLEN_CARD` |
| `STOLEN_CARD` | 4000 0000 0000 9979 | `bill.paymentFailed` `LOST_OR_STOLEN_CARD` |
| `EXPIRED_CARD` | 4000 0000 0000 0069 | `bill.paymentFailed` `EXPIRED_CARD` |
| `PROCESSING_ERROR` | 4000 0000 0000 0119 | `bill.paymentFailed` `PROCESSING_ERROR` |

```jsonc
// POST /api/v1/sessions/6650c0ffee0000000000b001/card-reader-payment/test-card
{ "card": "INSUFFICIENT_FUNDS" }
// -> 200 the CardReaderPayment (IN_PROGRESS); then bill.paymentFailed and bill.unfrozen

// 409
{ "code": "CARD_READER_NOT_SIMULATED", "message": "Test cards work only on a simulated reader." }
```

The staff app shows these buttons only when `cardReaderPayment.reader.simulated` is true.

### Payment and receipt

```ts
Payment (existing)  + paymentDetails: CardPresentDetails | null   // CARD_READER only; null for every other method

CardPresentDetails = {
  type: 'card_present',
  brand,                    // Stripe's brand: visa | mastercard | amex | jcb | diners | discover | unionpay | unknown | ...
  last4,
  funding,                  // credit | debit | prepaid | unknown
  authorizationCode?,       // when the network gave one
  aid?,                     // EMV Application ID, e.g. "A0000000031010"
  applicationLabel?,        // e.g. "VISA CREDIT"
  readMethod,               // contactless_emv | contact_emv | contactless_magstripe_mode | magnetic_stripe_fallback | magnetic_stripe_track2
  transactionId,            // the Stripe PaymentIntent id
  authorizedAt,
}
```

`Receipt.paymentDetails` (existing, ONLINE) is also set for `CARD_READER`, with the `CardPresentDetails` above, kept when the payment was recorded. The receipt shows the method `CARD_READER` with the same label as `CARD_TERMINAL`: **"Card"** ("Karte" in German copy), followed by the card details. Guests are not told whether the card was taken on a Card Reader or a Card Terminal.

```jsonc
// Payment with method CARD_READER
{
  "id": "6650c0ffee0000000000d001",
  "sessionId": "6650c0ffee0000000000b001",
  "method": "CARD_READER",
  "amountCents": 4250,
  "paidAt": "2026-11-22T19:01:12.000Z",
  "receiptToken": "9f1c2b7e4a6d8e0f1a2b3c4d5e6f7a8b",
  "signature": { "status": "PENDING" },
  "paymentDetails": {
    "type": "card_present",
    "brand": "visa",
    "last4": "4242",
    "funding": "credit",
    "authorizationCode": "123456",
    "aid": "A0000000031010",
    "applicationLabel": "VISA CREDIT",
    "readMethod": "contactless_emv",
    "transactionId": "pi_3QaBcDeFgHiJkLmN0aBcDeFg",
    "authorizedAt": "2026-11-22T19:01:09.000Z"
  }
}
```

### Sales by payment method (owner, admin; like the other statistics)

```
GET /statistics/sales/payment-methods?start_date&end_date   both or neither; by paidAt
  -> 200 PaymentMethodSales[]          always CASH, CARD, ONLINE, in that order
  -> 400 { error }                     only one of start_date, end_date, or an invalid date

PaymentMethodSales = {
  group: 'CASH' | 'CARD' | 'ONLINE',   // CARD = CARD_TERMINAL + CARD_READER
  count, totalCents,
  methods: [{ method: PaymentMethod, count, totalCents }],   // the exact methods used in the group; [] when none
}
```

```jsonc
// GET /api/v1/statistics/sales/payment-methods
[
  { "group": "CASH", "count": 1, "totalCents": 1000, "methods": [{ "method": "CASH", "count": 1, "totalCents": 1000 }] },
  { "group": "CARD", "count": 3, "totalCents": 7000, "methods": [
    { "method": "CARD_TERMINAL", "count": 2, "totalCents": 3000 },
    { "method": "CARD_READER", "count": 1, "totalCents": 4000 }
  ] },
  { "group": "ONLINE", "count": 0, "totalCents": 0, "methods": [] }
]
```

### Errors

| Code | Status | When |
|---|---|---|
| — | 403 | a role that may not call the route (Card Readers: bar, kitchen, guest; paying: guest). Body `{ message: 'Forbidden' }`, the shared role check |
| `STRIPE_NOT_CONFIGURED` | 503 | the server has no Stripe keys |
| `PAYOUT_ACCOUNT_NOT_READY` | 409 | adding a reader before the Payout Account can take charges (`chargesEnabled: false`) |
| `RESTAURANT_DETAILS_MISSING` | 422 | adding the first reader before the legal address is filled in |
| `CARD_READER_CODE_INVALID` | 422 | the registration code is wrong, expired, already used, or the reader is registered to another Stripe account |
| `SIMULATED_READER_LIVE_MODE` | 409 | adding a Simulated Reader, or presenting a test card, while the server runs with live Stripe keys |
| `CARD_READER_NOT_SIMULATED` | 409 | presenting a test card on a real reader |
| `BILL_PAID` | 409 | starting or retrying on a paid bill; cancelling after the card went through |
| `BILL_CHANGED` | 409 | `expectedTotalCents` is not the bill's total; `details.totalCents` is |
| `BILL_EMPTY` | 422 | starting or retrying when the total is 0 |
| `PAYMENT_IN_PROGRESS` | 409 | starting while the bill is frozen for an online payment, or for a card reader payment on another reader; `details.kind`, `details.readerName` |
| `CARD_READER_BUSY` | 409 | the reader is taking another bill's payment (`details.tableNumber`; `null` when it is busy with something outside Plate Vista), or removing a reader while it takes one |
| `CARD_READER_OFFLINE` | 409 | starting or retrying on a reader Stripe reports offline |
| `CARD_READER_PAYMENT_UNAVAILABLE` | 409 | starting or retrying while the Payout Account cannot take charges or the TSE is not active; `details.reason` |
| `PAYMENT_PROVIDER_ERROR` | 502 | Stripe failed when adding or removing a reader, starting or retrying (the bill stays open), or presenting a test card |
| `BILL_FROZEN` (existing) | 409 | order or ticket cancel while the bill is frozen, now also for a card reader payment |

### Realtime (PROTOCOL v2.7)

```ts
bill.frozen         { sessionId, expiresAt, kind: 'ONLINE' | 'CARD_READER', readerName: string | null, totalCents }   // staff room + session room
bill.unfrozen       { sessionId, reason: 'CANCELLED' | 'EXPIRED' | 'STAFF_PAYMENT' | 'FAILED' }                    // staff room + session room
bill.paid           { sessionId, paymentId, receiptToken, method: 'CARD_READER', totalCents }                    // staff room + session room (existing event)
bill.paymentFailed  { sessionId, tableNumber, readerName, amountCents, reason: PaymentFailureReason, message, failedAt }  // staff room only
```

- `bill.frozen` and `bill.unfrozen` gain fields for online payments too: `kind: 'ONLINE'` with `readerName: null`; the guest going back or staff cancelling is `CANCELLED`, the Checkout Session expiring is `EXPIRED`, staff recording a payment or closing the table is `STAFF_PAYMENT`. `FAILED` is only for card readers. Clients on v2.5/2.6 ignore the new fields.
- `bill.paymentFailed` goes to the staff room only, so the decline reason never shows on the guests' table devices; it is always followed by `bill.unfrozen` with reason `FAILED`, which goes to both.
- Table devices (session room) learn that the bill is being paid on a card reader from `bill.frozen` (`kind`, `readerName`, `totalCents`), and that it is over from `bill.unfrozen` or `bill.paid`.

```jsonc
{ "type": "event", "event": "bill.frozen", "data": { "sessionId": "6650c0ffee0000000000b001", "expiresAt": "2026-11-22T19:05:00.000Z", "kind": "CARD_READER", "readerName": "Bar", "totalCents": 4250 } }
{ "type": "event", "event": "bill.frozen", "data": { "sessionId": "6650c0ffee0000000000b001", "expiresAt": "2026-11-22T19:30:00.000Z", "kind": "ONLINE", "readerName": null, "totalCents": 4250 } }
{ "type": "event", "event": "bill.paymentFailed", "data": { "sessionId": "6650c0ffee0000000000b001", "tableNumber": 4, "readerName": "Bar", "amountCents": 4250, "reason": "INSUFFICIENT_FUNDS", "message": "The card was declined for insufficient funds.", "failedAt": "2026-11-22T19:01:30.000Z" } }
{ "type": "event", "event": "bill.unfrozen", "data": { "sessionId": "6650c0ffee0000000000b001", "reason": "FAILED" } }
{ "type": "event", "event": "bill.paid", "data": { "sessionId": "6650c0ffee0000000000b001", "paymentId": "6650c0ffee0000000000d001", "receiptToken": "9f1c2b7e4a6d8e0f1a2b3c4d5e6f7a8b", "method": "CARD_READER", "totalCents": 4250 } }
```

`src/realtime/PROTOCOL.md` gets its 2.7 changelog entry with the implementation, not before.

### Changing this contract

The React issues for card reader payments mock the API from this section. Any later change to it is made in this document first, in its own commit, and announced with a comment on each affected React issue in `RopeJuve/plate-vista-react` saying what changed; the API and React then follow.
