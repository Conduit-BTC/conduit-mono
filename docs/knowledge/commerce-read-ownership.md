# Commerce read ownership

Application callers use the stable commerce facade. Its exports and query/result
types remain the compatibility surface; read workflows and pure projections live
with their record/cache policy instead of acquiring logic in routes.

| Owner                                  | Responsibility                                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commerce-product-selection.ts`        | Pure listing/family projection, exact-target context, selected revision/source merging and positive live family coverage. No relay or storage operations.                                            |
| `commerce-product-cache.ts`            | Signed product/deletion cache admission, durable revision/deletion retention and local observers.                                                                                                    |
| `commerce-product-reads.ts`            | Storefront, detail, cached batches, Marketplace browse/progressive reads and ranked search projection. Uses existing cache/selection owners and facade-injected transport/exact-refresh composition. |
| `commerce-profile-reads.ts`            | Profile-batch workflow, retained profile frontiers, contextual relay planning and freshness/persistence evidence.                                                                                    |
| `commerce-conversation-projections.ts` | Pure buyer, merchant and direct-message summaries from already parsed messages. No signing, inbox refresh or persistence.                                                                            |
| `commerce.ts`                          | Public contracts, capability metadata, transport/planner composition, exact availability orchestration and existing protected inbox/recovery entry points.                                           |

## Composition invariants

Browse/cache paint is display evidence. Exact checkout availability still uses
positive selected live evidence and its typed coverage/diagnostics; moving a
read does not upgrade cached or partial evidence into action authority.

Exact cached rows pass the shared signed-byte admission boundary before family
discovery or revision comparison. Stored projection fields are display data;
invalid signed identities are discarded, and admitted bytes rebuild the terms.
A newer cached revision remains stale until that selected revision is observed
live; an older relay response cannot authorize it.

Catalog and progressive reads retain their existing per-call cache snapshot.
This extraction introduces no continuously live cache-revision stream. Local
deletion frontiers are reapplied after awaited work, while exact action authority
remains a separate read.

The product reader receives the existing clock and transport callbacks. Ranked
search keeps one relevance response and passes its verified records into the
exact refresh even if the initial cache write fails. Progressive persistence
remains serialized, and deletion-frontier reconciliation precedes final failure
propagation. Account changes and cancellation remain admission boundaries.

Private inbox ownership, signer leases, encrypted historical readers, recovery
witness/source checks and persisted uncertain attempts remain with their
existing owners. This read cleanup changes no stored schema, record retention,
provider execution or reconciliation authority. See
[Checkout router cleanup boundary](checkout-router-cleanup-boundary.md).

## Validation scope

The retained facade tests use signed fixtures, local storage substitutes and
network guards. They characterize metadata, cancellation and monotonic record
selection around the moves. They do not establish public relay completeness,
performance, browser persistence or funded settlement. The current retained
coverage and its limits are listed in [tests/README.md](../../tests/README.md).
