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

`commerce-product-selection.test.ts` adds five local selection cases for browse
visibility, exact pickup exceptions, shared family context, revision/deletion
reconciliation and deterministic source merging. These use projected records;
they do not establish signature admission, relay delivery or checkout authority.

`commerce-product-cache.test.ts` adds eight local cache cases using ordinary signed
listings/deletions and Dexie with in-memory IndexedDB. They cover round trips,
revision/provenance retention, failed-save observers, deletion retry/concurrency
and exact-family reads—not public relay delivery or browser cross-tab behavior.

`packages/core/tests/checkout-spark-native-sdk-version.test.ts` guards all three SDK pins and the
real public codec loader, exact native debit, offline-receiver commitment and
unsupported-version refusal. Wallet responses are simulated, not settlement.

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

`packages/core/tests/commerce-product-reads.test.ts` adds eight storefront read
cases for cached filtering and family management, partial live coverage, signed
deletions during relay and cache-write awaits, failure fallback and authority
cancellation. These exercise the retained commerce facade with signed fixtures,
in-memory IndexedDB and network guards; they do not establish public relay or
browser persistence behavior.

`packages/core/tests/commerce-profile-reads.test.ts` exercises profile reads
through the commerce facade using signed kind-0 fixtures, in-memory IndexedDB
and network guards. It covers display-cache expiry and owner refresh, retained
frontiers during refresh and concurrent writes, address removal and malformed
profiles, provisional progress, strict and payment relay completion, exact
signed payment evidence and authority cancellation. These offline cases do not
establish live relay delivery, browser persistence or funded settlement.

`packages/core/tests/commerce-product-detail-reads.test.ts` exercises live and
cached detail lookups through the commerce facade with signed listings and
deletions, in-memory IndexedDB and network guards. It covers references,
variation-family selection, visibility, cached batches, revision/deletion
selection, fallback evidence, transport degradation and revoked-authority error
propagation. Repeated observations of the same signed variation must not make
its family conflict with itself; distinct conflicting variations remain refused.
These display reads and offline tests do not establish checkout availability,
public relay delivery, browser persistence or funded settlement.

`packages/core/tests/commerce-conversation-projections.test.ts` characterizes
conversation reads through the retained commerce facade. Its 38 offline cases
cover participant and role isolation, summary previews and status, deterministic
ordering, direct-message transport separation, unread counts, complete content,
and inbox freshness/degradation metadata. Fixtures and a fake inbox owner avoid
network access; these cases do not establish live delivery or payment settlement.

Ten further `commerce-product-selection.test.ts` cases cover pure live-family
coverage: parent identity, simple products, degraded reads, exact selected
revisions, missing members, newer cached revisions, unrelated families and
source-provenance union. Three facade detail cases characterize absent or older
live parent/child evidence and pass before and after consolidation. These tests preserve
conservative local selection; they do not establish relay completeness or
checkout action authority. An additional exact-batch case checks complete
versus missing-live-sibling coverage through `getProductsByIds`.

`packages/core/tests/commerce-marketplace-reads.test.ts` adds 29 offline cases
through the retained Marketplace facade. Signed fixtures cover empty scopes,
ranked relevance/family projection, cache-seed failure, partial/capped metadata,
authority cancellation, signed deletion/revision observations and serialized
progressive persistence. A final deletion-frontier callback precedes propagation
of a final write failure. Two exact/ranked frontier cases preserve newer signed
cached terms against lagging live revisions without granting fresh action evidence.
Cache admission controls reject forged signatures/identity and rebuild projected
terms from admitted signed bytes. These cases preserve display-read behavior; they do
not establish exact checkout action authority, live relay delivery or settlement.

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
