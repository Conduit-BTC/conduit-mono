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
- Payments are invoice generation only (no custody, no balance management).
- No Zustand/Jotai/Redux style state libraries. Use React Context + TanStack Query + Dexie patterns.

## Monorepo Boundaries

- Apps may depend on `@conduit/core` and `@conduit/ui`.
- `@conduit/ui` may depend on `@conduit/core`.
- `@conduit/core` must not depend on app code.
- Avoid circular dependencies.

## PR Review Expectations

When reviewing PRs:
- Flag issues with severity tags: `P0`, `P1`, `P2`.
- Include concrete file/line references.
- Focus comments on behavior impact and reproducible scenarios.
- Ask for tests where behavior changes are not covered.
- Keep comments concise and actionable.

## Reliability Checks (Orders/Messaging)

For Market and Merchant changes touching orders/messages:
- Verify signer connected-state gates all order/message actions.
- Verify relay lag/fallback does not produce ambiguous UI states.
- Verify polling and manual refresh do not create UI jitter loops.

## Suggested Validation Commands

```bash
bun run typecheck
bun run lint
bun test
```
