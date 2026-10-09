# Contained local signer: security and acceptance

The optional installed-PWA existing-account signer lives in
`packages/core/src/protocol/local-key/`. NIP-07, NIP-46 and local keys share
`AuthProvider`, `AccountSigner` and `SessionSigner`. Production activation
defaults off (`VITE_ENABLE_LOCAL_KEY_SIGNER=false`) pending focused review and
physical-device evidence. Import is not product account creation.

## Architecture and ownership

The account owner was established by [#600](https://github.com/Conduit-BTC/conduit-mono/pull/600).
Publication [#605](https://github.com/Conduit-BTC/conduit-mono/pull/605), public
reads [#606](https://github.com/Conduit-BTC/conduit-mono/pull/606), private delivery
[#616](https://github.com/Conduit-BTC/conduit-mono/pull/616) and immutable event
admission [#637](https://github.com/Conduit-BTC/conduit-mono/pull/637) retain their
existing owners. Auth extraction [#641](https://github.com/Conduit-BTC/conduit-mono/pull/641)
separates public metadata, revision/revocation, browser locking and method-specific
retirement. Local import builds on that extraction and the current bounded
foreground/background scheduler. It does not replace Network or wallet owners.

Only the local module and its storage possess the imported account secret. The
uncontrolled password input is consumed and cleared synchronously before the
first await. Auth receives an opaque one-use import capability, then public
identity and operations; no raw values in React state, props or context. The
module exposes no secret getter/export or constructor accepting account-secret
bytes. Already pinned `nostr-tools` supplies NIP-19, signatures, NIP-44 and legacy
NIP-04 decrypt. Current history consumers still require legacy decrypt; no new
legacy send capability. No custom crypto or new runtime dependency.

## Threat model and lifecycle

Contain accidental key propagation, logging/telemetry, ad hoc signing,
unreviewed crypto, unnecessary copies and lifecycle mistakes. This is **not** a
browser security boundary against compromised same-origin application code.
Automatic restore has no independent unlock. IndexedDB provides atomic local
persistence, not encryption or hardware-backed protection. An automatically
available wrapping key would not change same-origin authority.

The local record stores secret bytes and a random import revision. Public auth
metadata stores public identity and that revision, separately from the shared
auth claim. Check stored account/revision before use and before returning.
Replacement, cancellation and logout fence pending results; the shared owner
also fences queued work. Missing/unavailable storage stops signing and offers
retry/removal/reimport. Logout stops live authority immediately, then commits
exact-revision deletion and public-session retirement. Failed deletion stays a
visible error and blocks connection until removal succeeds. Stale cleanup must
preserve a newer import. Malformed unusable records can be explicitly removed.
The shared auth owner keeps a public-only removal journal so failed rollback
before session installation is also retryable after restart; it carries no key.

Clear accessible secret/conversation-key buffers on completion/invalidation.
JavaScript strings, engine/library copies, browser backups and device storage
prevent forensic-erasure guarantees. Logout affects this storage partition,
not independent Safari/PWA or Market/Merchant partitions. No shared-storage or
cloud-recovery promise.

## Focused review requirements

Module, import-input, auth-retirement and crypto-dependency changes require
focused maintainer security review. `CODEOWNERS` routes these changes. Verify
the configured branch rule enforces the required approval before activation;
ownership files alone do not prove enforcement.
Main's protection was checked on 2026-10-08: one approving review, required
code-owner review and stale-review dismissal are enabled. Recheck before release.

- No key getters, general serialization/stores, logging/telemetry, diagnostics,
  network submission, export, account creation or unrelated logic here.
- Inspect dependency/lock changes and public crypto sources. Add no crypto or
  storage dependency without a demonstrated gap and explicit approval.
- Review storage checks, rollback, cancellation, replacement and deletion failure
  together. Failed removal must never appear to be successful logout.
- Require independent signature verification, official NIP-44 vectors, peer
  NIP-44/NIP-04/NIP-59 interoperability and composed app lifecycle regressions.
- Run credential history and boundary guards. Generate disposable identities at
  runtime. No real/fixed credentials or key-bearing logs, traces, screenshots,
  videos or evidence. Protected-smoke credential rules remain intact.
- Keep activation disabled until focused review, physical evidence and an
  explicit production decision. CI and emulation do not replace those gates.

## Acceptance and physical evidence

| ID    | Required evidence                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| LS-01 | Shared installed-PWA option; browsing and NIP-07/NIP-46 preserved                                                                           |
| LS-02 | Exclusive secret ownership, narrow API, dependency/leakage guards, honest threat model                                                      |
| LS-03 | Persistence, automatic restore/reopen, malformed/lost/unavailable storage, failed writes                                                    |
| LS-04 | Real signatures, official NIP-44 vector, independent NIP-44/NIP-04/NIP-59 and composed Market/Merchant owner flows                          |
| LS-05 | Replacement/revision fencing, stale completion, cancellation, pending logout, failed deletion, durable removal and no restore after restart |
| LS-06 | Corrected policy, content-free diagnostics, credential history and focused maintainer sign-off                                              |
| LS-07 | Current-head checks, browser coverage, physical-iPhone matrix, explicit production decision                                                 |

Record exact heads/results in the implementation PR. Physical iPhone evidence
must record device/iOS, build, Safari versus installed Market/Merchant, import,
normal reopen, full termination/relaunch, signing, NIP-44, offline/online,
storage loss, logout/reimport and observed partition behavior. Exclude all
secret input and private payloads. Desktop/WebKit emulation is supporting
evidence only; this note claims no physical validation.

## Retired experiment

[conduit-signer PR #2](https://github.com/Conduit-BTC/conduit-signer/pull/2) was
closed unmerged and its repository archived on 2026-10-08. Useful mature crypto
usage, validation, atomic persistence/deletion, revision checks, buffer hygiene
and regressions are preserved in
[monorepo #646](https://github.com/Conduit-BTC/conduit-mono/pull/646).
Lifecycle uses direct calls and the existing owner. Iframe/postMessage,
frame/source/channel correlation, parent admission, CSP framing, standalone
builds and deployment were discarded. There is no runtime or build dependency
on the experiment. Old PRs/Git history remain the historical record.

## Public sources

- [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md), [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-44 v2 and vectors](https://github.com/nostr-protocol/nips/blob/master/44.md#tests-and-code), [NIP-04 legacy decrypt](https://github.com/nostr-protocol/nips/blob/master/04.md)
- [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md), [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md), [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md)
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools)

Primary sources checked 2026-10-08. NIP-44 v3 planning remains gated on public
draft/client references and explicit capability detection.
