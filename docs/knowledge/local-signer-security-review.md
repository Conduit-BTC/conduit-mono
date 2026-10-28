# Contained local signer: security and acceptance

The optional browser/PWA existing-account signer lives in
`packages/core/src/protocol/local-key/`. NIP-07, NIP-46 and local keys share
`AuthProvider`, `AccountSigner` and `SessionSigner`. Existing-nsec sign-in is
available in ordinary browser tabs and installed apps. Managed preview,
production and staging profiles enable `localKeySignerEnabled` in
`deploy/pages-profiles.json`; the compiled value and public deployment manifest
come from that policy, regardless of stale dashboard environment overrides.
Local development enables it by default and may explicitly disable it with
`VITE_ENABLE_LOCAL_KEY_SIGNER=false`. Import is not product account creation.

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

Clipboard reads also remain inside this boundary. The UI passes only an input
element and an abort signal following an explicit Paste click. The helper returns
only success, writes directly to the uncontrolled field, and discards delayed
results after cancellation, detachment or disabling. Editing, submission and
unmount cancel the UI's pending read. Empty or denied reads preserve the field;
errors are generic and contain no clipboard contents. Paste does not sign in or
persist the account until the user submits. Browser permission prompts and
manual-paste fallback remain platform-dependent.

## Threat model and lifecycle

Contain accidental key propagation, logging/telemetry, ad hoc signing,
unreviewed crypto, unnecessary copies and lifecycle mistakes. This is **not** a
browser security boundary against compromised same-origin application code.
Automatic restore has no independent unlock. IndexedDB provides atomic local
persistence, not encryption or hardware-backed protection. An automatically
available wrapping key would not change same-origin authority.

The active record stores secret bytes and a random import revision. One bounded
candidate slot stages a replacement without overwriting the active record.
The shared auth lock serializes staging, metadata installation and promotion;
the storage transaction additionally checks the candidate and predecessor
revisions. Only successful session installation permits promotion. Failed
installation attempts rollback of its own public metadata, then always attempts retirement of
the failed candidate even when rollback fails. A verified restored predecessor
is preserved. Removing a selected staged session with no replacement atomically
removes its exact superseded predecessor too. Unreadable metadata cannot authorize
reconciliation or lineage deletion; removal retains its journal and lineage for
retry when selection can be verified. A later session is never overwritten by stale rollback. On restart,
the saved public session selects the retained record; abandoned staging is
discarded under the auth lock before another import, and a saved candidate is
promoted after successful restoration.

Public auth
metadata stores public identity and that revision, separately from the shared
auth claim. Check stored account/revision before use and before returning.
Replacement, cancellation and logout fence pending results; the shared owner
also fences queued work. One connection owns the adapter, session signer and
exact read lease throughout pending promotion and installed use. Cancellation
revokes all three before waiting for promotion or durable cleanup. Transition
regressions assert that immediate boundary, successful handoff, late completion,
replacement isolation, interrupted restore and unmount. Missing/unavailable storage stops signing and offers
retry/removal/reimport. Logout stops live authority immediately, then commits
exact-revision deletion and public-session retirement. Failed deletion stays a
visible error and blocks connection until removal succeeds. Cancellation must
not hide that failure: when no newer connection owns the UI, the warning and
removal retry remain available without reloading. Stale cleanup must
preserve a newer import. Exact-revision removal identifies both slots
independently of signing-schema validity, so damaged records cannot silently retain the selected credential.
Predecessor lineage is checked separately; unknown candidate ownership or
unverifiable lineage retains retry metadata instead of reporting success.
Identifiable different revisions and verified restored predecessors are preserved.
The shared auth owner verifies a public-only removal journal. If a new journal
entry cannot persist, it attempts a verified removal marker in the exact existing
auth record, preserving public retry identity without overwriting another
account. The journal stays until both key and metadata cleanup finish under the
shared auth lock. Both paths block automatic restoration after restart. If neither
durable revocation nor key deletion can be secured, the UI explicitly reports
unresolved restart safety and asks the user to keep the window open and retry.
No client can promise durable revocation while all persistent mutations fail.
Successful deletion or a verified marker is required for a restart-safety claim.

Clear accessible secret/conversation-key buffers on completion/invalidation.
JavaScript strings, engine/library copies, browser backups and device storage
prevent forensic-erasure guarantees. Logout affects this storage partition,
not independent Safari/PWA or Market/Merchant partitions. No shared-storage or
cloud-recovery promise.

NIP-44 decryption translates only known payload authentication/padding failures
into the shared invalid-ciphertext category before sanitization. Wallet sync can
then skip an invalid signed record and retain other valid wallet heads; storage,
authority and ambiguous signer failures remain blocking. Real automated clipboard
permission tests are selected only for Chromium projects at discovery. WebKit
retains direct-entry and denied/delayed clipboard recovery coverage with no
selected-test skips.

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
- Managed builds must expose the same testable browser/PWA sign-in flow in
  preview and production. Verify the exact deployed commit and manifest flag,
  then exercise import, restore, cancellation and removal in both applications.
- Focused review and normal branch protections still apply. Record physical
  evidence or its absence honestly; CI and emulation do not prove physical
  persistence. Do not substitute an installed-mode or hidden preview gate for
  testing the actual user flow.
- To disable a managed profile, change its `localKeySignerEnabled` boolean and
  deploy the reviewed build. Disabling sign-in does not delete persisted keys;
  retain removal/retry controls and never claim rollback erased stored keys.

## Acceptance and physical evidence

| ID    | Required evidence                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| LS-01 | Shared browser-tab and installed-PWA option; browsing and NIP-07/NIP-46 preserved                                                           |
| LS-02 | Exclusive secret ownership, narrow API, dependency/leakage guards, honest threat model                                                      |
| LS-03 | Persistence, automatic restore/reopen, malformed/lost/unavailable storage, failed writes                                                    |
| LS-04 | Real signatures, official NIP-44 vector, independent NIP-44/NIP-04/NIP-59 and composed Market/Merchant owner flows                          |
| LS-05 | Replacement/revision fencing, stale completion, cancellation, pending logout, failed deletion, durable removal and no restore after restart |
| LS-06 | Corrected policy, content-free diagnostics, credential history and focused maintainer sign-off                                              |
| LS-07 | Current-head checks, deployed preview/production availability, browser coverage and separately recorded physical-iPhone evidence            |

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
