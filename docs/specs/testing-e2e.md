# Automated Smoke Testing and Pull Request Evidence Specification

## Status

- **Phase:** Draft
- **Last updated:** 2026-08-21
- **Applies to:** Market, Merchant, shared runtime packages, Playwright, CI smoke
  selection, and pull request evidence

## Summary

Conduit pull requests must connect each observable acceptance criterion to
reviewable evidence. Required pull request smoke tests must exercise the exact
candidate commit with deterministic local infrastructure and no long-lived
credentials.

The smoke system uses two independent test roles: a buyer and a merchant. The
required tier generates both keypairs at runtime. The applications access those
keys only through production-shaped external signer interfaces.

Automated evidence narrows human review. It does not remove required code
review or let an author waive protocol, authentication, payment, privacy,
security, or release review.

## Problem

The current Playwright suite gives useful browser and state coverage, but its
general signer helper uses fixed placeholder pubkeys, synthetic event IDs and
signatures, and pass-through encryption. Normal CI does not prove the complete
Merchant-to-Market commerce loop against a relay.

The protected live guest-order smoke is a different tier. It uses a dedicated
merchant credential and public infrastructure, but it is manual and cannot
expose that credential to pull request code. It cannot be the required check
for an unmerged candidate.

Current CI also selects browser tests with lower-case title text. Untagged
tests and tests with different title capitalization can be skipped silently.
A selected shard does not currently prove that its intended tests ran.

Pull request descriptions list commands without consistently stating:

- the observable result that each command proves;
- the smoke or Playwright coverage added for changed behavior;
- the signer and environment fidelity of the evidence;
- the exact candidate commit covered by the evidence;
- any untested acceptance criterion or external dependency;
- whether a separate human product QA pass is still required.

This makes a green check difficult to interpret. A passing unit test can look
equivalent to a production-shaped smoke even when it does not cross the same
signer, relay, encryption, storage, or browser boundary.

## Goals

- Make acceptance criteria observable and mandatory in pull request guidance.
- Map each acceptance criterion to automated evidence, manual evidence, or an
  explicit gap.
- Add a hermetic commerce smoke tier with real Nostr cryptography.
- Test independent buyer and merchant identities without putting an `nsec` in
  tracked files, pull request secrets, logs, traces, screenshots, or artifacts.
- Exercise NIP-07 and NIP-46 through production-shaped signer interfaces.
- Distinguish relay acceptance, recipient observation, and semantic completion.
- Give reviewers a consistent evidence-based QA disposition.
- Keep failures deterministic, content-free, and actionable.
- Preserve one stable aggregate required smoke check while adding new shards.

## Non-Goals

- Automating a third-party signer's exact popup design or approval copy.
- Treating a test signer as proof that every signer implementation is compatible.
- Running real payments or public-relay writes for every pull request.
- Giving fork pull requests access to long-lived buyer, merchant, wallet, or
  signer credentials.
- Replacing focused unit, integration, accessibility, or visual tests with one
  large browser scenario.
- Using a green smoke result as automatic merge approval.
- Adding a permanent integration branch before a measured need exists.

## Terms

- **Acceptance criterion:** An observable outcome that must be true for the
  change to be accepted.
- **Evidence:** A test, artifact, screenshot, log summary, or manual result tied
  to a candidate commit.
- **Smoke test:** A bounded end-to-end check that crosses the production entry
  point and the important system boundary for the behavior under test.
- **Hermetic:** Uses local or in-process dependencies and no public network,
  real funds, or long-lived secret.
- **Protected canary:** A restricted workflow that can use dedicated test
  credentials or public infrastructure outside untrusted pull request code.
- **Evidence sign-off:** Human code review of the change and its evidence with
  no separate manual product QA pass.
- **Targeted human QA:** A separate person exercises named product behavior on
  the exact preview candidate.
- **Maintainer-owned validation:** Targeted expert review and validation for a
  high-risk boundary.

## Evidence Tiers

| Tier                    | Purpose                                                                  | Dependencies                                                       | Pull request gate                            |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------- |
| Unit and contract       | Prove pure logic, validation, and narrow failure behavior                | In-process fixtures                                                | Required when affected                       |
| Browser UI smoke        | Prove routes, controls, persistence, and browser integration             | Mock-mode local apps                                               | Path-selected required shard                 |
| Hermetic commerce smoke | Prove real signing, encryption, relay exchange, and cross-app projection | Local relay, local signer harnesses, deterministic wallet boundary | Required for affected commerce paths         |
| Deployed preview smoke  | Prove the built candidate and selected non-destructive product flows     | Candidate preview and approved test data                           | Required when the PR classification names it |
| Protected live canary   | Prove a bounded public-infrastructure or funded boundary                 | Protected environment and dedicated credentials                    | Never a normal pull request secret gate      |
| Real signer/device QA   | Prove a supported extension or mobile signer's approval and handoff UX   | Named signer, browser, or physical device                          | Manual and targeted                          |

Passing a lower tier does not imply that a higher tier passed. A browser smoke
that seeds IndexedDB does not prove relay delivery. A relay `OK` does not prove
recipient observation. A payment API response does not prove settlement.

## Pull Request Evidence Contract

Every non-trivial pull request must include stable criterion IDs such as
`AC-1`. For each criterion, the pull request must state:

- the observable expected result;
- the automated test name and command, or the manual check;
- the environment and signer fidelity;
- the evidence source, such as a required check or candidate-SHA preview;
- the result or current gap.

The pull request must also list its smoke coverage delta:

- critical flows changed;
- Playwright or smoke tests added or updated;
- existing tests relied on;
- criteria that remain manual;
- why no browser smoke changed, when applicable.

Evidence is valid only for the commit it tested. A new commit invalidates stale
preview screenshots, manual QA, and candidate-specific smoke evidence.

### Review and QA Disposition

The author proposes one disposition. The reviewer confirms or raises it.
Branch protection and required human review still apply to every disposition.

| Disposition                 | Use when                                                                                                                                                | Separate product QA           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Evidence sign-off           | All criteria have deterministic evidence at adequate fidelity, and the change does not require visual judgment or cross a high-risk boundary            | Not required                  |
| Targeted human QA           | User-visible interaction, responsive layout, accessibility judgment, browser integration, preview-only behavior, or an explicit test gap needs a person | Required for the named checks |
| Maintainer-owned validation | Protocol emission, signer auth, encryption, payments, privacy, security, migrations, destructive state, secrets, or release behavior changes            | Required with a targeted plan |

Evidence sign-off is not eligible when any acceptance criterion is unmapped,
flaky, covered only by an unrelated lower-level test, or dependent on an
untested external state.

An author or automated agent cannot downgrade a high-risk change. Automated
evidence can reduce the maintainer's manual test scope, but it cannot waive the
maintainer decision.

## Signer and Identity Fixture Policy

### Confidence layers

Use the lowest layer that proves the criterion, and label it truthfully:

1. A stubbed NIP-07 object for connection, lock, rejection, and UI states.
2. A runner-held real cryptographic signer behind the NIP-07 interface.
3. A local NIP-46 signer emulator over an isolated relay.
4. Protected live buyer and merchant accounts held outside pull request code.
5. A supported real extension or mobile signer under targeted human QA.

No pull request may claim a higher fidelity than the layer it ran.

### Required PR roles

The required hermetic tier must create independent buyer and merchant account
keypairs at runtime. A single key must not play both roles.

The harness must also create separate disposable NIP-46 client and remote
signer keys where that protocol requires them. It must not confuse the
remote-signer pubkey with the user pubkey.

Runtime buyer and merchant account keys may exist only in test-runner memory,
a temporary signer profile, or the local signer process. Market and Merchant
code must not receive a raw buyer or merchant account key.

This rule does not prohibit protocol-scoped ephemeral keys that production code
already owns. The browser may create and protect a disposable NIP-46 client
connection key, a per-message NIP-59 wrapper key, or the bounded guest-order
key allowed by the protocol specification. Tests must keep those roles distinct
from durable buyer and merchant account keys.

### Real cryptographic NIP-07 adapter

The first hermetic flow should generalize the existing runner-held signer
pattern. The Playwright process holds the runtime key and exposes bounded
signer operations to a NIP-07-shaped `window.nostr` adapter.

The adapter must:

- expose `getPublicKey` and `signEvent`;
- expose NIP-44 v2 encrypt and decrypt for commerce messaging;
- compute real event IDs and Schnorr signatures;
- keep the role key out of page local storage and application state;
- model approve, reject, locked, unavailable, and delayed responses;
- clear all temporary state after the test.

This layer proves real cryptography and Conduit's NIP-07 API use. It does not
prove extension-process isolation or a vendor extension's approval UX.

Playwright can load a test extension through a persistent Chromium context.
A compact extension-backed scenario may add boundary confidence later, but it
still does not replace QA with a supported real signer.

Page-injected synthetic signers remain suitable for narrow UI-state tests.
They must not be cited as proof of signatures, encryption, event IDs, relay
acceptance, or end-to-end commerce delivery.

### NIP-46 adapter

The NIP-46 layer must use a local remote-signer emulator and the production
Conduit NIP-46 client path. Requests and responses must cross the local relay.

The emulator must exercise:

- client-initiated `nostrconnect://` pairing and its connection secret;
- one focused remote-signer-initiated `bunker://` connection;
- separation of client, remote-signer, and user keys;
- `get_public_key` after connection;
- requested signing and NIP-44 permissions;
- real `sign_event`, `nip44_encrypt`, and `nip44_decrypt` results;
- the production-used `switch_relays`, `ping`, and `logout` commands;
- approval, rejection, timeout, disconnect, and revoked-session behavior;
- encrypted and revocable browser-local client connection storage.

After the local NIP-46 layer is stable, the default commerce flow should use
client-initiated `nostrconnect://` because it represents the QR or deep-link
topology used by remote and mobile signers. The `bunker://` scenario proves
the supported paste/direct connection path. Signer-specific changes must run
the matching NIP-07 or NIP-46 scenario.

### Protected test identities

Dedicated long-lived test buyer and merchant identities are allowed only in a
protected preview or live-canary environment. Their account keys must remain in
approved external signers. Do not store an account `nsec` or account private key
in source, GitHub configuration, workflow input, logs, or artifacts.

A protected live canary may store only its revocable NIP-46 client connection
key as an environment secret. Use it only after merge in a main-only,
expected-SHA-verified job behind a GitHub environment with required reviewers.
Never expose that client capability to untrusted pull request code. It is not
the buyer or merchant account key.

Public variables may contain approved test pubkeys and event coordinates when
the workflow needs them. Public artifacts must still follow the repository's
content-free smoke artifact policy.

The protected workflow should use the same signer interface as a real user. It
must not paste an `nsec` into Market or Merchant.

## Hermetic Commerce Smoke

The commerce shard runs Market and Merchant against the same isolated test
system. It must not use public relays or real funds.

### Infrastructure

- Start one isolated local Nostr relay on a dynamically available port.
- Verify event IDs and signatures before the relay accepts events.
- Support deterministic ACK, reject, timeout, delayed-read, and partial-read
  fault modes.
- Use an ephemeral database per run and delete it after the test.
- Pin any relay binary or container by version and digest. Do not use a
  floating `latest` image.
- Start Market and Merchant with an explicit test deployment profile and only
  the isolated relay.
- Start the required local signer harnesses.
- Start a deterministic NIP-47/NWC-compatible wallet boundary or an approved
  regtest replacement.
- Run the commerce project with one worker and serial fault scenarios. A
  parallel implementation is allowed only when each worker owns independent
  relay, wallet, signer, port, and browser-storage state.
- Generate unique opaque run, listing, and order identifiers.
- Stop all processes and delete temporary profiles after the test.

### Happy path

1. Connect Market and Merchant to their independent role signers.
2. Publish a valid signed `kind:10050` inbox declaration for each role through
   the production shared helper.
3. Discover each exact declaration through the other app's bounded production
   read plan and assert its declared relay route.
4. Publish one valid `kind:30402` listing through the production shared helper.
5. Observe a valid relay acknowledgement and read the exact signed event back.
6. Discover the listing through Market's production read boundary.
7. Add the product to the cart and submit an order.
8. Persist and publish the actual NIP-17 wrapped order through the merchant's
   declared inbox route.
9. Observe the exact order through Merchant's production read path.
10. Decrypt and project it as the expected buyer-to-merchant order.
11. Send one invoice through the buyer's declared inbox route.
12. Pay the exact invoice once through the deterministic local wallet boundary.
13. Record the invoice as settled in the local wallet oracle.
14. Deliver one payment proof and observe it through Merchant.
15. Have Merchant emit one signed `paid` status update and observe it through
    Market.
16. Assert the exact final buyer and merchant lifecycle state.

The canonical happy path must use valid declared `kind:10050` routes. Exercise
the temporary validated-order compatibility route in a separate named scenario
with its rollout control enabled. Do not present that scenario as NIP-17 routing.

### Payment settlement oracle

The deterministic wallet boundary must admit exactly one `pay_invoice` call
for the exact issued invoice. It must bind a fixed test payment hash and
preimage, record the invoice as settled, and return a successful NIP-47 result.
The test must then assert:

- the wallet oracle reports one settled invoice and one admitted payment call;
- the buyer lifecycle has `paymentStatus: "paid"`;
- the buyer lifecycle has `proofDeliveryStatus: "sent"`;
- Merchant observes one validated payment proof for the order;
- Merchant emits one signed order status of `paid`;
- Market observes the merchant's `paid` status update.

If the local boundary cannot prove settlement, stop the criterion at
proof-received. Do not label it payment completion or semantic confirmation.

The test must distinguish these evidence stages:

1. `locally_persisted`
2. `relay_accepted`
3. `recipient_observed`
4. `semantically_confirmed`

The test must not report a later stage when it observed only an earlier stage.

### Required failure scenarios

Focused deterministic scenarios must cover the boundaries changed by a pull
request. The scaffold must support at least:

- signer rejection, lock, timeout, and disconnect;
- invalid signature or wrong signer identity;
- relay rejection, authentication requirement, timeout, and late or lost ACK;
- partial relay success and total relay failure;
- missing, partial, stale, and conflicting discovery evidence;
- decrypt or unwrap failure without content leakage;
- duplicate and out-of-order delivery;
- browser restart with pending immutable work;
- NWC rejection, timeout, and ambiguous outcome;
- prevention of a duplicate invoice, payment, order, or proof.

## Smoke Selection Contract

The stable aggregate `e2e-smoke` check remains the protected branch check.
Individual shards may change behind it.

The target shape is:

- `@market`: Market behavior that does not require Merchant;
- `@merchant`: Merchant behavior that does not require Market;
- `@commerce`: shared buyer-to-merchant signing, relay, messaging, checkout,
  order, invoice, and payment behavior.

`@commerce` remains reserved until AC-SELECT-2, tracked by CND-193, is
implemented. Until then, shared commerce changes must run the applicable
current `@market` and `@merchant` shards.

Use explicit Playwright tags or projects. Do not route a test through
human-readable title capitalization.

The selector and validator must:

- fail when a selected shard discovers zero tests;
- fail when a smoke test has no area tag;
- report the selected tags, test names, and count;
- run every applicable tag for shared Playwright and runtime changes;
- keep docs-only changes eligible to skip browser installation.

After AC-SELECT-2 is implemented, run `@commerce` for changes to:

- checkout or order creation;
- product publish and discovery contracts;
- NIP-17, NIP-44, NIP-46, NIP-59, or signer adapters;
- relay publishing, acknowledgement, outbox, or recovery;
- payment request, NWC, payment proof, or order status;
- shared fixtures, Playwright configuration, or the commerce smoke itself.

Pushes to `main` must run every critical shard. A future merge queue must run
the same aggregate check for the merge candidate.

## Test Authoring Rules

- Test an observable user or protocol outcome, not an implementation detail.
- Use the production shared boundary for the behavior being claimed.
- Do not mock the signer, relay, encryption, wallet, or storage boundary that
  the acceptance criterion is intended to prove.
- Keep focused synthetic fixtures for unrelated UI states.
- Use role-based accessible locators for product behavior.
- Give each critical test a stable name suitable for a PR evidence table.
- Isolate browser storage, relay data, ports, signer profiles, and wallet state.
- Use bounded polling with an explicit terminal state.
- Assert authorship, event ID, signature, recipient, and expected state at each
  consequential boundary.
- Test retry and recovery with the same immutable operation. Do not create a
  second semantic action.
- Do not rely on test order, public network availability, or pre-existing data.
- Treat a pass after retry as a flake signal. Do not use it as the sole evidence
  for a high-risk criterion until the cause is understood.

## Artifact and Privacy Contract

Every smoke run should produce a small redacted summary with:

- schema version;
- candidate commit SHA;
- app, tags, stable test names, and selected-test count;
- environment and signer-fidelity label;
- pass or fail status;
- content-free stage and typed failure code;
- aggregate relay attempt and acknowledgement counts;
- bounded duration bucket;
- workflow and artifact references.

Keep traces, screenshots, and videos failure-only. Logs and uploaded artifacts
must not contain:

- private keys, `nsec` values, signer pairing secrets, or NWC URIs;
- pubkeys, npubs, event payloads, plaintext, or ciphertext message bodies;
- invoices, preimages, payment credentials, or wallet recovery material;
- order contents, product-private data, contact data, or addresses;
- callback URLs with sensitive query data;
- private dashboard data or production customer information.

The harness must scan text artifacts for prohibited patterns before upload.
When a screenshot or trace can contain private test content, disable that
artifact or replace the content with a non-sensitive fixed fixture.

## Branch and Integration Strategy

Do not add a permanent `next` branch for this work.

Pull requests against `main` already provide an immutable candidate SHA,
required checks, and preview builds. A new long-lived branch would add drift,
duplicate branch protection, and a second release decision without making the
signer or relay test more representative.

Use a short-lived stacked branch when one smoke implementation depends on
another unmerged scaffold. Rebase the dependent pull request onto `main` after
the scaffold merges.

Reconsider an integration branch only when evidence shows repeated failures
that cannot be found on individual candidate SHAs or a merge queue. Any future
proposal must define branch protection, CI and agent triggers, preview
behavior, promotion, rollback, hotfix back-merges, and release ownership.

## Protected Live Canary Contract

A protected canary complements hermetic pull request smoke. It does not replace
candidate-SHA validation.

Protected credentials are CI test-harness fixtures outside application and
service runtime. They do not authorize durable account custody or another
production signer path.

- Run only from a reviewed environment that does not expose credentials to
  pull requests or forks.
- Bind the run to an immutable deployed commit and report that commit.
- Use dedicated signed-in buyer and merchant accounts only when the scenario
  requires those roles.
- Keep the approved order-scoped guest key for guest scenarios.
- State whether the result is `passed`, `failed`, or `inconclusive`.
- Treat partial public-relay observation as inconclusive when it cannot prove
  the application outcome.
- Require a maintainer-owned plan for persistent events, funds, caps, cleanup,
  credential rotation, and emergency disable.
- Label the result as deployed or live-canary evidence. Do not claim extension
  popup, mobile handoff, or required pull request fidelity.

## Acceptance Criteria

- [ ] **AC-GUIDE-1:** The pull request template requires stable criterion IDs,
      evidence mappings, signer and environment fidelity, current-head results,
      gaps, and one QA disposition.
- [ ] **AC-GUIDE-2:** Contributor, reviewer, and agent guidance define when
      evidence sign-off is eligible and require higher-risk validation.
- [ ] **AC-SELECT-1:** Smoke tests use explicit area tags, reject orphaned
      tests, and reject a selected shard with zero tests.
- [ ] **AC-SELECT-2:** The selector runs the commerce shard for affected
      critical paths, keeps one aggregate required check, and runs every
      critical shard on `main`.
- [ ] **AC-KEY-1:** Required PR smoke generates separate buyer and merchant
      account keys at runtime without putting those keys in application state
      or uploaded artifacts.
- [ ] **AC-SIGNER-1:** The real-crypto NIP-07 adapter produces valid signatures,
      event IDs, and NIP-44 v2 ciphertext outside the page.
- [ ] **AC-SIGNER-2:** The NIP-46 scenario uses production connect, relay
      switching, ping, signing, encryption, logout, and restore behavior with
      separate client, remote-signer, and user keys.
- [ ] **AC-SIGNER-3:** Synthetic page signers are not cited as cryptographic,
      signer-process, or delivery proof.
- [ ] **AC-RELAY-1:** The local relay is isolated, signature-validating,
      fault-injectable, and pinned when an external binary or image is used.
- [ ] **AC-INBOX-1:** Buyer and merchant publish and cross-discover valid signed
      `kind:10050` inbox declarations before the canonical NIP-17 flow.
- [ ] **AC-COMMERCE-1:** The hermetic commerce shard proves publish, discovery,
      order delivery, Merchant observation and decrypt, invoice delivery,
      deterministic settlement, proof delivery, and a signed `paid` status.
- [ ] **AC-COMMERCE-2:** Delivery evidence distinguishes local persistence,
      relay acceptance, recipient observation, and semantic confirmation.
- [ ] **AC-ISOLATION-1:** Commerce fault scenarios run serially or with fully
      isolated relay, wallet, signer, port, and browser-storage state.
- [ ] **AC-ARTIFACT-1:** Failure and summary output remains typed, content-free,
      candidate-bound, and useful.
- [ ] **AC-CANARY-1:** Protected identities remain unavailable to untrusted
      pull request code, and live outcomes can be inconclusive.
- [ ] **AC-BRANCH-1:** The approach works without a permanent integration
      branch.

## Decisions

| Decision                                                       | Rationale                                                                                | Source                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| Expand the existing E2E spec                                   | Smoke evidence is a durable repository contract, not a second parallel policy            | Repository documentation model    |
| Generate buyer and merchant keys at runtime in required CI     | Long-lived test credentials are unnecessary for hermetic candidate validation            | Security boundary                 |
| Start with a runner-held real-crypto NIP-07 adapter            | It reuses the current test seam and proves real crypto without exposing keys to the page | Current Playwright implementation |
| Add a local NIP-46 emulator before making it the default       | It represents remote and mobile signer topology through the production path              | NIP-46 and current client support |
| Keep actual extension and device UX manual                     | Test adapters do not prove third-party approval and handoff behavior                     | Signer boundary                   |
| Keep protected live canaries separate                          | Pull request code must not receive long-lived signer or wallet credentials               | CI trust boundary                 |
| Replace title-based smoke selection                            | Test titles are not stable ownership metadata and currently skip coverage                | Current CI audit                  |
| Keep `main` as the integration branch                          | Candidate-SHA CI and previews already provide the required integration point             | Current Git and deployment flow   |
| Treat evidence sign-off as a QA disposition, not self-approval | Human code review and high-risk ownership remain required                                | Repository review policy          |

## Open Questions

- [ ] Select the smallest maintained local NIP-46 signer implementation, or
      define the narrow test emulator if no installed dependency fits.
- [ ] Select the deterministic NIP-47/NWC test boundary and document why it
      matches production request and ambiguity behavior.
- [ ] Select and pin the signature-validating relay fixture.
- [ ] Set a runtime budget after measuring the local real-crypto commerce scaffold.

## References

- [NIP-07: `window.nostr` capability for web browsers](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [NIP-46: Nostr Remote Signing](https://github.com/nostr-protocol/nips/blob/master/46.md)
- [NIP-44: Encrypted Payloads](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [Playwright: Chrome extensions](https://playwright.dev/docs/chrome-extensions)
- [Decentralized Network Product Posture](../knowledge/decentralized-network-product-posture.md)
- [External Nostr References](../knowledge/external-nostr-references.md)
