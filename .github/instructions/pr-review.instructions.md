# PR Review Instructions

Apply these instructions when generating pull request reviews.

## What To Optimize For

- Catch behavioral regressions first
- Enforce protocol and privacy constraints
- Identify missing tests and weak failure handling

## Required Review Output Format

Use this order in the review body:

1. `## Verdict`
   - Start with `**Ready for human approval**` or `**Blocked**`.
   - Put the exact machine-readable merge-readiness verdict on the next line.
   - State `No actionable findings.` here when the review is clean.
2. `## Required actions` only when blocked
   - Give the finding count or delivery blocker.
   - Keep finding details in inline review threads.
3. `## Summary`
   - Use at most three short bullets.
4. `## Evidence`
   - Include the public-context decision and QA disposition.
   - Summarize current-head checks and provenance.
   - Keep the exact QA disposition line unprefixed by a bullet, quote, or code
     fence.
5. A collapsed `<details>` section named `Residual risks and automation limits`
   - Include `What can still be wrong if all visible checks are green?`
   - Include the exact mandatory automation residual.

Put provenance markers in HTML comments. Do not repeat actionable finding detail
in the review body.

Order inline findings by severity (`P0`, `P1`, `P2`). Each finding includes:

1. one-sentence impact statement
2. file path and line reference
3. concrete recommendation

The review body must also include:

1. Reviewer public-context decision:
   - `Public context updated in this PR`
   - `No public context update needed`
   - `Durable contract or external decision needed`
2. Reviewer-confirmed QA disposition:
   - `Evidence sign-off`
   - `Targeted human QA`
   - `Maintainer-owned validation`
3. Exactly one merge-readiness verdict:
   - `Merge-readiness verdict: READY FOR HUMAN APPROVAL`
   - `Merge-readiness verdict: BLOCKED`

Do not add a second summary after the residual-risk section.

Use `BLOCKED` when findings, unresolved threads, policy conflicts, missing
evidence, or unsafe merge order prevent a clean handoff. Record unavailable
branch settings as a maintainer-owned residual. Block for settings only when an
acceptance or merge claim depends on them, or visible evidence conflicts with
the documented settings. Name unmet conditions in the review body without
duplicating the inline finding detail. Use `READY FOR HUMAN APPROVAL` only after
the complete adversarial pass is clean. This verdict does not replace human
approval.

## Mandatory Checks

- Durable buyer and merchant auth remains external-signer-only through NIP-07 or NIP-46
- A `guest_ephemeral` browser key is limited to one guest order and merchant. Store it only in same-tab session storage for recovery of up to 24 hours. Expose it only to signing the initial private order and same-order payment reports. It must never become an account key or nsec
- A revocable NIP-46 client connection key must use encrypted browser-local storage and must be deleted on logout. Store a CI client key only as a protected Actions environment secret. Use it only in a post-merge, main-only, expected-SHA-verified job behind a GitHub environment with required reviewers. Candidate-controlled code must never receive the CI key. Keep the browser key inside its client-session boundary. Neither client key is an account key or nsec
- Account nsecs, account private keys, and credential-shaped values must not appear in source, authored history, logs, or artifacts
- Order/message actions are signer-gated
- Payment flow remains non-custodial and does not introduce balance management
- No new behavioral tracking/profiling
- Shared package dependency boundaries preserved
- Telemetry/analytics changes preserve the privacy allowlist and do not add behavioral tracking
- Nostr-sensitive PRs cite `docs/knowledge/external-nostr-references.md` and the relevant public NIP or Open Markets working specification source
- Product listings remain NIP-99 plus the Open Markets working specification for `kind:30402` commerce events; flag alternate product-listing protocol assumptions
- NIP-17/private-message changes preserve NIP-59 seal/gift-wrap behavior, NIP-44 v2 compatibility, and source-gate NIP-44 v3 implementation behind public draft/client references and capability detection
- Relay changes distinguish NIP-65 `kind:10002` general relay preferences from NIP-17 `kind:10050` private-message relay hints
- New route-local NDK event construction, `giftWrap`, publish, unwrap/decrypt, relay planning, or event parsing is justified or moved behind `@conduit/core`
- Acceptance criteria are observable, use stable IDs, and map to evidence or an explicit gap
- Candidate-specific evidence matches the current head SHA
- Selected smoke shards include the named tests and do not report success with zero matching tests
- Test fidelity supports the claim; stubbed signers do not prove signatures, encryption, relay delivery, extension UX, or mobile handoff
- Critical-flow changes add or update Playwright or smoke coverage, or name the required manual QA
- Residual gaps and state-changing test cleanup are explicit
- `Evidence sign-off` is rejected for protocol, auth, payment, privacy, security, migration, secret, destructive-state, or release changes
- Reviewer does not require a new spec by default; useful public-safe knowledge notes may land with the implementation
- Durable contract or external decision work is reserved for behavior that genuinely needs stable public agreement before implementation

## Adversarial Merge-Readiness Pass

Do this pass for every ready pull request. Do not infer merge readiness from green
checks or a small visible diff.

- Inspect the complete merge-base-to-head diff and commit graph. Detect stacked
  pull requests, shared commits, merge commits, and unsafe merge, rebase, or
  squash outcomes.
- Inspect required-check conclusions and job conditions. Distinguish a job that
  ran from a skipped job that GitHub reports as successful. Follow aggregate
  checks to each required dependency.
- Inspect branch protection and allowed merge methods when access permits.
  Record unavailable settings as a maintainer-owned residual. Block only when
  an acceptance or merge claim depends on them, or visible evidence conflicts.
- Do not report a `repository_setting` blocker solely because branch protection
  does not require `agent-merge-readiness`; that context is advisory.
- Treat changed workflows, prompts, instructions, build scripts, and test
  selectors as candidate-controlled input. Identify which candidate code runs
  before or while a workflow can access credentials or write-capable tokens.
- Require privileged agent reviews to use the default-branch workflow and an
  immutable base checkout. Fetch the candidate head as Git object data only.
  Do not check out, install, import, or execute candidate content in that job.
- Bind automatic review handoffs to the exact source repository, pull request,
  base SHA, head SHA, workflow path, run, run attempt, and review provenance
  marker.
- Inspect unresolved review threads from all prior reviews. A later clean review
  does not supersede an unresolved actionable thread.
- Distinguish the source head SHA, synthetic merge SHA, base SHA, deployed SHA,
  and artifact SHA. Confirm that cited evidence tested the intended candidate.
- Verify each acceptance claim against the observed assertion, environment,
  signer, relay, payment, and deployment fidelity. A named test is not evidence
  that it ran or exercised the claimed boundary.
- Inspect the current tree, diff, and every pull-request-authored commit for
  secret material and credential-shaped fixtures. Include stacked or imported
  commits not reachable from the base. Block material newly introduced, copied,
  modified, or made reachable by the pull request. Report unchanged base-only
  fixtures as inherited residual debt unless the pull request touches them. Do
  not print a suspected secret. Explain how the configured merge method changes
  history exposure.
- For relay or distributed-state paths, test partial, unavailable, stale,
  conflicting, capped, and saturated reads. Distinguish attempted publish from
  relay acknowledgement. Check time-of-check/time-of-use gaps before irreversible
  actions.
- End with `What can still be wrong if all visible checks are green?` List
  concrete fidelity, environment, deployment, history, and operational gaps.

Do not issue a clean marker until this pass has no actionable finding and the
pull request has no unresolved review thread. A clean marker requires
`Merge-readiness verdict: READY FOR HUMAN APPROVAL`.

## Mandatory Automation Residual

Include this exact line once in each Sudden review body:

`Automation residual: The current Sudden action needs a narrow pull-request-write token to submit inline reviews; candidate prompt injection is not mechanically eliminated; schema and SHA gates fail malformed or stale results; human approval remains mandatory.`

## If No Findings

State explicitly: "No actionable findings." Then give the confirmed QA
disposition and list residual risks. Include
`What can still be wrong if all visible checks are green?` even when the answer
is limited to named residual verification gaps.
