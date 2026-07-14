# Copilot Instructions - Conduit Monorepo

Use this guidance for code generation and PR review comments in this repository.

## Core Review Priorities

Prioritize in this order:

1. Functional correctness and regressions
2. Protocol/auth/privacy/payments constraints
3. Reliability and failure-mode handling
4. Test coverage and verifiability
5. Code style and maintainability

## Non-Negotiable Constraints

- External signer auth only (NIP-07, NIP-46). Never generate or store private keys.
- No behavioral tracking or profiling.
- No message content inspection.
- Payments are non-custodial Lightning payment requests, NWC/WebLN payment rails, and payment proofs. No custody or balance management.
- No Zustand/Jotai/Redux style state libraries. Use React Context + TanStack Query + Dexie patterns.

## Monorepo Boundaries

- Apps may depend on `@conduit/core` and `@conduit/ui`.
- `@conduit/ui` should not depend on `@conduit/core`; it provides reusable components, styles, and interaction primitives.
- `@conduit/core` must not depend on app code.
- Avoid circular dependencies.

## PR Review Expectations

When reviewing PRs:

- Flag issues with severity tags: `P0`, `P1`, `P2`.
- Include concrete file/line references.
- Focus comments on behavior impact and reproducible scenarios.
- Ask for tests where behavior changes are not covered.
- Keep comments concise and actionable.
- Include a reviewer-owned public-context decision when relevant: `Public context updated in this PR`, `No public context update needed`, or `Durable contract or external decision needed`.
- Do not require a new spec document by default; request durable contract work only when the behavior genuinely needs stable public agreement.

## Reliability Checks (Orders/Messaging)

For Market and Merchant changes touching orders/messages:

- Verify signer connected-state gates all order/message actions.
- Verify relay lag/fallback does not produce ambiguous UI states.
- Verify polling and manual refresh do not create UI jitter loops.

## Nostr-Sensitive Checks

For changes touching Nostr protocol, relay behavior, NDK usage, products/listings, private messages, signer auth, NWC/payments, local cache, or commerce outbox:

- Verify the PR cites `docs/knowledge/external-nostr-references.md` plus the relevant NIP or GammaMarkets `market-spec`.
- Verify product listings remain NIP-99 + GammaMarkets `kind:30402`; flag alternate product-listing protocol terminology or schema assumptions.
- Verify relay behavior models partial reads, publish ACK/reject/timeout, stale/degraded state, and source disagreement where relevant.
- Verify NIP-17 messaging uses NIP-59 seals/gift wraps and NIP-44 v2 as the current public encryption baseline; NIP-44 v3 readiness should remain visible, but v3 implementation must be source-gated by public draft/client references and explicit capability discovery.
- Verify kind `10050` private-message relay hints are not confused with general NIP-65 `kind:10002` relay preferences when DM routing is in scope.
- Flag new route-local NDK event construction, `giftWrap`, publish, unwrap/decrypt, relay planning, or event parsing unless the PR explains why it cannot live behind `@conduit/core`.
- Verify diagnostics/logs/telemetry do not include plaintext, ciphertext, invoices, order contents, addresses, signer secrets, NWC URIs, or message bodies.

## Agent Automation Checks

For changes touching agent automation, telemetry, or smoke-test artifacts:

- Keep public repo content sanitized and public-safe.
- Keep Linear, Slack, Cloudflare, telemetry backend, credential, and release-runbook details out of public tracked files.
- Verify telemetry properties match `docs/analytics/events.md`.
- Verify code-changing agent paths require maintainer intent and do not run for high-risk protocol/auth/payment/privacy work without human planning.

## Planning and Context Checks

For non-trivial internal implementation work, the plan belongs on the Linear issue while private tracker context stays out of the public PR. Public PR descriptions should identify the existing repo context checked and any public-safe context changed with the code.

- Use `Public context updated in this PR` when a public-safe knowledge note or durable contract changed with the implementation.
- Use `No public context update needed` when the code and tests are sufficient.
- Use `Durable contract or external decision needed` only when stable public agreement is a genuine implementation blocker.
- Useful `docs/knowledge/*.md` notes may land with the implementation; a new spec is not a default merge gate.

## Suggested Validation Commands

```bash
bun run typecheck
bun run lint
bun run telemetry:check
bun test
bun run build # when shared packages, env/config, routing, or build output are affected
bun run test:e2e # when end-to-end smoke behavior is affected
```
