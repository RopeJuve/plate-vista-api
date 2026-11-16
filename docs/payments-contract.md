# Payments contract

The API contract for paying a **Bill**, signing with the **TSE**, and the guest's **Receipt** (#19, #20). Later API tickets implement it, and the frontend (`RopeJuve/plate-vista-react`) builds its mocks from it.

Background:

- [ADR-0003: The TSE signs each order and each payment](adr/0003-tse-signs-each-order-and-each-payment.md)
- [ADR-0004: The VAT rate belongs to the category](adr/0004-vat-rate-belongs-to-category.md)
- [ADR-0005: TSE signing runs on the Render server](adr/0005-tse-signing-runs-on-render.md)
- [`GLOSSARY.md` → Paying](../GLOSSARY.md#paying): Bill, Payment, Receipt, TSE, VAT Rate

The realtime part is in [`src/realtime/PROTOCOL.md`](../src/realtime/PROTOCOL.md) as v2.3, and v2.5 for online payments.

## Conventions

All paths are under `/api/v1`. The tenant comes from the auth token, like existing routes. Errors use the existing `AppError` shape. Money is integer cents; dates are ISO-8601 strings.

## Enums

```ts
VatRate         = 'NORMAL' | 'REDUCED_1'                   // 19 % | 7 %
PaymentMethod   = 'CASH' | 'CARD_TERMINAL' | 'ONLINE'      // ONLINE only through the Stripe webhook
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
  -> 202 { status: 'PAYING' }        session is paying: online payment in progress
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
  lines: [{ title, quantity, unitPriceCents, lineTotalCents, vatRate }],  // merged by item + unit price + VAT rate across the bill (a rate change mid-visit gives two lines, each taxed right)
  totalsByVat: [{ vatRate, netCents, vatCents, grossCents }],
  totalCents,
  method,
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
PATCH /restaurant/payout-account  { onlinePaymentsEnabled: bool } -> 200 PayoutAccount | 400 VALIDATION
```

```ts
PayoutAccount = { connected: bool, chargesEnabled: bool, detailsSubmitted: bool, onlinePaymentsEnabled: bool }
// connected:        a Payout Account was created (onboarding started)
// detailsSubmitted: the owner finished Stripe's form
// chargesEnabled:   Stripe allows charges; online payments can run
// onlinePaymentsEnabled: the owner's switch, default true
```

Stripe sends the owner back to the dashboard:

- `return_url` = `${DASHBOARD_URL}/admin/kasse?payout=return`: the owner left or finished the form. Read `GET` again; Stripe may still be reviewing.
- `refresh_url` = `${DASHBOARD_URL}/admin/kasse?payout=refresh`: the link expired. `POST` again for a fresh link and redirect; the same account is reused.

### The bill

```
GET /sessions/:id/bill (existing)  + canPayOnline: bool
```

`canPayOnline` is true only when the Payout Account has `chargesEnabled`, `onlinePaymentsEnabled` is on, the TSE is active, the session is `open`, the bill is unpaid with `totalCents > 0`, and Stripe is configured. Guests see nothing else about the Payout Account.

**Frozen bill:** while a guest is paying online the session's `status` is `paying` (see **Bill** in `GLOSSARY.md`). New orders and ticket cancels fail with 409 `BILL_FROZEN`; staff can still move tickets forward.

### Paying online (the session's guest, or staff)

```
POST /sessions/:id/online-payment
  -> 200 { url, expiresAt }                 send the browser to url (Stripe); expiresAt is at most 30 min away
                                             frozen already: the same url again, for anyone at the table
  -> 409 ONLINE_PAYMENT_UNAVAILABLE         canPayOnline is false
  -> 502 PAYMENT_PROVIDER_ERROR             Stripe failed; the bill stays open
  -> 404                                     a guest token for another session

POST /sessions/:id/online-payment/cancel    guest of this session, owner, admin (bar/kitchen → 403)
  -> 200                                     unfrozen, or was not frozen
  -> 409 BILL_PAYING_ONLINE                  the guest has just paid; wait for bill.paid
```

Stripe sends the guest back to their own table page, so the app finds the guest token there:

- `success_url` = `${GUEST_APP_URL}/r/:slug/t/:qrCode?payment=return`: wait for `bill.paid`, polling `GET /sessions/:id/receipt-token` as a backup (202 `PAYING` = not confirmed yet, 404 = not paid and no longer frozen).
- `cancel_url` = `${GUEST_APP_URL}/r/:slug/t/:qrCode?payment=cancelled`: call `POST /sessions/:id/online-payment/cancel`.

**Staff win:** recording cash or card (`POST /sessions/:id/payments`) or closing the table on a frozen bill unfreezes it first. Both can answer 409 `BILL_PAYING_ONLINE` when the guest has just paid online.

When the webhook records the online Payment, `bill.paid` arrives with `method: 'ONLINE'`, and the Payment, receipt and TSE signing are the same as for cash.

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
| `PAYMENT_PROVIDER_ERROR` | 502 | Stripe failed when starting |
| `BILL_FROZEN` | 409 | order or ticket cancel while the bill is frozen |
| `BILL_PAYING_ONLINE` | 409 | unfreeze, staff payment or close when the guest has just paid online |

### Realtime (PROTOCOL v2.5)

```ts
bill.frozen             { sessionId, expiresAt }                        // staff room + session room
bill.unfrozen           { sessionId }                                   // staff room + session room
online_payment.refunded { refund: OnlinePaymentRefund }                 // staff room only
```
