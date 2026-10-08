# Immutable public-event admission

Public wire and stored signed records enter `protocol/verified-public-event.ts`.
`admitPublicEvent` reports verified, invalid, unavailable, or cancelled;
`verifySignedEvents` admits bounded batches and preserves already-proven candidates
in its unavailable error. The relay reader translates that failure into source
coverage rather than certifying an empty successful read.

The owner snapshots all seven signed fields before yielding, validates the
envelope, and uses the existing full-envelope worker and canonical-ID/Schnorr
engine. Browsers do not fall back to main-thread cryptography after worker
failure. Server execution retains bounded, cancellable chunks. Worker responses
must match the active worker, request, and expected verdict count before admission.

`VerifiedNostrEvent` is opaque and deeply readonly. Its object and every tag are
frozen. Only the admission module can mint process-local runtime membership.
JSON, structured clones, spread copies, NDK flags, and persisted booleans carry no
membership. Parsers check membership at runtime as well as requiring the type.
The exact admitted object can be reused without another cryptographic operation.

The existing proof lookup remains bounded by entries and signed character count.
ID plus signature locates a candidate proof; equality of every signed field is
still required. Live objects retain weak proof after lookup eviction. Queued
requests recheck proof before posting work, so concurrent exact duplicates reuse
completed work. Cancellation belongs to each request; cancelling posted work
restarts the worker without discarding other queued requests.

Source URLs belong to observation evidence outside the frozen event. Every exact
duplicate source is retained. A valid signature proves the signed bytes and
author, not current domain authority, freshness, complete relay coverage, payment,
delivery, or absence of a deletion/revocation.

## Integrated caller inventory

The implementation starts from `994da15b5bce98a1b7ae9570dedfd8d2d3afd503`, with
#606 and #618 integrated. Before freezing callers, overlapping open work was
inspected: #617 and #621 (Event Market), #620, #632, #633 and #527 (catalog/product
work), #608 (shipping), #613 (stock/publication), and #616 (private inbox).
Their unmerged implementations are not dependencies of this boundary. Integrators
must retain the typed admission handoff when replaying their caller changes.

All paths below are under `packages/core/src/protocol` unless an app is named.

| Public consumer                                                                                                                            | Owning ingress and restore                                                                       | Replaced path                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `relay-reader.ts` and HTTP/plain-event adapters                                                                                            | Central batch admission; reader retains socket/control/source ownership                          | Reader-owned queue and cryptographic cache ownership; result-level `eventsVerified`      |
| `products.ts`, `profiles.ts`, `product-event-evidence.ts`, `commerce.ts`                                                                   | Live/progressive read adapters, signed local publication cache, product/tombstone restoration    | Parser-local verification, mutable signed projections, trust inherited by copied objects |
| `event-market.ts`, `event-market-schedule.ts`, `event-market-roster.ts`, `event-market-authorization.ts`, `event-market-merchandise.ts`    | Roster/authorization readers and publishers, calendar retry restoration, Merchant creation retry | Repeated public event crypto and raw parser fallback                                     |
| `event-market-order-evidence.ts`, `future-market-merchandise.ts`, `future-market-handoff.ts`                                               | Async admission of exact embedded public calendar/roster/grant/product bytes before reduction    | Schema-cloned bytes implicitly treated as admitted public evidence                       |
| `shipping.ts`, `shipping-policy.ts`, `merchant-shipping-settings.ts`                                                                       | Public reads and stored option/policy/settings restoration                                       | Public option/policy/deletion verification and `eventsVerified` trust                    |
| `product-deletion.ts`, `product-deletion-delivery.ts`                                                                                      | Signed deletion admission and durable deletion restoration                                       | Repeated public tombstone signature checks                                               |
| `follows.ts`, `shopper-trust.ts`, `profile-search.ts`                                                                                      | Public reader results and retained follow/profile evidence                                       | Function-identity/result-boolean shortcuts and downstream signature checks               |
| `relay-list.ts`, `owner-relay-list-evidence.ts`, `inbox-declaration-evidence.ts`, `private-message-routing.ts`                             | Public NIP-65/NIP-17 declaration admission and raw evidence restore                              | Public declaration verification in reducers and cloned proof                             |
| `account-network-local-state.ts`, `account-network-mutation.ts`, `media-server-preferences.ts`                                             | Async operations restore signed public preferences before authority decisions                    | Stored signed objects and copied state implicitly retaining proof                        |
| Market cart, order pickup retry, server anonymous checkout; Merchant pickup authorization, claim queue, product publication/stock/deletion | Composed async ingress and explicit mutable SDK wire copies                                      | Public parser use of raw copies; admission deferred until after price parsing            |

Legacy prepared cache projections may still supply display data. They carry no
`VerifiedNostrEvent`, cannot outrank an admitted listing, and cannot grant action
authority. A cache row containing signed bytes is readmitted; invalid bytes are
rejected and unavailable verification is reported. Valid product fields are
rebuilt from the admitted event, separately from saved source observations.
Cache transactions compare the exact stored rows after admission and retry a
concurrent change without holding an IndexedDB transaction open during worker I/O.

## Deliberately separate verification owners

This is public admission closure, not removal of NDK or every cryptographic check.
The shared `signed-event.ts` engine no longer creates public proof when called by
another owner. The following still validate their own operation-specific bytes:

- Signer output and publication: NIP-07, NIP-46, session signer, relay publishing,
  account preference publication, product publication/stock retry, Event Market
  publication, media preference publication, and application signer responses.
- Protected transport, AUTH, wrap/seal validation, private order delivery,
  encrypted recovery, enrollment and handoff envelopes.
- Private historical order schemas and shipping quote evidence. Their explicitly
  named internal field parsers run only after that private owner validates its
  embedded signatures; they are omitted from the public protocol barrel.
- Zap request/receipt, payment, wallet/NWC and server-specific authorization owners.

No Nostr identity key custody, signing authority, wallet authority, dependency,
relay default, private envelope protocol, or NIP-44 capability migration is added.

The synchronous private-envelope validator retains at most 4,096 positive
Schnorr verdicts keyed by public key, event ID, and signature. It recomputes the
canonical event hash for every arrival before reusing a verdict. That internal
cache cannot mint `VerifiedNostrEvent` or authorize a public projection. This
keeps repeated durable private-inbox reads bounded without restoring the old
public-proof side effect of synchronous validation.

## Validation and reproduction

- `bun test`: includes genuine signatures, mutation/forgery/clone rejection,
  full-envelope bundled worker, queue/cancellation/source tests, and composed
  catalog, Event Market, shipping, deletion, private-operation regressions.
- `bun scripts/ci/check_public_event_boundary.ts`: TypeScript semantic checks for
  opaque inputs and nested readonly tags; Bun's type erasure cannot satisfy it.
- `tests/public-event-import-contract.test.ts`: guards migrated public parsers
  against direct crypto, boolean trust, and public export of private raw helpers.
- `bun run build`, then `bun scripts/bench/public-event-verification.ts <baseline-directory> <output-directory>`:
  the emitted Market worker plus instrumented browser worker bundles and equal 1k/5k/10k unique and 90%-duplicate workloads.
  Reports cold, warm, concurrent, and JSON-restored arrivals; canonical hash,
  Schnorr and parse counts; clone/equality/snapshot/queue cost; long tasks; memory;
  first rendered fixture text and settlement. The text-paint metric is a synthetic
  proxy, not application catalog-card paint. WebKit does not expose Chromium's
  heap/long-task APIs. Use representative app smoke observations separately.

Benchmarks emit aggregate measurements only. Fixtures are locally generated
public synthetic events. Compare the integrated baseline before claiming a
speedup: that baseline already reuses exact proof. Maintainers must assess
protocol and performance evidence, browser/device gaps, and physical signer QA
before merge or release.

## Measured browser evidence

The [aggregate measurements](./public-event-verification-benchmark.json) contain
all 96 baseline/candidate scenarios: Chromium and WebKit, 1k/5k/10k arrivals,
unique and 90%-duplicate inputs, cold/warm/concurrent/JSON-restored reads. Each
concurrent scenario consumes two copies of the workload. Both versions perform
one canonical hash and Schnorr check per unique cold event, reuse that proof
for concurrent duplicates, and perform zero crypto for warm/restored arrivals.
All browser-main-thread hash and Schnorr counters are zero. Parse counts equal
accepted arrivals, including both concurrent consumers.

Observed settlement times for 10k unique events, milliseconds:

| Browser / source   | Cold | Warm | Concurrent (20k arrivals) | Restore |
| ------------------ | ---: | ---: | ------------------------: | ------: |
| Chromium baseline  | 5086 |  276 |                      5102 |     314 |
| Chromium candidate | 5414 |  238 |                      5617 |     250 |
| WebKit baseline    | 5645 |  198 |                      6838 |     223 |
| WebKit candidate   | 4779 |  155 |                      4853 |     162 |

These are single observations on a shared host, not a speedup claim. Cold and
concurrent wall times vary in both directions. The synthetic harness still has
main-thread parsing/snapshot work: maximum observed Chromium long tasks are
480 ms baseline and 426 ms candidate. Chromium page JS heap after explicit
garbage collection is 14.29–14.31 MB baseline and 14.05–14.58 MB candidate for
10k unique events. This excludes worker heaps and browser process memory.
The coarse `performance.memory` field is retained for transparency but is not
used for the comparison. WebKit does not expose these heap/long-task APIs; its
empty long-task list is unavailable evidence, not proof of no long tasks.
Repeat controlled latency and device profiling for maintainer performance sign-off.

The actual Vite-emitted `verify-worker-DTAquGwR.js` also ran in Chromium and
WebKit. It accepted the genuine fixture and rejected changed content, ID, and
signature. Separate real-signature app smoke covered progressive Market and
Merchant reads, Event Market approval/revision, deletion persistence/restart,
shipping/cart restoration and encrypted order recovery, and mobile WebKit
catalog continuity plus cart history/reload. Synthetic external signer fixtures
exercise cryptography but do not establish physical signer/provider behavior.

Firefox and physical mobile devices were not exercised. No preview, production
relay, live external signer, wallet settlement, or deployment was validated by
these local checks. Protocol and performance sign-off remains maintainer-owned.
The expanded root-test semantic comparison is distinct from normal app/package
typecheck: the frozen baseline has existing root-test typing debt. The focused
compiler contract enforces opaque parser inputs and immutable fields directly.
React Doctor reports four deliberate sequential/bounded admission loops and the
existing large organizer claim component; those warnings are retained rather
than replacing bounded verification with unbounded concurrency or widening UI scope.

## Durable evidence during verification outages

An unavailable or cancelled admission is inconclusive. Owner relay-list
reconciliation, NIP-17 inbox declaration reads/merges, and media-preference
restoration preserve the exact stored
signed records, pending retry plans and delivery outcomes without writing a
replacement checkpoint. A cold read reports verification unavailability;
media display data is separately sanitized and supplies no signed frontier or
action authority until admission recovers. Conclusively invalid signed bytes
remain eligible for removal or repair through the existing reconciliation rules.
Inbox verification unavailability propagates through retained reads and aborts
merges before writes. Routing reports unavailable rather than declaration absence
and cannot create candidate-only process fallback over an unverified durable
frontier.

Account Network staging admits raw signed checkpoints before opening an
IndexedDB transaction. Invalid or unavailable admission cannot write durable
state. Account Network transactions use the latest delivery and source metadata read
inside the transaction. Only the separately admitted event objects are reused,
after comparing every retained signed event's exact bytes, including the
last-usable frontier. Concurrent acknowledgements and staging therefore retain
all prior outcomes and source observations without performing crypto inside an
IndexedDB transaction. `tests/public-evidence-storage-regression.test.ts`
exercises these paths with real signatures, cold worker outages and concurrent
IndexedDB writes.
