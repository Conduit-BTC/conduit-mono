# NIP-17 Inbox Bootstrap Migration (CND-208)

Status: active migration exception. Owner: Conduit maintainers. Started: 2026-08.

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

## The temporary exception

**Validated-order compatibility routing** is a named, bounded, operator-curated lane for
validated kind-16 order-lifecycle traffic during migration. It is not
NIP-17-conformant routing and must not be presented as an extension of NIP-17.
NIP-44/NIP-59 encrypted gift wraps are preserved end to end.

| State                                           | Reads                                                              | Writes                                 |
| ----------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Valid kind 10050                                | Declared inboxes + local secure IN + bounded compatibility overlap | Declared inboxes only                  |
| No usable declaration, validated kind 16 order  | Local secure IN + configured compatibility relays                  | Bounded compatibility order plan       |
| Discovery unavailable, valid cached declaration | Cached declared inboxes + compatibility reads                      | Cached declared inboxes                |
| Signed empty/malformed declaration observed     | Preserve cached reads; show repair                                 | Block; do not override signed state    |
| General kind 14 DM without declaration          | Permissive own-inbox reads; sends stay blocked                     | Block                                  |
| Guest checkout                                  | Merchant order leg may use compatibility                           | No guest inbox/self-copy/reply promise |

Invariants:

- Secure normalized `wss://` targets only.
- A valid current or cached kind `10050` always outranks compatibility.
- A complete authoritative "not declared" read evicts the cached declaration;
  a confirmed-absent declaration never resurrects as a write target.
- The compatibility lane is recipient-only: the non-critical sender self-copy leg
  stays strict and fails soft when the sender has no usable declaration.
- Gift-wrap reads are permissive at the transport layer (inner kinds are not
  separable before decryption); the kind-14 strictness applies to delivery
  writes only. DM surfaces display received messages permissively and gate
  composing/replying on declared readiness.
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
- No automatic signer prompt; no NIP-04 sending.
- Diagnostics and telemetry stay identifier-free and content-free.

## Implementation map

- Typed routing model, declaration cache, read planning, route selection:
  `packages/core/src/protocol/private-message-routing.ts`
- Send-side gating and lane provenance: `packages/core/src/protocol/messaging.ts`
  (`publishPrivateMessage`, `ValidatedOrderRouteScope`, `deliveryRoute`)
- Permissive inbox reads with coverage/source meta:
  `packages/core/src/protocol/commerce.ts` (`meta.inbox`)
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

Track aggregate declared-ready rate, route lane, ACK outcome, read
source/coverage, and missing-order incident count. No identifiers or message
content in any of these aggregates.

## Public references

- NIP-17: https://github.com/nostr-protocol/nips/blob/master/17.md
- NIP-59: https://github.com/nostr-protocol/nips/blob/master/59.md
- NIP-65: https://github.com/nostr-protocol/nips/blob/master/65.md
