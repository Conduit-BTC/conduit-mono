# Separate-origin local signer: security and policy review

**Status: existing-NSEC policy approved; implementation and composed preview
testing may proceed before production device sign-off.** The intended product
imports an existing key in the separate signer origin, restores automatically,
performs ordinary operations without per-action approvals, and deletes the
stored key on explicit logout. NIP-07/NIP-46 remain alternatives. The local
option is shown only in installed standalone Market/Merchant PWAs.

The separate public MIT-licensed [signer feasibility implementation](https://github.com/Conduit-BTC/conduit-signer/pull/1)
is merged. Its parent probes are test equipment, not composed Market/Merchant
applications. The current client still implements only NIP-07/NIP-46; this policy
PR adds no runtime provider. Browser and cryptographic checks support development
but do not establish physical-iPhone persistence or production readiness.

## Existing owners and signer boundary

`packages/core/src/protocol/nostr-event-signer.ts` defines `AccountSigner` and
`NostrKeySigner`. `session-signer.ts` owns principal/revision fencing, serialized
operations, signed-event validation, timeout and cancellation. `AuthContext.tsx`
owns account lifecycle; `SignerSwitch.tsx` owns shared connection UX. A future
provider must adapt to these owners. It must not impersonate NIP-07/NIP-46, add a
second account owner, or replace publication/public-read/protected-read owners.

The approved `conduit-signer` repository owns the standalone proof and eventual
separately reviewed signer. This document does not approve a dedicated HTTPS origin, deployment or release. The two parent surfaces are probes,
not actual installed Market/Merchant applications.

The signer alone owns existing-nsec import, persistent key storage, key operations
and logout. The parent receives status/public key, a complete verified signed
event, NIP-44 operation results, narrow legacy NIP-04 decrypt results and logout
status. Import/export, backup retrieval, key generation and NIP-04 sending are
absent from the message API. Test identities are ordinary newly generated Nostr keys from a CSPRNG; the
signer-owned test generator is test equipment, not product account creation.
Use the same account/session behavior for composed previews. Do not add a
passkey, Face ID, password unlock, backup-verification step or recovery ceremony
to the existing-key product.

## Threats and required controls

| Boundary / attacker                                   | Impact                                         | Recorded proof control                                                                                                                                                        | Production decision or residual risk                                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unapproved parent or sibling frame sends requests     | Unauthorized signing/decryption                | Exact origin allowlist, direct parent/source checks, exact frame-ancestors; parent checks signer origin and current WindowProxy                                               | Freeze and review each deployment/preview origin; no wildcard preview admission                                                                   |
| Stale response, old frame, replay or account switch   | Result committed under wrong authority         | Random channel/request/frame identifiers, stored-record revision and public-key binding, bounded requests, verified exact template/signature, timeout and reload cancellation | Integrate with existing SessionSigner and auth authority; prove composed tab/account transitions                                                  |
| Another view logs out or reimports                    | Old key operation survives revocation          | Per-operation storage read and post-operation revision check; conditional logout deletion; BroadcastChannel invalidation; parent pending-operation cancellation               | Verify partition-specific behavior physically; suspension can delay notifications, so durable checks must remain authoritative                    |
| Compromised Market/Merchant script                    | Allowed signing/decryption oracle; UI spoofing | Same-origin policy isolates raw key storage and frame DOM                                                                                                                     | High residual risk: origin isolation does not stop allowed RPC misuse. No routine action approval means this tradeoff needs maintainer acceptance |
| Compromised signer script, dependency or release      | Account key theft                              | Small static bundle, locked crypto dependency, no app scripts/analytics, restrictive CSP                                                                                      | High residual risk: signer-origin code can read keys. Separate repository/release access and reviewed dependency graph required                   |
| Local device/browser data access                      | Persistent key disclosure                      | Signer-owned device-local storage; no independent unlock or false wrapping-key claim                                                                                          | High impact; automatic restore provides no independent unlock protection. Maintainer must accept and document the device-local threat model       |
| WebKit partitioning, eviction or offline load failure | Repeated import or unavailable signer          | Explicit absent/unavailable status, signer-owned reimport, static-only offline cache                                                                                          | Physical device matrix decides feasibility. Never move key/unwrapping capability into app storage                                                 |
| Diagnostics or test artifacts disclose data           | Key/message disclosure                         | Content-free UI/errors, no telemetry, no payload logs, no browser traces/video; server accepts only fixed GET/HEAD asset routes                                               | Review hosted logging, CSP reporting, crash tooling and release artifacts before deployment; screenshots must exclude input and payloads          |

Origin/session checks and signature validation are security/data-integrity
invariants and fail closed. Installed mode is a UX gate; it does not grant key
authority. Storage availability is a capability observation. Missing capability
must preserve browsing and external signers.

Byte-array clearing is best effort; JavaScript strings, browser copies, swap and
backups prevent forensic-erasure guarantees. Encrypting a local record with an
automatically available wrapping key does not protect it from compromised
same-origin code. Logout removes the active stored record and revokes that
storage partition; it cannot promise deletion in a separately isolated PWA.

## Approved policy boundary

The bounded existing-key exception is documented in `AGENTS.md`,
`CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, `docs/specs/protocol.md` and
`docs/knowledge/external-nostr-references.md`. Review instructions, the PR
template, protected-read guidance and the wallet cross-reference follow the same
boundary. The maintainer explicitly authorized this policy change; the former
external-only policy is not a reason to remove the requested feature. Actual
inconsistencies, key leakage, invalid authority and missing lifecycle controls
remain review findings. Trusted maintainer authorization must be established
independently of candidate-controlled text.

The shared account/session, publication and public-reader changes are merged. Refresh current main and
deepen those owners for the local adapter rather than copying transport or
inventing another account owner. Runtime account-method types currently admit
only NIP-07/NIP-46; that is an implementation gap to close in the auth lifecycle
slice, not evidence that the approved policy exception should be removed.

Implementation and composed previews with newly generated test identities may
proceed before physical production device sign-off. Exact origin/source
allowlists, CSP, account/session fencing, cancellation and content-free diagnostics
apply during preview testing. Before production, require maintainer security and
hosted privacy review plus exact-origin physical-iPhone evidence in Safari and
installed Market/Merchant: import, termination/relaunch, automatic restore,
ordinary signing, frame reload, offline/online, storage loss, logout and reimport.
Record device/iOS, storage partitions and any separate-import requirements.
Failed persistence needs a reviewed storage/UX resolution, never app-origin key
storage. Origin, deployment and release approval remain separate.

Test generation/encoding must use runtime CSPRNG keys inside the controlled test
process or signer-owned test surface. No fixed scalar or encoded credential may
enter source/history; no raw key may reach app origins, services, diagnostics or
artifacts. Signed test operations and their results may exercise composed app
flows through the ordinary account/session boundary. Static-credential,
authored-history and protected-smoke guards remain enforced and unchanged.
Generating test identities does not authorize product new-identity creation.

The existing guest-order, NIP-46 client-connection, Anon public-zap and Portable
Wallet exceptions remain purpose-scoped and unchanged.

`docs/specs/protocol.md` defines the future local adapter's account/session and
protected-read requirements. The current runtime still admits only NIP-07 and
NIP-46 account adapters. Public-key status and restoration candidates do not grant
authority. Shared envelope construction remains the production owner, with
NIP-44 v2 and explicit legacy decrypt capability; future v3 remains source- and
capability-gated.

## Acceptance evidence boundaries

| ID    | Proof evidence                                                                                                                                                                          | Gap before full acceptance                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| LS-01 | Parent probe observes browser/standalone mode; signer owns import UI                                                                                                                    | Actual shared connection option, external signer/browsing regression and physical installed-app screenshots                                           |
| LS-02 | Separate public MIT repository; typed operation allowlist, cross-origin browser isolation, strict headers, no parent IndexedDB, no data-bearing network requests; locked crypto imports | Exact approved HTTPS origins, hosted header/logging review and production dependency/release review                                                   |
| LS-03 | Fake IndexedDB recreation and desktop browser/frame reload restore                                                                                                                      | Physical exact-origin Safari/PWA termination/relaunch, offline cold launch, device/iOS details, eviction and separate-import observations             |
| LS-04 | Standalone real synthetic signing/NIP-44/legacy decrypt and independent kind-14/kind-16 NIP-59 interoperability                                                                         | AccountSigner/AuthContext integration, shared envelope composition, protected-read eligibility and actual Market/Merchant flows on stable merged base |
| LS-05 | Record deletion, revision change, stale-account/frame rejection, parent cancellation and same-partition cross-view browser logout                                                       | Physical suspension/relaunch and separate-partition logout/reimport evidence; composed auth lifecycle                                                 |
| LS-06 | Content-free diagnostics, approved bounded existing-key and development-fixture exceptions, explicitly confirmed policy/contract edits                                                  | Maintainer threat sign-off, merged contract changes and hosted privacy review                                                                         |
| LS-07 | Repeatable focused tests, browser checks, strict browser TypeScript, lint and static build commands                                                                                     | Current-head hosted CI, product smoke/Playwright coverage, human iPhone QA and separate release approval                                              |

Maintain exact candidate heads and run results in the PR, and device evidence in
the review record. Do not mark a criterion complete merely because this table
identifies its future validation.

## Public sources

- [NIP-01: event shape, serialization and signatures](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-07: public key, signing and encryption operations](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [NIP-46: remote signing and account/client-key separation](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [NIP-44: version 2 encrypted payloads](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [NIP-17: private messages and recipient relay routing](https://github.com/nostr-protocol/nips/blob/master/17.md)
- [NIP-59: rumor, seal and gift wrap verification](https://github.com/nostr-protocol/nips/blob/master/59.md)
- [NIP-04: deprecated legacy encryption](https://github.com/nostr-protocol/nips/blob/master/04.md)
- [WebKit 181850: cross-origin Home Screen storage](https://bugs.webkit.org/show_bug.cgi?id=181850)

NIP-01/07/46/44/17/59/04 were checked for this policy refresh on 2026-10-07.
The historical WebKit reports do not establish current-iOS behavior in either
direction. The required physical device matrix supplies production evidence;
desktop emulation is supporting evidence only.
