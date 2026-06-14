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
- Include a reviewer-owned context decision when relevant: `No docs follow-up needed`, `Docs-only PR after merge`, or `Docs/spec PR required before merge`.
- Treat broad docs/context updates as separate senior-reviewed docs PRs unless the current PR is explicitly a docs/spec PR.

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

## Context Follow-Up Checks

For implementation PRs, reviewers decide whether the merged work changes durable repo context. Agents may suggest possible docs drift, but they should not present autonomous context upgrades as required workflow.

- Use `Docs/spec PR required before merge` when product requirements, protocol behavior, shared UX rules, architecture, or cross-team implementation expectations changed before the repo contract was updated.
- Use `Docs-only PR after merge` when the implementation fits current contracts but reveals stale docs, missing agent routing, missing source references, or completed phase criteria.
- Use `No docs follow-up needed` when existing docs and Linear context remain sufficient.

## Suggested Validation Commands

```bash
bun run typecheck
bun run lint
bun run telemetry:check
bun test
bun run build # when shared packages, env/config, routing, or build output are affected
bun run test:e2e # when end-to-end smoke behavior is affected
```
