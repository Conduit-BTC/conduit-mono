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

## The temporary exception

**Validated-order compatibility routing** is a named, bounded, operator-curated lane for
validated kind-16 order-lifecycle traffic during migration. It is not
NIP-17-conformant routing and must not be presented as an extension of NIP-17.
NIP-44/NIP-59 encrypted gift wraps are preserved end to end.

| State                                               | Reads                                                              | Writes                                  |
| --------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| Valid kind 10050                                    | Declared inboxes + local secure IN + bounded compatibility overlap | Declared inboxes only                   |
| No usable declaration, validated kind 16 order      | Local secure IN + configured compatibility relays                  | Bounded compatibility order plan        |
| Discovery unavailable, valid cached declaration     | Cached declared inboxes + compatibility reads                      | Cached declared inboxes                 |
| Valid signed empty declaration observed             | Preserve cached reads; show explicit no-inbox state                | Block; do not override signed state     |
| Malformed declaration observed                      | Preserve cached reads; show repair and ambiguity                   | Currently blocked pending safety review |
| General kind 14 DM without declaration              | Permissive own-inbox reads; sends stay blocked                     | Block                                   |
| Guest checkout                                      | Merchant order leg may use compatibility                           | No guest inbox/self-copy/reply promise  |
| Guest or partial-identity merchant lifecycle record | Merchant inbox reads + configured compatibility relays             | Encrypted merchant self-record only     |

Invariants:

- Secure normalized `wss://` targets only.
- A valid current or retained cached kind `10050` outranks compatibility unless
  stronger valid signed evidence supersedes it, including a newer signed empty
  replacement.
- A bounded discovery plan that completes without an event currently returns
  `not_declared` for route selection. This is scoped observation, not proof of
  global Nostr absence. Relay omission must not be described as a signed opt-out
  or revocation.
- The compatibility lane is recipient-only. For buyer-addressed order traffic,
  the non-critical sender self-copy leg stays strict and fails soft when the
  sender has no usable declaration. For a guest or partial-identity lifecycle
  action, the critical recipient is the merchant sender; this is an encrypted
  merchant self-record and does not imply a guest inbox, reply, or notification.
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
  rumor id, order id, sender, and recipient; kind 14 stays strict-only. A
  merchant self-record uses a separate one-use scope that additionally binds
  a revalidated inbound order anchor, the buyer counterparty, supported
  lifecycle type, content identities, and an immutable rumor fingerprint. Its
  inner `p` tag remains the buyer so the order projection is unchanged while
  the encrypted outer recipient is the merchant. An arbitrary caller-supplied
  buyer/order tuple or a partial history without the inbound order cannot mint
  this scope.
- The same signed recipient wrap is attempted on the whole plan. Relay ACK is
  relay acceptance, not recipient receipt/read. At least one ACK is successful
  delivery; failed targets remain content-free retry state. Zero ACKs is an
  explicit failure and never becomes sent/delivered.
- Declared kind `10050` delivery remains exclusive but is capped at the first
  three secure normalized tags, preserving signed tag order and surfacing
  truncation instead of allowing an unbounded recipient-controlled fanout.
- No automatic signer prompt; no NIP-04 sending.
- Diagnostics and telemetry stay identifier-free and content-free.

### Bounded merchant history reads

Recent conversation surfaces read one page of up to 400 gift wraps. Merchant
order priority and queue reads may walk at most four pages and 1,600 unique
wraps so older actionable orders are considered before the 200-conversation
display limit.

Pagination uses the encrypted outer wrap's NIP-01 `until` coordinate. NIP-59
deliberately randomizes that timestamp, so a decrypted rumor or cache-row time
is not a safe pagination cursor. Because `until` is inclusive, a saturated
same-second page is retried at the same timestamp and stops as
`cursor_stalled` if it yields no unseen ids; subtracting a second could skip
valid wraps.

`meta.inbox.historyCoverage` reports temporal depth independently from relay
coverage: `recent_only`, `complete_within_scope`, `bounded`,
`cursor_stalled`, or `interrupted`. Priority results are degraded for the last
three states, and Merchant must tell the operator that older orders may be
missing instead of presenting the ranking as exhaustive.

After a deep read, a process-local, relay-plan-bound checkpoint lets the
30-second order poll use one page when every saturated relay still overlaps its
previous page. Because NIP-59 backdating can insert a newly received wrap
behind that page, overlap is only short-lived continuity evidence: saturated
histories are rescanned at least every five minutes, and an unbridged page or
changed relay plan triggers an immediate deep read. The checkpoint is not
durable; a reload safely repeats the bounded scan. A persisted outer-wrap
frontier is a follow-up and cannot be reconstructed from decrypted rumor
timestamps.

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

These gaps keep the compatibility lane out of production. Correcting them must
not widen compatibility to general DMs, arbitrary relays, plaintext delivery,
or unvalidated sender/recipient relationships.

## Implementation map

- Typed routing model, declaration cache, read planning, route selection:
  `packages/core/src/protocol/private-message-routing.ts`
- Send-side gating and lane provenance: `packages/core/src/protocol/messaging.ts`
  (`publishPrivateMessage`, `ValidatedInboundOrderLifecycleAnchor`,
  `ValidatedOrderRouteScope`,
  `ValidatedOrderSelfRecordRouteScope`, `deliveryRoute`)
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

Required aggregate measurements are declared-ready rate, route lane, ACK
outcome, read source/coverage, and missing-order incident count. They are not
yet implemented, so the removal gate is not measurable and the lane must not be
activated in production on the strength of this document alone. No identifiers
or message content may enter these aggregates.

## Public references

- NIP-17: https://github.com/nostr-protocol/nips/blob/master/17.md
- NIP-59: https://github.com/nostr-protocol/nips/blob/master/59.md
- NIP-65: https://github.com/nostr-protocol/nips/blob/master/65.md
