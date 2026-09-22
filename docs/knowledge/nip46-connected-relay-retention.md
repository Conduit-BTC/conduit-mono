# NIP-46 Signer Relay Negotiation

- **Name:** NIP-46 signer-authoritative relay negotiation
- **Status:** active
- **Canonical target:** Request `switch_relays` after connection or restore and
  adopt a signer-selected secure relay set only after a separate candidate route
  proves the same signer session.
- **Owner:** Conduit remote-signer maintainers
- **Started:** 2026-08-22
- **Next review:** 2026-11-22
- **Rollout control:** Repository-controlled remote-signer workflow; removal or
  widening requires a reviewed change.

## Protocol Boundary

NIP-46 transport relays belong to the remote signer session. They are separate
from Conduit's app/discovery defaults and from signed user relay declarations,
including NIP-65 and `kind:10050`. Negotiating a NIP-46 route must never mutate,
publish, or impersonate either of those other relay authorities.

After a successful pair or restored-session identity check, Conduit sends
`switch_relays`. It accepts the specified string result containing a
JSON-stringified relay array or `"null"`. It also accepts a raw JSON `null`
result as a bounded compatibility form observed in current signers, even though
the NIP-46 response schema defines `result` as a string. Every adopted relay must
be a secure `wss:` URL. Duplicate URLs are removed without adding
Conduit-selected fallbacks.

## Transaction

Relay adoption uses a two-route transaction:

1. Keep the currently verified transport open.
2. Request the signer's preferred relay set on that transport.
3. If the signer supplies a different valid set, open a separate candidate
   transport with the same client key and signer public key.
4. Require a successful ping and the exact already-verified user public key on
   the candidate.
5. Persist and install the candidate session before closing the previous route.

An unsupported, rejected, null, malformed, timed-out, or unavailable migration
does not discard a working session. Conduit re-proves the previous route when the
outcome is ambiguous. Candidate timeout, malformed identity, or wrong identity
also closes the candidate and keeps the old session when that old route still
proves the exact account. If neither route verifies, connection or restoration
fails with the typed error; Conduit never marks an unverified route connected.

## Behavior Matrix

| Observed state                                | Behavior                                                   | User-visible outcome                                     |
| --------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `null` or `"null"` response                   | Keep the verified route                                    | Sign-in or reconnect completes                           |
| Valid equivalent relay set                    | Keep the existing transport                                | No visible interruption                                  |
| Valid different secure relay set              | Verify candidate, persist/install it, then close old route | Sign-in or reconnect completes on signer-selected relays |
| Invalid or insecure relay list                | Re-prove and keep the current route                        | Sign-in continues when the route is healthy              |
| Candidate fails but current route re-verifies | Close candidate and retain current route                   | Sign-in continues without re-pairing                     |
| Candidate and current route both fail         | Reject the connection                                      | User sees reconnect/retry; no false connected state      |

## Bounds And Prohibitions

- This behavior applies only to NIP-46 pairing and session restoration in
  `@conduit/core`.
- QR pairing remains limited to two or three client-selected secure relays.
- Signer-issued bunker URIs and restored sessions must contain at least one
  secure relay.
- The one-use QR secret is cleared before established-session creation.
- Signer public key, user public key, connection acknowledgement, relay URL,
  event, encryption, and signature validation remain hard gates.
- No default relay, NIP-65 relay, private-inbox relay, telemetry, or
  signer-specific persisted metadata is added or changed here.

## Permissions

Both bunker and `nostrconnect://` pairing request the same capabilities:
`sign_event`, `get_public_key`, `nip44_encrypt`, `nip44_decrypt`, and
`nip04_decrypt`. Conduit does not request or advertise the defined
`nip04_encrypt` method because new outbound encryption uses NIP-44. NIP-04
decrypt remains available for legacy incoming content.

## Validation Boundary

Automated tests cover raw and string null, deduplicated valid lists, invalid and
insecure lists, candidate timeout, malformed or wrong candidate identity,
rollback to a verified old route, both-routes-dead failure, and deferred old-route
closure. They do not prove public-relay timing, mobile background behavior, or
current Clave and Amber interoperability. Those remain required real-device tests
without logging relay URLs, connection strings, keys, or account identifiers.

## Public References

- [NIP-46: Nostr Remote Signing](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [Clave NIP-46 compatibility guidance](https://github.com/DocNR/clave/blob/master/docs/nip46-compatibility.md)
- [Amber source](https://github.com/greenart7c3/Amber)
