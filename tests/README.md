# Retained regression suite

Run `bun test` from the repository root. CI runs the same command on Linux;
the build job depends on it. Bun fails when no tests are discovered. Do not
add `--pass-with-no-tests`, skipped cases, or success-only test placeholders.

The suite intentionally covers a small set of payment and recovery risks:

| File                                                  | Cases | Protection                                                                                                                                                                            |
| ----------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment-proof.test.ts`                               |     5 | Missing, malformed, reported, disputed, or failed payment evidence cannot establish payment.                                                                                          |
| `checkout-spark-settled-outgoing.test.ts`             |    13 | Durable intent before sending, failed persistence/handoff, exact retry authority, ambiguous results, invoice expiry, fee limits, recipient ordering, takeover, and provider identity. |
| `checkout-spark-settled-preparation-recovery.test.ts` |     2 | Lost ACK and outbox-readback recovery preserve the original order, signed envelope, wallet, and funding invoice.                                                                      |
| `order-payment-recovery.test.ts`                      |     4 | Live proof ownership, expired proof recovery, and recoverable state during storage failures.                                                                                          |
| `wallet-migration.test.ts`                            |     5 | Verified replacement before legacy deletion, invalid/colliding data, concurrent migration, and rollback.                                                                              |

The five `address-gateway*.test.ts` / `address-preview-origin.test.ts` files
retain 60 deployment-related cases unchanged. The production deployment workflow
also invokes these files explicitly. Operational smoke scripts are separate; ordinary `bun test` does not run them.
The anonymous zap signer provider canary is retired with that service.

`guest-project-tip.test.ts` adds seven payment-boundary cases for ordinary guest
Lightning tips, including fixed recipient, amount, network, expiry and signature
checks. `retired-anon-zap.test.ts` adds five cases verifying that retired APIs
return an explicit non-cacheable response without signer bindings.
`legacy-anonymous-payment-retry.test.ts` adds three cases for accepted-order
continuation, failed-attempt private recovery, and preventing replacement of an
invoice already awaiting payment. It uses the real payment service and atomic
lifecycle updates against in-memory IndexedDB, with provider responses simulated.

The recovery tests use real local signatures/encryption and the real repository
with in-memory IndexedDB. Provider and relay responses are simulated. Wallet
migration uses an in-memory transactional store. This is not evidence of real
provider settlement, public relay delivery, browser persistence, device recovery,
or production health.

`profile-display-relay-scope.test.ts` checks ordinary display relay selection,
unchanged strict/payment sources and retained profile frontiers with simulated relays.
It does not measure live relay traffic, availability or latency.

## Scope and rebuilding

The larger suite is available in Git at
`d98234133c78075faafd6e6d58e24a0f472ffe33`, before the test reduction. Removed
coverage includes UI/layout, source-shape contracts, general protocol/auth,
catalog, messaging, broad persistence migrations, and additional payment and
recovery scenarios. The retained tests do not provide equivalent coverage.

Keep useful fixtures only when a retained case imports them. Add future cases
from intended behavior and concrete regression risk in the simplified product;
use historical tests to find missed failures, not to reproduce old implementation
structure or meet a coverage percentage. Browser validation belongs on Linux.

Changes affecting signing, payments, recovery, or stored data require a
maintainer-owned validation plan identifying manual/provider/device checks the
suite cannot establish. A passing build or these tests is not release approval.
