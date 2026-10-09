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

## Provider integration handoff

Adapt a provider to `NostrKeySigner` and bind it with the existing
`SessionSigner`. `AuthProvider` remains the only account lifecycle owner. This
foundation does not choose a new provider's custody, storage or transport model.
The current account-key boundary and separate-origin imported-key exception in
[`docs/specs/protocol.md`](../specs/protocol.md#authentication) remain unchanged.
Any change to that policy requires a separate maintainer decision before
implementation; this note does not authorize app-origin account-key custody.

- Keep provider credential revisions distinct from the app's `authClaim`.
  Shared metadata contains public identity and provider references, never an
  account private key or independently usable unwrapping material. A stale
  session cannot adopt or remove a replacement provider credential.
- Map `signEvent`, `encryptNip44`, `decryptNip44` and decrypt-only legacy
  operations to the existing contract. Preserve `SessionSigner`'s exact-template
  and signature validation, scheduling, capabilities and typed failures.
- Keep transient invalidation separate from durable removal. Failed restoration
  closes transient provider resources while preserving durable credentials.
  Explicit logout synchronously revokes account authority before conditionally
  retiring the exact captured credential. Failed cleanup stays failed and
  retryable; it cannot revive authority or report successful removal.
- Add any approved provider through explicit connect, restore and credential
  retirement branches. Review protected-read, Network publication and recipient
  relay AUTH eligibility together. Guest keys remain purpose-scoped and
  ineligible. Never impersonate `window.nostr`.

Provider implementation, import/onboarding UI, persistence changes and activation
belong to a separate integration. Real-signer, composed Market/Merchant and
physical-device evidence remain distinct from this shared-lifecycle extraction.

## Wallet recovery boundary

Wallet recovery consumes the existing `AccountSigner` capabilities and
`SessionSigner` authority fences. Recovery-specific permission probes, encrypted
wallet records, relay delivery/read-back evidence, primary-wallet selection and
checkout recovery do not belong in auth session metadata or installation. A
wallet's encryption/signing permissions must not become login requirements.
