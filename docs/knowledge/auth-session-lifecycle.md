# Auth session lifecycle and provider integration

`AuthProvider` remains the account lifecycle owner. `AccountSigner` is the
operation contract, and `SessionSigner` remains the single active signing owner.
Relay clients do not own account authority. NIP-07, NIP-46 and the contained
local-key adapter share this owner. The optional installed-PWA local path
defaults off pending focused security review and physical-device validation;
see the [local signer contract](local-signer-security-review.md).

## Responsibilities

| Owner                                         | Responsibility                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-session.ts`                             | Version-1 public metadata, legacy NIP-07 parsing, storage keys, authority revision claims, synchronous revocation, exact-session metadata cleanup, restoration method selection and installed-session authority checks |
| `auth-operation-lock.ts`                      | Browser-wide serialization; existing IndexedDB lock namespace retained for compatibility with open tabs, without reading credential records                                                                            |
| `AuthProvider`                                | Attempt epoch, cancellation, restoration pending state, account identity, transactional installation, React state and cleanup dispatch                                                                                 |
| `session-signer.ts`                           | Account/revision binding, operation queue, capabilities, signature/template validation, pending-operation cancellation and single active owner                                                                         |
| `auth-session-lifecycle.ts`                   | Fixed provider credential-retirement dispatch with shared metadata verification and method-specific cleanup ordering                                                                                                   |
| `nip46-auth-session.ts`                       | NIP-46 metadata validation and stable credential identity                                                                                                                                                              |
| `remote-signer.ts` / `remote-signer-vault.ts` | Pairing, route verification/recovery, NIP-46 client credential storage, persistence/rollback, provider invalidation and credential retirement                                                                          |
| `local-key/`                                  | Existing-account import, NIP-19 decoding, exclusive secret ownership, IndexedDB persistence, restoration, crypto operations and exact-revision deletion                                                                |
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

Shared retirement uses the browser auth lock and preserves a replacement's
metadata. NIP-46 verifies metadata removal before provider credential cleanup,
and preserves a replacement using the same client key. Explicit logout can
retire the exact expected credential when metadata verification fails, while
still reporting failure.

Local-key retirement first verifies public-only removal retry metadata, then
conditionally deletes the exact local-key revision. Only committed deletion
allows its removal journal and saved public session metadata to be cleared.
Failed deletion retains retry information and blocks automatic restoration;
stale cleanup preserves a later import. This also covers failed new imports
before active-session metadata was saved. Synchronous local and cross-tab
authority revocation precedes asynchronous cleanup. Cleanup errors cannot
install or revive a signer. A failed journal write falls back to an exact-session
removal marker in the existing public auth record. If all durable mutations and
key deletion fail, the UI reports that restart safety remains unresolved;
live revocation alone is not durable removal.

Replacement imports stage one candidate beside the active key, then install
public metadata and shared session authority before atomic promotion. Failed
installation restores the previous public session only while the failed
candidate still owns that metadata, and deletes only that candidate. Restart
reconciliation uses the saved public session to retain or discard staging.

## In-process local-key integration

The local-key implementation lives inside `@conduit/core`, directly behind
`NostrKeySigner`. The existing `SessionSigner` binds it; `AuthProvider`
remains the only account lifecycle owner. There is no standalone signer runtime,
iframe, cross-origin transport, separately deployed origin or package dependency.

- The implementation owns existing-NSEC input, NIP-19 decoding/validation,
  secret-byte storage, key operations and best-effort buffer clearing. It consumes
  and clears import text inside that area; ordinary application code never
  receives a private key or an NSEC getter/export capability.
- Shared auth metadata contains only public identity and a local credential
  revision, distinct from the app's `authClaim`. The adapter verifies the exact
  record before and after asynchronous operations; an old
  session cannot adopt or remove a later import.
- `signEvent`, `encryptNip44`, `decryptNip44` and the required decrypt-only
  legacy operation use the pinned mature crypto implementation and preserve
  `SessionSigner`'s exact-template/signature checks,
  current foreground/background scheduling and typed failures.
- Transient invalidation remains separate from durable removal. Failed restoration
  or app unmount clears accessible key buffers and pending results but preserves
  the stored record. Explicit logout synchronously revokes account authority,
  then conditionally deletes the exact local record. Failed deletion remains
  failed cleanup with a retry path; it never reports successful logout.
- The named local auth method has fixed connect/restore/credential-retirement
  branches. Account eligibility includes protected reads, Network publication
  and recipient relay AUTH. Guest keys remain purpose-scoped and ineligible.
  The adapter does not impersonate `window.nostr`.

Provider implementation, import/onboarding UI, persistence changes and activation
belong to a separate integration. Real-signer, composed Market/Merchant and
physical-device evidence remain distinct from this shared-lifecycle extraction.

Contained import UI, persistence and composed Market/Merchant coverage use the
existing publication, NIP-17/NIP-59 and inbox owners. Physical iPhone PWA
storage/logout validation and a separate production decision remain activation
gates; emulated coverage does not establish physical-device behavior.

## Wallet recovery boundary

Wallet recovery consumes the existing `AccountSigner` capabilities and
`SessionSigner` authority fences. Recovery-specific permission probes, encrypted
wallet records, relay delivery/read-back evidence, primary-wallet selection and
checkout recovery do not belong in auth session metadata or installation. A
wallet's encryption/signing permissions must not become login requirements.
