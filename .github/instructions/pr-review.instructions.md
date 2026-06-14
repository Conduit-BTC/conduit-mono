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
3. Short summary only after findings

## Mandatory Checks

- Auth flow remains external-signer-only
- Order/message actions are signer-gated
- Payment flow remains non-custodial and does not introduce balance management
- No new behavioral tracking/profiling
- Shared package dependency boundaries preserved
- Telemetry/analytics changes preserve the privacy allowlist and do not add behavioral tracking
- Nostr-sensitive PRs cite `docs/knowledge/external-nostr-references.md` and the relevant public NIP or GammaMarkets `market-spec`
- Product listings remain NIP-99 + GammaMarkets `kind:30402`; flag alternate product-listing protocol assumptions
- NIP-17/private-message changes preserve NIP-59 seal/gift-wrap behavior, NIP-44 v2 compatibility, and source-gate NIP-44 v3 implementation behind public draft/client references and capability detection
- Relay changes distinguish NIP-65 `kind:10002` general relay preferences from NIP-17 `kind:10050` private-message relay hints
- New route-local NDK event construction, `giftWrap`, publish, unwrap/decrypt, relay planning, or event parsing is justified or moved behind `@conduit/core`

## If No Findings

State explicitly: "No blocking findings." Then list any residual risks (for example, untested relay failure scenarios).
