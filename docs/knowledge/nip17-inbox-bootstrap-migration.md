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
Orders link there and never publish declarations themselves.

The principal's own compatibility/declared inbox read is an explicitly
protected operation when the client is signed in. It uses the NDK-neutral
NIP-42 executor and only `kind:1059`, `#p: [<active account>]` filters. Public
declaration discovery and other public relay reads remain anonymous. NIP-07 and
NIP-46 account sessions are eligible; guest checkout has no inbox auth,
self-copy, or reply fallback. The exact contract is in
`docs/knowledge/nip42-protected-read-rollout.md`.

## The temporary exception

**Validated-order compatibility routing** is a named, bounded, operator-curated lane for
validated kind-16 order-lifecycle traffic during migration. It is not
NIP-17-conformant routing and must not be presented as an extension of NIP-17.
NIP-44/NIP-59 encrypted gift wraps are preserved end to end.

| State                                           | Reads                                                              | Writes                                  |
| ----------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| Valid kind 10050                                | Declared inboxes + local secure IN + bounded compatibility overlap | Declared inboxes only                   |
| No usable declaration, validated kind 16 order  | Local secure IN + configured compatibility relays                  | Bounded compatibility order plan        |
| Discovery unavailable, valid cached declaration | Cached declared inboxes + compatibility reads                      | Cached declared inboxes                 |
| Valid signed empty declaration observed         | Preserve cached reads; show explicit no-inbox state                | Block; do not override signed state     |
| Malformed declaration observed                  | Preserve cached reads; show repair and ambiguity                   | Currently blocked pending safety review |
| General kind 14 DM without declaration          | Permissive own-inbox reads; sends stay blocked                     | Block                                   |
| Guest checkout                                  | Merchant order leg may use compatibility                           | No guest inbox/self-copy/reply promise  |

Invariants:

- Secure normalized `wss://` targets only.
- A valid current or retained cached kind `10050` outranks compatibility unless
  stronger valid signed evidence supersedes it, including a newer signed empty
  replacement.
- A bounded discovery plan that completes without an event currently returns
  `not_declared` for route selection. This is scoped observation, not proof of
  global Nostr absence. Relay omission must not be described as a signed opt-out
  or revocation.
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

## Known doctrine gaps in the preview implementation

This exception documents current behavior; it is not evidence that the preview
implementation already satisfies every rule in
`docs/knowledge/decentralized-network-product-posture.md`.

- A bounded complete-but-empty lookup currently evicts the process-local cached
  declaration and the protected messaging contract calls that result
  authoritative absence. The observation is scoped, and omission must not erase
  previously validated signed evidence. The implementation and protected
  contract need an explicit follow-up change.
- Declaration evidence is held in memory, so it does not survive restart and is
  discarded on some relay-settings changes.
- Valid signed empty state and an unparseable declaration share a route today.
  They need distinct evidence states. Blocking malformed recipient routing may
  remain the privacy-safe decision, but it must not be described as user opt-out.
- Owner readback does not yet prove that an unrelated sender can discover the
  repaired declaration across the bounded shared discovery plan.
- The removal metrics below are not implemented.
- Relay-side recipient auth enforcement is client-first rollout work and is not
  implied by this document. NIP-11 advertisement alone is not proof that a
  relay has challenged, accepted auth, or enforced `#p` authorization.

These gaps keep the compatibility lane out of production. Correcting them must
not widen compatibility to general DMs, arbitrary relays, plaintext delivery,
or unvalidated sender/recipient relationships.

## Implementation map

- Typed routing model, declaration cache, read planning, route selection:
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
