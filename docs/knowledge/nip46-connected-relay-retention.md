# NIP-46 Connected Relay Retention

- **Name:** NIP-46 connected-relay retention
- **Status:** active
- **Canonical target:** Request `switch_relays` after connection, validate the
  response, and adopt a signer-selected secure relay set without risking a
  partially migrated live session.
- **Owner:** Conduit remote-signer maintainers
- **Started:** 2026-08-22
- **Next review:** 2026-11-22
- **Rollout control:** Repository-controlled remote-signer workflow; removal or
  widening requires a reviewed change.
- **Activation state:** production when the implementing change is released

## Ecosystem Divergence

NIP-46 says clients SHOULD request `switch_relays` immediately after connecting
or at reasonable intervals. The response `result` is a string containing a
JSON-serialized relay array or `"null"`, and the client changes relays only
after receiving that reply.

Primal's current shared signer implementation recognizes `switch_relays` but
serializes its acknowledgement as a raw JSON `null`. `nostr-tools@2.24.1`
removes the matching response listener but resolves a request only when
`result` is truthy. The resulting promise never settles. Older signers may also
ignore the optional migration request.

Conduit previously turned that unresolved request into a fatal 30-second gate
after pairing and identity verification. A local timeout cannot cancel
`nostr-tools` relay migration. If a delayed request later completes, the live
signer can move relays after Conduit has persisted the original relay set.

Until the dependency can complete or cancel migration safely, Conduit retains
the already-connected relay set and does not call `switch_relays` during
pairing or restore. This avoids blocking an authenticated working connection
and prevents live and persisted relay state from diverging.

## Requirement Classification

- The remote signer identity, user identity, connection acknowledgement, and
  secure `wss:` relay validation remain hard gates.
- Signer-preferred relay migration is an ecosystem convergence preference. It
  may degrade while the established secure route remains usable.
- A failed restore ping is stronger current evidence that the saved route is
  unavailable and still requires re-pairing.

## Behavior Matrix

| Observed state                                                   | Behavior                                     | User-visible outcome                               |
| ---------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------- |
| Pairing succeeds on a valid secure relay set                     | Retain that set and verify the user identity | Sign-in completes                                  |
| Restore ping and identity verification succeed                   | Retain the saved secure relay set            | Session restores                                   |
| Connected relay set is empty, malformed, or not `wss:`           | Reject before creating a session             | Sign-in fails safely                               |
| Pairing, ping, or identity verification times out or is rejected | Preserve existing typed failure handling     | User retries or reconnects                         |
| Signer has a newer preferred relay set                           | No automatic migration in this lane          | User may need to re-pair if retained relays retire |

## Bounds And Prohibitions

- This behavior applies only to NIP-46 pairing and session restoration in
  `@conduit/core`.
- QR pairing remains limited to two or three client-selected secure relays.
- Signer-issued bunker URIs and restored sessions must contain at least one
  secure relay.
- The one-use QR secret is still cleared before session creation.
- The lane does not relax signer or account identity, connection
  acknowledgement, URI, relay URL, encryption, or signature validation.
- It does not add fallback relays, relay fanout, protocol writes, telemetry, or
  signer-specific persisted metadata.

## Repair, Rollout, And Rollback

If the retained relays stop answering, the existing reconnect flow asks the
user to pair the signer again. Re-pairing establishes a fresh client-selected
or signer-issued secure relay set.

The retention behavior is the default in every deployment profile. Immediate
rollback is a reviewed revert of the implementing change. Reintroducing the
previous blocking call is not a safe rollback because the underlying migration
request remains uncancelable.

## Privacy-Safe Measurement And Removal Gate

No new telemetry is added. Measuring signer brands, relay URLs, connection
strings, or account identifiers would violate the repository's diagnostics
boundary and is unnecessary for this dependency-safety gate.

The exception is removal-ready when an adopted `nostr-tools` release provides
all of the following:

1. response completion based on the presence of `result`, including raw JSON
   `null` compatibility;
2. relay URL validation before changing subscriptions;
3. cancellation or disposal that prevents a timed-out migration from mutating
   the returned live signer; and
4. deterministic coverage for canonical relay arrays, string `"null"`, raw
   `null`, unsupported methods, timeout, cancellation, and insecure relays.

Removal requires a reviewed change that restores canonical migration, updates
the regression matrix, and removes this note from the active-exception index.
If the dependency does not satisfy the gate by the next review, maintainers may
implement the same guarantees behind Conduit's shared remote-signer boundary.

## Public References

- [NIP-46: Nostr Remote Signing](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [NIP-46 `switch_relays` proposal and compatibility discussion](https://github.com/nostr-protocol/nips/pull/2193)
- [Primal `switch_relays` response builder](https://github.com/PrimalHQ/primal-android-app/blob/efb88b5af1db9d84eb36b471bf17d49d1c8a8a0c/data/account/repository/src/commonMain/kotlin/net/primal/data/account/repository/builder/RemoteSignerMethodResponseBuilder.kt#L52-L57)
- [Primal remote-signer response serializer](https://github.com/PrimalHQ/primal-android-app/blob/efb88b5af1db9d84eb36b471bf17d49d1c8a8a0c/data/account/signer/src/commonMain/kotlin/net/primal/data/account/signer/remote/model/serializer/RemoteSignerMethodResponseSerializer.kt#L23-L37)
