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

**Conduit bootstrap order routing** is a named, bounded, Conduit-owned lane for
validated kind-16 order-lifecycle traffic during migration. It is not
NIP-17-conformant routing and must not be presented as an extension of NIP-17.
NIP-44/NIP-59 encrypted gift wraps are preserved end to end.

| State                                           | Reads                                                              | Writes                                 |
| ----------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Valid kind 10050                                | Declared inboxes + local secure IN + bounded compatibility overlap | Declared inboxes only                  |
| No usable declaration, validated kind 16 order  | Local secure IN + configured compatibility relay                   | Configured Conduit bootstrap route     |
| Discovery unavailable, valid cached declaration | Cached declared inboxes + compatibility reads                      | Cached declared inboxes                |
| Signed empty/malformed declaration observed     | Preserve cached reads; show repair                                 | Block; do not override signed state    |
| General kind 14 DM without declaration          | Declared reads only                                                | Block                                  |
| Guest checkout                                  | Merchant order leg may bootstrap                                   | No guest inbox/self-copy/reply promise |

Invariants:

- Secure normalized `wss://` targets only.
- A valid current or cached kind `10050` always outranks compatibility.
- A complete authoritative "not declared" read evicts the cached declaration;
  a confirmed-absent declaration never resurrects as a write target.
- The bootstrap lane is recipient-only: the non-critical sender self-copy leg
  stays strict and fails soft when the sender has no usable declaration.
- Gift-wrap reads are permissive at the transport layer (inner kinds are not
  separable before decryption); the kind-14 strictness applies to delivery
  writes and to the DM surfaces, which stay gated on declared readiness.
- Compatibility writes use only the explicit Conduit-operated allowlist
  (`config.dmBootstrapWriteRelayUrls`); never arbitrary NIP-65, local OUT,
  commerce-priority, or public relays.
- Compatibility requires a validated kind-16 order lifecycle
  (`validatedOrderScope`); kind 14 stays strict-only.
- Relay ACK is relay acceptance, not recipient receipt/read; zero ACK never
  becomes sent/delivered.
- No automatic signer prompt; no NIP-04 sending.
- Diagnostics and telemetry stay identifier-free and content-free.

## Implementation map

- Typed routing model, declaration cache, read planning, route selection:
  `packages/core/src/protocol/private-message-routing.ts`
- Send-side gating and lane provenance: `packages/core/src/protocol/messaging.ts`
  (`publishPrivateMessage`, `validatedOrderScope`, `deliveryRoute`)
- Permissive inbox reads with coverage/source meta:
  `packages/core/src/protocol/commerce.ts` (`meta.inbox`)
- Network-owned readiness/repair: `packages/core/src/hooks/useInboxDeclaration.ts`,
  `packages/ui/src/components/PrivateInboxSection.tsx`, both `network.tsx` routes
- Order provenance: `orderLifecycles.orderDeliveryRoute`
  (`declared_inbox` | `conduit_bootstrap`)
- Flag: `VITE_DM_BOOTSTRAP_WRITES` (redeploy-controlled, default off)

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
