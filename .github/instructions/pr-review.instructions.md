# PR Review Instructions

Apply these instructions when generating pull request reviews.

## What To Optimize For

- Catch behavioral regressions first
- Enforce protocol and privacy constraints
- Identify missing tests and weak failure handling

## Required Review Output Format

1. Findings first, ordered by severity (`P0`, `P1`, `P2`)
2. Each finding includes:
   - one-sentence impact statement
   - file path and line reference
   - concrete recommendation
3. Reviewer public-context decision:
   - `Public context updated in this PR`
   - `No public context update needed`
   - `Durable contract or external decision needed`
4. Reviewer-confirmed QA disposition:
   - `Evidence sign-off`
   - `Targeted human QA`
   - `Maintainer-owned validation`
5. Short summary only after findings

## Mandatory Checks

- User auth flow remains external-signer-only; any service-signer exception must be explicitly documented and narrowly scoped in durable public guidance
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

## If No Findings

State explicitly: "No actionable findings." Then give the confirmed QA
disposition and list residual risks, such as untested relay failure scenarios.
