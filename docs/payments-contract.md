# Payments contract

The API contract for paying a **Bill**, signing with the **TSE**, and the guest's **Receipt** (#19, #20). Later API tickets implement it, and the frontend (`RopeJuve/plate-vista-react`) builds its mocks from it.

Background:

- [ADR-0003: The TSE signs each order and each payment](adr/0003-tse-signs-each-order-and-each-payment.md)
- [ADR-0004: The VAT rate belongs to the category](adr/0004-vat-rate-belongs-to-category.md)
- [ADR-0005: TSE signing runs on the Render server](adr/0005-tse-signing-runs-on-render.md)
- [`GLOSSARY.md` → Paying](../GLOSSARY.md#paying): Bill, Payment, Receipt, TSE, VAT Rate

The realtime part is in [`src/realtime/PROTOCOL.md`](../src/realtime/PROTOCOL.md) as v2.3.

## Conventions

All paths are under `/api/v1`. The tenant comes from the auth token, like existing routes. Errors use the existing `AppError` shape. Money is integer cents; dates are ISO-8601 strings.

## Enums

```ts
VatRate         = 'NORMAL' | 'REDUCED_1'                   // 19 % | 7 %
PaymentMethod   = 'CASH' | 'CARD_TERMINAL' | 'ONLINE'      // ONLINE reserved for Stripe, later
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
