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

## In-process local-key integration handoff

The local-key implementation belongs inside `@conduit/core`, directly behind
`NostrKeySigner`. Bind it with the existing `SessionSigner`; `AuthProvider`
remains the only account lifecycle owner. There is no standalone signer runtime,
iframe, cross-origin transport, separately deployed origin or package dependency.

- The implementation owns existing-NSEC input, NIP-19 decoding/validation,
  secret-byte storage, key operations and best-effort buffer clearing. Consume
  and clear import text inside that area; ordinary application code never
  receives a private key or an NSEC getter/export capability.
- Persist only public identity and a local credential revision in shared auth
  metadata. Keep that record revision distinct from the app's `authClaim`.
  Verify the exact record before and after asynchronous operations; an old
  session cannot adopt or remove a later import.
- Implement `signEvent`, `encryptNip44`, `decryptNip44` and the required
  decrypt-only legacy operation directly using the pinned mature crypto
  implementation. Preserve `SessionSigner`'s exact-template/signature checks,
  current foreground/background scheduling and typed failures.
- Keep transient invalidation separate from durable removal. Failed restoration
  or app unmount clears accessible key buffers and pending results but preserves
  the stored record. Explicit logout synchronously revokes account authority,
  then conditionally deletes the exact local record. Failed deletion remains
  failed cleanup with a retry path; it never reports successful logout.
- Add a named local auth method and fixed connect/restore/credential-retirement
  branches. Extend account eligibility together for protected reads, Network
  publication and recipient relay AUTH. Guest keys remain purpose-scoped and
  ineligible. Never impersonate `window.nostr`.

Automatic restore without an independent unlock secret gives same-origin code
significant authority over the signer. Module containment reduces accidental
secret handling and enables focused review; it is not a separate browser
security boundary against compromised same-origin application code. Do not
claim stronger protection through automatically available wrapping material.

Contained import UI, persistence, policy correction, composed Market/Merchant
coverage and physical-device storage/logout evidence belong to the integration.
Use the existing publication, NIP-17/NIP-59 and inbox owners. Physical iPhone
PWA validation and a separate production decision remain activation gates.
