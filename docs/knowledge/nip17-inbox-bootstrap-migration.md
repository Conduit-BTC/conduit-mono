# NIP-17 Inbox Bootstrap Migration (CND-208)

Status: active migration exception; preview and staging enabled as of
2026-08-21, production disabled pending the reviewed synthetic staging smoke.
Owner: Conduit release maintainer. Started: 2026-08. Next review: 2026-09-09
and before production activation.

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

| State                                                          | Reads                                                                   | Writes                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------- |
| `declared` current frontier                                    | Declared inboxes + local secure IN + bounded compatibility overlap      | Declared inboxes only                  |
| `not_observed`, validated kind 16 order                        | Local secure IN + configured compatibility relays                       | Bounded compatibility order plan       |
| Retained `declared`; latest observation partial or unavailable | Retained last-usable inboxes + compatibility reads; show degraded state | Retained declared inboxes only         |
| `signed_empty` current frontier                                | Retained last-usable inboxes may support recovery reads                 | Block; do not override signed state    |
| `malformed` current frontier                                   | Retained last-usable inboxes may support recovery reads; show ambiguity | Block; never infer user opt-out        |
| General kind 14 DM without a current declaration               | Permissive own-inbox reads; sends stay blocked                          | Block                                  |
| Guest checkout                                                 | Merchant order leg may use compatibility                                | No guest inbox/self-copy/reply promise |

Invariants:

- Secure normalized `wss://` targets only.
- The exact validated signed kind `10050` event and its source-relay
  observations are stored durably per account. Invalid signature, id, kind, or
  author evidence is rejected before merge.
- The NIP-01 frontier is deterministic: greater `created_at` wins; when
  timestamps tie, the lexicographically smaller event id wins. Observing the
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
- Relay-settings changes expire evidence freshness and trigger rediscovery; they
  do not delete the account-scoped frontier or its last-usable relay set.
- Only an exact-event observation from a completed bounded relay plan advances
  durable complete-plan freshness. Partial or unavailable fanout remains
  degraded after restart even when one relay returned the current event. The
  latest empty, incomplete, unavailable, or conflicting lookup is retained
  separately from the signed frontier.
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
- Arbitrary NIP-65, local IN/OUT, product source/provenance, NIP-89 and `p`-tag
  hints, wrapper sources, commerce-priority, and other public relays are
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
partial, unavailable, or conflicting lookup, remains retry-only because it
cannot establish which frontier the omitted sources hold.

This convergence work does not widen compatibility to general DMs, arbitrary
relays, plaintext delivery, or unvalidated sender/recipient relationships. The
bounded rollout counters below are implemented, but field evidence and the
required staging smoke still keep the compatibility lane out of production.

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
- Network-owned readiness/repair: `packages/core/src/hooks/useInboxDeclaration.ts`,
  `packages/ui/src/components/PrivateInboxSection.tsx`, both `network.tsx` routes
- Order provenance: `orderLifecycles.orderDeliveryRoute`
  (`declared_inbox` | `compatibility_order`), with the exact encrypted wrap and
  per-relay outcomes in `orderLifecycles.orderRelayDelivery`
- Public build policy: `deploy/pages-profiles.json`. Preview and staging enable
  the lane; production remains independently false until the reviewed smoke
  gate passes. Vite compiles the legacy `VITE_DM_BOOTSTRAP_WRITES` input from
  that profile rather than trusting a Cloudflare dashboard override.
- QA manifest: `/.well-known/conduit-deployment.json` exposes only app/profile,
  source commit/branch, build time, public feature values, and their SHA-256
  digest.

## Delivery examples

- Valid kind `10050`: `declared_inbox -> [declared-a, declared-b]`. No
  compatibility relay is added.
- Complete-empty or partial rediscovery after a valid declaration: the retained
  frontier becomes stale/degraded but remains the declared route; it is not
  deleted.
- Newer signed empty or malformed frontier: writes stay blocked while prior
  last-usable relays remain eligible only for the owner's recovery reads.
- Network repair: the exact signed declaration is published to the bounded
  shared discovery set and is not shown as cross-client confirmed until one of
  those shared sources returns that event.
- Shared complete-empty repair: a retained declaration may be redistributed
  as the exact same signed event to the shared set; a partial, unavailable, or
  conflicting view only offers retry.
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
all part of this narrow rollout slice: CND-219 adds declaration class, route,
ACK, repair discoverability, and block-reason counters; broader read-source and
incident measurement remains with CND-210. The removal gate is therefore not
yet measurable and the lane must not be activated in production on the strength
of this document alone. No identifiers or message content may enter these
aggregates.

## Activation and rollback

- Staging activation date: 2026-08-21. Production activation: not yet active.
- Manual gate: dedicated synthetic buyer and merchant identities must prove one
  declared-inbox receipt and one compatibility-route receipt in staging. The
  deployed manifest must report the staging profile and compatibility enabled.
- Observation window: the first 24 hours after each environment activation,
  using only the fixed-label aggregate event documented in
  `docs/analytics/events.md`.
- Rollback owner: the Conduit release maintainer performing the activation.
- Rollback trigger: any strict declaration routed through compatibility, any
  kind-14 or unvalidated write reaching compatibility, any plaintext exposure,
  or failure of either synthetic receipt. After production activation, also
  roll back if the 24-hour zero-ACK share is at least twice the staging baseline
  with at least 20 eligible delivery attempts.
- Rollback action: change only
  `profiles.<environment>.publicFeatures.dmCompatibilityOrderRoutingEnabled` to
  `false`, rebuild, and verify the public deployment manifest. No dashboard
  checkbox or relay-list edit is an activation or rollback mechanism.

## Public references

- NIP-17: https://github.com/nostr-protocol/nips/blob/master/17.md
- NIP-59: https://github.com/nostr-protocol/nips/blob/master/59.md
- NIP-65: https://github.com/nostr-protocol/nips/blob/master/65.md
