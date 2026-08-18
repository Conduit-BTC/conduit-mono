# Historical AI Review Followups (MVP Era)

> Historical only: current shared messaging code retains and surfaces typed,
> content-free unwrap/decrypt failures. The statements below describe the 2026-02
> review baseline and must not be treated as current Product behavior.

Source: AI review notes captured on 2026-02-11.

These are "nice-to-have" followups that were explicitly called out as acceptable to defer for MVP, but worth tracking so we do not forget.

## Product + Checkout Correctness

- Verify merchant identity at checkout:
  - Before sending an order, verify the listing "merchant pubkey" we are about to DM matches what the UI is presenting as the merchant (and ideally the listing author / expected tag).
  - If we cannot verify deterministically, warn and show the pubkey that will receive the order.
- Price staleness / listing updates:
  - Consider warning if the listing has been updated (replaceable event) after it was added to cart, or if the price differs from current listing price.
- Multi-currency cart validation:
  - Current checkout assumes one currency across the cart (defaults to first item's currency).
  - Add validation to prevent checkout if currencies differ (or split into separate orders by currency).

## Reliability + Observability

- Merchant orders polling interval:
  - Current interval is a fixed `10s`.
  - Make configurable for production (and/or use backoff when relay errors occur).
- Decryption failures (resolved since this review):
  - Shared gift-wrap unwrapping now retains and surfaces typed, content-free
    failures without logging plaintext, ciphertext, order contents, or messages.
- Relay connect timeout:
  - `ndk.connect(3000)` may be too short for slow networks.
  - Make configurable (env or constant) and consider a slightly longer default.

## Testing

- Add focused tests around:
  - `withTimeout` helper behavior (success, timeout, cleanup).
  - NIP-17 order flow (rumor schema, gift wrap/unwrapping, parse errors).
  - Relay connection failure scenarios and UI error surfacing.
