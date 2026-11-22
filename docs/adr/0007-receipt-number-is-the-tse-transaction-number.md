# The receipt number is the TSE transaction number

A receipt's number is the transaction number the TSE gave its payment's `Kassenbeleg` transaction (ADR-0003), not a counter of our own. We chose this because the TSE number is already gapless and sequential per TSS, already printed in the TSE block, and is what a tax auditor matches against the TSE export; a second sequence of ours would be one more number that could disagree with it, and would need its own atomic per-restaurant counter.

## Considered Options

- **Our own per-restaurant receipt counter, assigned when the payment is recorded.** The number is there immediately, but it is a second sequence beside the TSE's, can skip or collide under concurrent payments unless carefully locked, and means nothing to an auditor reading the TSE export.

## Consequences

- Signing runs after the reply (ADR-0005), so a fresh receipt has no number yet; it shows "wird nachgereicht" until the payment is signed, and a payment whose signing failed has none until a retry succeeds.
- Numbers already printed on receipts tie us to this: switching to our own counter later would leave two numbering schemes in circulation.
