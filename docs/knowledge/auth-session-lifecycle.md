# Auth session lifecycle and provider integration

`AuthProvider` remains the account lifecycle owner. `AccountSigner` is the
operation contract, and `SessionSigner` remains the single active signing owner.
Relay clients do not own account authority. This extraction does not enable a
local account provider or change the current NIP-07/NIP-46 custody policy.

## Responsibilities

| Owner                                         | Responsibility                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-session.ts`                             | Version-1 public metadata, legacy NIP-07 parsing, storage keys, authority revision claims, synchronous revocation, exact-session metadata cleanup, restoration method selection and installed-session authority checks |
| `auth-operation-lock.ts`                      | Browser-wide serialization; existing IndexedDB lock namespace retained for compatibility with open tabs, without reading credential records                                                                            |
| `AuthProvider`                                | Attempt epoch, cancellation, restoration pending state, account identity, transactional installation, React state and cleanup dispatch                                                                                 |
| `session-signer.ts`                           | Account/revision binding, operation queue, capabilities, signature/template validation, pending-operation cancellation and single active owner                                                                         |
| `auth-session-lifecycle.ts`                   | Fixed provider credential-retirement dispatch after shared metadata verification                                                                                                                                       |
| `nip46-auth-session.ts`                       | NIP-46 metadata validation and stable credential identity                                                                                                                                                              |
| `remote-signer.ts` / `remote-signer-vault.ts` | Pairing, route verification/recovery, NIP-46 client credential storage, persistence/rollback, provider invalidation and credential retirement                                                                          |
| Protected-read lifecycle                      | Exact installed account lease, recipient scope and synchronous relay-read revocation                                                                                                                                   |

The persisted session is a restoration candidate, never an authority grant by
itself. The app's current revision must match its installed session claim.
Metadata verification is required when persistence succeeded; optional NIP-07
reconnect metadata failure does not override a successfully verified claim.
Restoration dispatch uses the saved provider and rejects a conflicting requested
provider. Unknown provider metadata remains unsupported.

## Installation and cleanup

The connection attempt owns provider resources until installation succeeds.
After the final attempt/revision fence, `installAccountSigner` installs the
protected-read lease before publishing the existing `SessionSigner` owner.
Installation failure revokes the candidate lease and signer. `AuthProvider`
commits its session/connection refs only after this succeeds.

A failed new NIP-46 install rolls back newly persisted metadata/client credentials
and abandons the connection. A failed restored install preserves its existing
metadata/key and closes the transient transport. Unreadable rollback metadata
must not become permission to delete a possibly referenced key.

Shared retirement verifies metadata removal under the browser auth lock before
calling provider credential cleanup. It preserves a replacement's metadata.
NIP-46 also preserves a replacement using the same client key. Explicit logout
can retire the exact expected credential when metadata verification fails, while
still reporting failure. Synchronous local and cross-tab authority revocation
precedes asynchronous cleanup. Cleanup errors cannot install or revive a signer.

## Separate-origin adapter handoff

The existing [Conduit Signer operation contract](https://github.com/Conduit-BTC/conduit-signer/blob/2f4439dc09cca227e9c5479f5a85859929dbe213/proof/protocol.ts)
uses `status`, `signEvent`, `encryptNip44`, `decryptNip44`, `decryptLegacy` and
`logout`. The subsequent integration should adapt those operations directly to
`NostrKeySigner`, then bind it with the existing `SessionSigner`:

- `status` supplies public `{ pubkey, revision }` binding plus a frame identity.
  Establish and verify the expected account before installing authority. Never
  silently adopt a different account from a later status response.
- Provider revision/frame/channel/request correlation and exact message
  origin/source validation stay inside the provider. The provider revision is
  distinct from the app's cross-tab `authClaim`. Fence both before and after
  asynchronous operations, including reload and provider change notifications.
- `signEvent` returns complete event evidence. Retain `SessionSigner`'s exact
  template, hash, signature and principal validation. Map NIP-44 operations
  directly; legacy decryption is read-only. Preserve typed disconnected,
  unavailable, timeout, invalid-response and authority-changed outcomes.
- Split transient close/abandon from explicit `logout`. App unmount or failed
  restored installation must not delete the signer's durable key. Explicit logout
  revokes app authority synchronously, then requests signer-owned key deletion
  and reports any cleanup failure. Pending results must never revive authority.
- Add a named local-provider metadata variant and fixed connect/restore/cleanup
  branches in the existing owners. Persist only public identity and non-secret
  provider references. Do not persist an NSEC, ciphertext plus independently
  usable unwrapping material, or a key retrieval/export capability in either app.
- Extend protected-read eligibility only alongside reviewed local-provider
  installation. Guest/order keys remain ineligible. This PR retains the existing
  NIP-07/NIP-46 gate and does not impersonate `window.nostr`.

Connection/import UI, approved origins, local activation, policy updates and
physical-device storage/logout evidence belong to the integration. The signer
repository's proof transport is not a production deployment contract. Real
signer/relay delivery and physical PWA persistence require their own evidence.
