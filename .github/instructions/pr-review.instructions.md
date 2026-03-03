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
- Payment flow remains non-custodial
- No new behavioral tracking/profiling
- Shared package dependency boundaries preserved

## If No Findings

State explicitly: "No blocking findings." Then list any residual risks (for example, untested relay failure scenarios).
