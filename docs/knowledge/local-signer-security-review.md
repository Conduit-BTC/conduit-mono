# Separate-origin local signer: security and policy review

**Status: bounded existing-key and development-fixture policy approved and
documented; runtime integration gated.** The runnable
[standalone disposable proof](https://github.com/Conduit-BTC/conduit-signer/tree/feat/disposable-signer-proof)
is development-only in the separate public MIT-licensed repository. Production
authentication remains external-signer-only. Neither synthetic cryptography nor
desktop WebKit passes the physical-iPhone feasibility gate.

## Existing owners and signer boundary

`packages/core/src/protocol/nostr-event-signer.ts` defines `AccountSigner` and
`NostrKeySigner`. `session-signer.ts` owns principal/revision fencing, serialized
operations, signed-event validation, timeout and cancellation. `AuthContext.tsx`
owns account lifecycle; `SignerSwitch.tsx` owns shared connection UX. A future
provider must adapt to these owners. It must not impersonate NIP-07/NIP-46, add a
second account owner, or replace publication/public-read/protected-read owners.

The approved `conduit-signer` repository owns the standalone proof and eventual
separately reviewed signer. No dedicated HTTPS origin, deployment, release or
real-key use is approved by this document. The two parent surfaces are probes,
not actual installed Market/Merchant applications.

The signer alone owns existing-nsec import, persistent key storage, key operations
and logout. The parent receives status/public key, a complete verified signed
event, NIP-44 operation results, narrow legacy NIP-04 decrypt results and logout
status. Import/export, backup retrieval, key generation and NIP-04 sending are
absent from the message API. The proof's disposable fixture button is testing
equipment, not a product creation feature.

## Threats and required controls

| Boundary / attacker                                   | Impact                                         | Current proof control                                                                                                                                                         | Production decision or residual risk                                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unapproved parent or sibling frame sends requests     | Unauthorized signing/decryption                | Exact origin allowlist, direct parent/source checks, exact frame-ancestors; parent checks signer origin and current WindowProxy                                               | Freeze and review each deployment/preview origin; no wildcard preview admission                                                                   |
| Stale response, old frame, replay or account switch   | Result committed under wrong authority         | Random channel/request/frame identifiers, stored-record revision and public-key binding, bounded requests, verified exact template/signature, timeout and reload cancellation | Integrate with existing SessionSigner and auth authority; prove composed tab/account transitions                                                  |
| Another view logs out or reimports                    | Old key operation survives revocation          | Per-operation storage read and post-operation revision check; conditional logout deletion; BroadcastChannel invalidation; parent pending-operation cancellation               | Verify partition-specific behavior physically; suspension can delay notifications, so durable checks must remain authoritative                    |
| Compromised Market/Merchant script                    | Allowed signing/decryption oracle; UI spoofing | Same-origin policy isolates raw key storage and frame DOM                                                                                                                     | High residual risk: origin isolation does not stop allowed RPC misuse. No routine action approval means this tradeoff needs maintainer acceptance |
| Compromised signer script, dependency or release      | Account key theft                              | Small static bundle, locked crypto dependency, no app scripts/analytics, restrictive CSP                                                                                      | High residual risk: signer-origin code can read keys. Separate repository/release access and reviewed dependency graph required                   |
| Local device/browser data access                      | Persistent key disclosure                      | Explicit disposable-only experiment; no false wrapping-key claim                                                                                                              | High impact; automatic restore provides no independent unlock protection. Maintainer must accept and document the device-local threat model       |
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
`docs/ARCHITECTURE.md`, `docs/specs/protocol.md` and
`docs/knowledge/external-nostr-references.md`. The protected-document edits are
explicitly confirmed. This policy approval does not pass the physical-iPhone or
maintainer security gate, approve an origin/deployment/release, or enable a local
account provider. Refresh and validate the eventual merged app base before
runtime integration.

The narrow development-fixture exception is approved in the separate prototype:
encoding must consume only a key generated at runtime inside the isolated test
signer or test process; no fixed scalar, encoded literal, real account credential, export,
diagnostic or network sink is allowed. Static-credential and protected-smoke
checks remain enforced. The standalone proof checks the runtime source and bounded
encoding sink, rejects fixed credentials and rejects raw-key RPC fields. The
monorepo authored-history and protected-smoke guards remain unchanged. The proof
has moved out of this repository; its earlier experimental commits are superseded
by the separate repository's reviewable slice, not production integration.

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

## Public sources checked before the proof

- [NIP-01: event shape, serialization and signatures](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-07: public key, signing and encryption operations](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [NIP-44: version 2 encrypted payloads](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [NIP-17: private messages and recipient relay routing](https://github.com/nostr-protocol/nips/blob/master/17.md)
- [NIP-59: rumor, seal and gift wrap verification](https://github.com/nostr-protocol/nips/blob/master/59.md)
- [NIP-04: deprecated legacy encryption](https://github.com/nostr-protocol/nips/blob/master/04.md)
- [WebKit 181850: cross-origin Home Screen storage](https://bugs.webkit.org/show_bug.cgi?id=181850)

WebKit 181850 remains marked NEW in the public tracker as checked on 2026-10-01.
Its historical reports do not establish current-iOS behavior in either direction.
The required device experiment supplies that evidence.
