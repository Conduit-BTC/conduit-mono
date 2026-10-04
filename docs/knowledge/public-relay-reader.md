# Public relay read ownership

`protocol/relay-reader.ts` owns public WebSockets, subscriptions, signature
verification, fanout, cancellation and connection lifetime. Public events are
plain signed Nostr wire objects. No public reader constructs an NDK event or
uses an NDK pool. Wire input is copied to the seven canonical signed fields;
unsigned extra fields are ignored without rejecting an otherwise valid event.
Provenance is held separately by object identity and attached only after an
actual verified delivery. Standalone verification snapshots canonical fields
and nested tags before asynchronous work, retaining only locally attached
provenance. Cold and cached verification return that detached snapshot.
The protected executor keeps its account-authenticated sockets
in a separate pool; public reads never send AUTH or borrow those connections.

## Result and operation policy

`fetchSignedEventsFanoutDetailed` returns verified deduplicated events plus
`eventSourceRelayUrls`, preserving all observed sources for duplicate ids.
`requestedRelayUrls` records caller candidates, `admittedRelayUrls` records final
policy-admitted attempts, and `attemptedRelayUrls` records transport attempts.
Throttled candidates remain visible in source outcomes without consuming an
attempt budget. Source policy is checked after the bounded execution queue and
before opening a socket. Whole-relay exclusions and owner-selected insecure
transport authority remain account scoped.

Each source `eventCount` counts distinct verified ids; `duplicateEventCount`
retains copy observations. Source counts and limit diagnostics therefore agree
for declaration, follow and shipping callers. Each source reports EOSE, CLOSED, authentication required, rejection, throttling,
disconnect, connect/query timeout, resource exhaustion, malformed evidence or
verification failure. Rejected signatures and malformed input make coverage
partial even if the relay sent EOSE. Missing/falsy EVENT payloads are still
counted as malformed frames; non-matching events remain unusable evidence.
Verified duplicate copies do not consume a distinct-event filter limit. A progress snapshot is provisional; only a
terminal observation can describe a completed bounded plan. `globalAbsence`
always remains false. Freshness timestamps describe this observation; domain
owners retain stale, malformed, deleted and conflicting prior evidence.

Cancellation still rejects with `AbortError`, so existing query cancellation
continues to stop domain/cache updates. `PublicRelayReadCancelledError.result`
retains already verified events, completed sources and cancelled in-flight
sources. Queued work cannot open a socket after cancellation.

The public executor owns cancellation for every read until it settles.
`closeAll()` and `dispose()` revoke planning, queued and active public reads
before closing their scoped sockets. Teardown leaves sibling executors alone;
a fresh read after `closeAll()` may create a new pool. Both query results and
observation streams retain cancellation evidence.

The shared reader tracks each operation from planning through verification and
asynchronous progress callbacks, independently of the eight execution slots.
An idle settings refresh waits for those operations to settle before retiring
their pools. Already-started asynchronous caller callbacks are cooperative;
retirement closes sockets and cancels queued work immediately, while read
settlement waits for those callbacks, including when another source rejects. A
callback failure cancels sibling I/O and retains its original error after all
started attempts drain. Explicit scoped or global retirement cancels owned operations
before removing their pools, so pending work cannot open a detached socket.

The generic public executor projects source URLs back to their stable requested
relay indices and emits verified event/duplicate and malformed/unusable counts
as each source finishes. Connection timeouts keep their connect phase. The
strict Event Market gift-wrap scan uses the protected inbox reader with bounded
`since`/`until` pagination; its account authority, declared targets, timestamp
boundary checks and partial-coverage policy remain separate from public reads.

Events-only and diagnostic projections, and per-source progressive callbacks,
all use the same detailed executor. Catalog discovery remains progressive;
replacement-sensitive reads retain explicit plans and frontier/deletion policy.
This transport migration does not redesign catalog assembly or cache state.
The [compatibility audit ledger](./public-relay-reader-contract-audit.md) maps
these guarantees to hostile-input and scheduling-barrier proofs.

Bounds remain eight concurrent reads, 128 queued reads, bounded inbound frames
and bytes, 512 new signature checks per source, a bounded verification proof
cache, worker backpressure with cooperative fallback, explicit subscription
CLOSE and a 20-second idle socket lifetime. Non-reused sockets close at the end
of the operation.

## Caller and deletion checklist

| Consumer                                                  | Shared policy owner                       | Read migration                                                                                       |
| --------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Profile batch, profile search                             | Commerce/profile search and relay planner | Plain events and explicit source outcomes                                                            |
| Follows and merchant trust                                | Follow frontier and declaration planning  | Existing plain follow API uses the finished reader                                                   |
| Social hydration and shopper evidence                     | Social/trust helpers                      | Public filter and plain signed-event types                                                           |
| NIP-65 owner and general declarations                     | Relay list and owner evidence             | Plain read events; retained signed frontier preserved                                                |
| Public kind-10050 discovery                               | Private message routing                   | Plain public declaration reads; protected inbox remains separate                                     |
| Media preferences and Account Network readback            | Existing operation owners                 | Finished reader, no wrapping adapter                                                                 |
| Products, storefronts, exact revisions and deletion reads | Commerce gateway and planner              | Plain events through existing catalog assembly                                                       |
| Shipping and shipping deletions                           | Shipping frontier                         | Plain events through existing retained authority checks                                              |
| Event calendars, collections, roster and merchandise      | Event Market frontier owners              | Plain filters/events through existing exact-read budgets                                             |
| Zap receipt discovery and authority endpoints             | Lightning and public authority helpers    | Plain receipts and explicit relay plans                                                              |
| Generic public executor facade                            | Public reader                             | Compatibility result projects the same public read; authenticated executor retains private ownership |
| Public product inspection script                          | Public reader                             | Direct NDK fetch removed                                                                             |

Deleted paths: the NDK public fanout exports and wire implementation, public
NDKFilter read types, public NDKEvent wrapping, and the plain-to-NDK-to-plain
adapter. Test seams and app/server consumers follow the same plain APIs.

The signed-event writer owns public publishing. NDK remains for existing
private envelope/decrypt compatibility, construction helpers and publishing
scripts. Those belong to private envelope and final SDK cleanup work. Local
publication cache inputs still accept existing publisher objects structurally;
relay read outputs never require them. Protected scan results retain their
plain signed wraps directly so private receipt authority can survive reload.

## Validation boundary

Deterministic wire fixtures cover EOSE, delayed/no EOSE, CLOSED, public AUTH
challenge/refusal, disconnect, malformed events, invalid hash/signature,
duplicate sources, queued cancellation and verifier backpressure. The
executor regressions cover teardown before planning, nine-source queue
saturation, sibling isolation, observation-stream closure and subsequent reuse.
Composed planner, follow/frontier and deletion tests guard evidence-sensitive callers.
Browser fixtures exercise catalog useful paint and profile/declaration Network
reads, recording only counts, event kinds and timings. Equal-topology baseline
comparison is required before making a performance claim. Fixtures do not prove
real external signer/device behavior, protected relay enforcement, global
coverage, payment settlement or production operation.

Protected inbox execution applies the same signed-field boundary: verified
outputs contain only the seven NIP-01 fields with detached tags. Unsigned wire
padding cannot enter authenticated handoff evidence or consume its recovery
storage budget. The composed regression uses local encrypted gift wraps and
signer-backed storage recovery; it does not establish live relay or device
interoperability.

Independent filters retain independent distinct-event limits, including zero
and mixed bounded/unbounded requests; the output is their selected union.
Per-source progress arrays are unique just like terminal arrays. Duplicate
counts remain separate observations, including selected copies delivered after
the filter fills. Domain cap checks therefore see signed revisions, not copies.

Operation ownership includes the actual shared or private socket pool. Explicit
retirement closes both before cooperative callbacks settle, and a reentrant
socket factory cannot register a connection into a retired pool. Read-only
policy-storage awaits are cancellable during planning and final admission, so
retired reads release execution slots even if storage has not returned. An
already-started storage promise may finish internally, but cannot initiate I/O.
Live session authority is checked before progress and final return; connection
observer exceptions preserve caller error identity without recording a relay
outage. These rules do not change the separate policy that an already-admitted
relay may finish after another tab changes a whole-relay exclusion.
