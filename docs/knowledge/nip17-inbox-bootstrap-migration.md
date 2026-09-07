# NIP-17 Inbox Bootstrap Migration (CND-208)

Status: active migration exception; preview enabled, production and staging
disabled. Owner: Conduit maintainers. Started: 2026-08. Next review: 2026-09-09
and before any production activation.

## Why this exists

Strict kind `10050` routing became an availability gate before users had a
Network-owned setup and repair path. Merchants with working relay setups but no
discoverable declaration stopped receiving orders, and clients collapsed failed
or partial declaration lookups into "No declaration". The protocol direction
(NIP-17 exclusive delivery through kind `10050`) is correct; the migration and
failure-state handling were incomplete.

## Canonical behavior

A valid kind `10050` declaration is the preferred and eventual exclusive
delivery route. Network settings own declaration setup and repair; Messages and
Orders link there and never publish declarations themselves. Declaration
evidence is durable and account-scoped so a restart, relay omission, or relay
settings change cannot silently erase a previously validated signed event.

The principal's own compatibility/declared inbox read is an explicitly
protected operation when the client is signed in. It uses the NDK-neutral
NIP-42 executor and only `kind:1059`, `#p: [<active account>]` filters. Public
declaration discovery and other public relay reads carry no NIP-42 account proof
and never prompt a signer. That is not network anonymity: queried relays still
see request filters, and relays, hosts, and transport providers may observe
ordinary connection metadata. NIP-07 and NIP-46 account sessions are eligible;
guest checkout has no inbox auth, self-copy, or reply fallback. The exact
contract is in `docs/knowledge/nip42-protected-read-rollout.md`.

## The temporary exception

**Validated-order compatibility routing** is a named, bounded, operator-curated lane for
validated kind-16 order-lifecycle traffic during migration. It is not
NIP-17-conformant routing and must not be presented as an extension of NIP-17.
NIP-44/NIP-59 encrypted gift wraps are preserved end to end.

| State                                                            | Reads                                                                                   | Writes                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| `declared` current frontier                                      | Declared inboxes + bounded compatibility reads                                          | Declared inboxes only                  |
| Fully signed/staged ordinary pending declaration                 | Pending inboxes + hidden previous inboxes through exact readback and stale-sender grace | Pending inboxes only                   |
| Fully signed/staged pending declaration with whole-setup removal | Pending inboxes; removed URL excluded immediately                                       | Pending inboxes; removed URL excluded  |
| `not_observed`, validated kind 16 order                          | Active bounded legacy migration recovery + configured compatibility relays              | Bounded compatibility order plan       |
| Retained `declared`; latest observation partial or unavailable   | Retained last-usable inboxes + compatibility reads; show degraded state                 | Retained declared inboxes only         |
| `signed_empty` current frontier                                  | Retained last-usable inboxes may support recovery reads                                 | Block; do not override signed state    |
| `malformed` current frontier                                     | Retained last-usable inboxes may support recovery reads; show ambiguity                 | Block; never infer user opt-out        |
| General kind 14 DM without a current declaration                 | Permissive own-inbox reads; sends stay blocked                                          | Block                                  |
| Guest checkout                                                   | Merchant order leg may use compatibility                                                | No guest inbox/self-copy/reply promise |

Invariants:

- Secure normalized `wss://` targets only.
- The exact validated signed kind `10050` event and its source-relay
  observations are stored durably per account. Invalid signature, id, kind, or
  author evidence is rejected before merge.
- The NIP-01 frontier is deterministic: greater `created_at` wins; when
  timestamps tie, the lexicographically lowest event id wins. Observing the
  same event from another source unions provenance without changing its
  identity.
- `declared`, `signed_empty`, and `malformed` are distinct signed frontier
  states. `signed_empty` has zero `relay` tags; `malformed` has declaration data
  that cannot be interpreted safely, including an all-invalid relay-tag set.
  `not_observed`, `lookup_partial`, and `lookup_unavailable` describe bounded
  observation coverage rather than signed user intent.
- A complete-empty, partial, or unavailable lookup never erases stronger
  retained evidence. If a signed frontier is retained, the observation marks it
  stale or degraded; `not_observed` is returned only when a complete bounded
  plan finds no event and no signed frontier exists.
- A current `declared` frontier outranks compatibility. A newer `signed_empty`
  or `malformed` frontier blocks writes and compatibility, while the prior
  last-usable relays remain read-only recovery evidence.
- An unsigned draft, cancelled signer sequence, or missing required signature
  changes no route and removes no existing recovery behavior. After all events
  required by an ordinary Network update are signed and durably staged, new
  gift-wrap writes use the pending declaration. Previous valid inboxes remain a
  hidden read-only recovery lane until exact pending-event readback from the
  bounded shared discovery set and expiry of a bounded, versioned stale-sender
  grace period. They are not current membership and never authorize writes.
- A relay explicitly removed from the user's whole setup is excluded from every
  active read and write immediately after all required signatures are staged,
  before ACK or readback. The proceed/cancel warning states that stale clients
  may still send there and those messages can be missed.
- Legacy NIP-65 draft import begins only after complete bounded discovery
  establishes scoped absence for `kind:10002`; valid signed NIP-65 suppresses
  that import. Capturing bounded read-only secure-IN recovery is independent and
  occurs even when signed `kind:10002` exists. Migration persists and verifies
  every eligible replacement record before retiring legacy keys. Incomplete
  migration retains or recovers the prior read path and remains retryable;
  partial new records are not authority. The recovery lane never writes or
  publishes and ends only after a usable `kind:10050` replacement with one to
  three secure relays is fully signed and durably staged, or after explicit
  discard recorded by a durable local migration tombstone.
- Relay-settings changes expire evidence freshness and trigger rediscovery; they
  do not delete the account-scoped frontier or its last-usable relay set.
- Only an exact-event observation from a completed bounded relay plan advances
  durable complete-plan freshness. Partial or unavailable fanout remains
  degraded after restart even when one relay returned the current event. The
  latest empty, incomplete, or unavailable lookup is retained separately from
  the signed frontier. Current valid inputs cannot produce a conflict; that
  outcome is reserved to fail closed only if a future richer evidence model can
  validate an internal inconsistency after canonical ordering.
- The compatibility lane is recipient-only: the non-critical sender self-copy leg
  stays strict and fails soft when the sender has no usable declaration.
- Gift-wrap reads are permissive at the transport layer (inner kinds are not
  separable before decryption); the kind-14 strictness applies to delivery
  writes only. DM surfaces display received messages permissively and gate
  composing/replying on declared readiness.
- Protected read filters remain recipient-strict: every outer filter is limited
  to kind `1059` and the active principal's `#p`. Permissive here means the
  client reads that principal's wraps across the bounded source union, not that
  it may request another recipient or broader event kinds.
- Compatibility eligibility is the secure normalized intersection of
  `config.dmCompatibilityOrderRelayUrls` and the bounded compatibility inbox
  read set. Eligible write targets are reserved ahead of optional local/public
  read sources inside the read fanout, so Conduit clients poll every target.
- Recipient signed NIP-65 read relays may move matching eligible relays to the
  front. They never add a relay. Remaining entries keep registry order; URLs
  are normalized/deduplicated and the result is capped at three.
- Arbitrary NIP-65, legacy local settings, product source/provenance, NIP-89 and
  `p`-tag hints, wrapper sources, commerce evidence, and other public relays are
  explicitly ineligible.
- Kind `10002` never becomes a declared gift-wrap write fallback. Within the
  compatibility exception it may only rank relays already present in the
  operator-approved registry; it cannot add a target.
- Compatibility requires a one-use validated kind-16 order scope bound to the
  rumor id, order id, sender, and recipient; kind 14 stays strict-only.
- The same signed recipient wrap is attempted on the whole plan. Relay ACK is
  relay acceptance, not recipient receipt/read. At least one ACK is successful
  delivery; failed targets remain content-free retry state. Zero ACKs is an
  explicit failure and never becomes sent/delivered.
- Declared kind `10050` delivery remains exclusive but is capped at the first
  three secure normalized tags, preserving signed tag order and surfacing
  truncation instead of allowing an unbounded recipient-controlled fanout.
- Capability scans and public reads never prompt a signer. An explicit
  signed-in protected inbox read may answer a relay challenge through the
  active NIP-07 or NIP-46 signer. There is no guest auth and no NIP-04 sending.
- Diagnostics and telemetry stay identifier-free and content-free.
- Shared acceleration, cache, index, and routing systems derive only from
  relay-visible state. They never expose hidden APIs for private message content
  or ciphertext, order contents, payment or invoice data, signer or auth
  material, wallet credentials or recovery material, or wallet balances.
- A successful relay result plus an auth/transport failure is partial. All
  failures are unavailable, not empty. Cached messages remain visible as
  stale/degraded; only successful EOSE from every required relay in the bounded
  plan authorizes a terminal empty state.

## Durable declaration convergence

Declaration publish and discovery share a bounded, normalized relay plan that
unrelated Conduit clients can reproduce. The owner may add bounded local
distribution relays, but shared discovery targets are reserved independently of
owner-local settings. Network repair is confirmed only after the exact signed
event is observed from the shared discovery set and that source observation is
merged into durable evidence. A process-memory prime, the local durable row, or
readback from only an owner-selected relay cannot establish cross-client
discoverability. If the shared plan completes without seeing any declaration,
Network may offer explicit redistribution of the unchanged retained event to
the same set only when that retained current frontier is `declared`.
Redistribution republishes the exact signed bytes and never mints a newer
replaceable event; a bounded empty view cannot prove that a newer frontier does
not exist elsewhere. Retained `signed_empty` or `malformed` evidence, plus any
partial or unavailable lookup, remains retry-only because it cannot establish
which frontier the omitted sources hold. A future reserved fail-closed conflict
has the same retry-only behavior if richer validated evidence can establish an
internal inconsistency after canonical ordering.

This convergence work does not widen compatibility to general DMs, arbitrary
relays, plaintext delivery, or unvalidated sender/recipient relationships. The
compatibility-lane removal metrics below remain unimplemented and keep that lane
out of production.

Relay-side recipient auth enforcement remains client-first rollout work and is
not implied by this document. NIP-11 advertisement alone is not proof that a
relay has challenged, accepted auth, or enforced `#p` authorization.

## Implementation map

- Durable account-scoped event evidence and monotonic merge:
  `packages/core/src/protocol/inbox-declaration-evidence.ts` and the shared
  Dexie database
- Typed routing model, discovery/read planning, and route selection:
  `packages/core/src/protocol/private-message-routing.ts`
- Send-side gating and lane provenance: `packages/core/src/protocol/messaging.ts`
  (`publishPrivateMessage`, `ValidatedOrderRouteScope`, `deliveryRoute`)
- Permissive inbox reads with coverage/source meta:
  `packages/core/src/protocol/commerce.ts` (`meta.inbox`)
- Protected relay execution, signer edge, and auth evidence:
  `packages/core/src/protocol/` (the NDK-neutral executor and explicit
  protected-inbox composition boundary). NDK remains only at named signer and
  gift-unwrap edges; exact file names follow the implementation slice.
- Network-owned readiness, repair, pending cutover, and migration recovery: one
  shared core/UI Network feature rendered by thin Market and Merchant
  `network.tsx` route shells. The existing declaration hook and separate inbox
  section are adapted or retired as that shared feature lands.
- Order provenance: `orderLifecycles.orderDeliveryRoute`
  (`declared_inbox` | `compatibility_order`), with the exact encrypted wrap and
  per-relay outcomes in `orderLifecycles.orderRelayDelivery`
- Public build policy: `deploy/pages-profiles.json`. Preview enables the lane;
  production and staging are independently false by default. Vite compiles the
  legacy `VITE_DM_BOOTSTRAP_WRITES` input from that profile rather than trusting
  a Cloudflare dashboard override.
- QA manifest: `/.well-known/conduit-deployment.json` exposes only app/profile,
  source commit/branch, build time, public feature values, and their SHA-256
  digest.

## Delivery examples

- Valid kind `10050`: `declared_inbox -> [declared-a, declared-b]`. No
  compatibility relay is added.
- Ordinary signed/staged update from `[declared-a]` to `[declared-b]`: writes use
  `declared-b`; reads retain `declared-a` invisibly until exact shared-set
  readback and stale-sender grace expiry.
- Whole-setup removal of `declared-a`: after every required signature is staged,
  no read or write uses `declared-a`, even while ACK/readback is pending. The
  warning explains that stale-client sends there can be missed.
- Legacy local migration when signed NIP-65 already exists: suppress draft
  import, persist and verify the bounded read-only inbox-recovery record, then
  retire the old key. Signer cancellation or an unrelated NIP-65 update keeps
  recovery reads; no legacy relay becomes a write target. Only a usable, fully
  signed and durably staged kind `10050` replacement or explicit discard with a
  durable migration tombstone ends that recovery.
- Complete-empty or partial rediscovery after a valid declaration: the retained
  frontier becomes stale/degraded but remains the declared route; it is not
  deleted.
- Newer signed empty or malformed frontier: writes stay blocked while prior
  last-usable relays remain eligible only for the owner's recovery reads.
- Network repair: the exact signed declaration is published to the bounded
  shared discovery set and is not shown as cross-client confirmed until one of
  those shared sources returns that event.
- Shared complete-empty repair: a retained declaration may be redistributed
  as the exact same signed event to the shared set; a partial or unavailable
  view only offers retry. Any future reserved fail-closed conflict also offers
  retry only.
- No declaration, recipient NIP-65 reads one approved relay:
  `compatibility_order -> [approved-recipient-match, conduit, approved-inbox]`
  (maximum three). An arbitrary NIP-65 relay is ignored.
- Partial outage: the same wrap is attempted on all three; one ACK plus two
  timeout/reject outcomes is successful and the two non-ACKed entries remain
  retryable for the active signed-in buyer.
- Complete failure: zero ACKs throws delivery diagnostics and checkout cannot
  move to payment or claim the order was sent.

## Removal gate

The lane is removed by an explicit maintainer PR (no silent expiry) after:

- > = 99% of active merchants declared-ready for 28 consecutive days.
- Bootstrap lane below 0.1% of order attempts for 28 days.
- Zero confirmed fallback-only receipts for 14 days.
- Zero declaration-related missing-order incidents across two supported
  releases.

Required aggregate measurements are declared-ready rate, route lane, ACK
outcome, read source/coverage, and missing-order incident count. They are not
yet implemented, so the removal gate is not measurable and the lane must not be
activated in production on the strength of this document alone. No identifiers
or message content may enter these aggregates.

## Public references

- NIP-17: https://github.com/nostr-protocol/nips/blob/master/17.md
- NIP-59: https://github.com/nostr-protocol/nips/blob/master/59.md
- NIP-65: https://github.com/nostr-protocol/nips/blob/master/65.md
