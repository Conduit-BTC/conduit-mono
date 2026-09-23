# Conduit Monorepo Agent Guide

This public repository contains Market (`apps/market`), Merchant
(`apps/merchant`), the Store Builder shell (`apps/store-builder`),
shared protocol and persistence code (`packages/core`), and shared
controls (`packages/ui`). Read this file at startup. Read deeper
guidance when the task touches its boundary; use
[`docs/README.md`](docs/README.md) to find a document whose name is unknown.
Do not assume contributors have personal or machine-level agent rules.

## Work and authority

- For an answer, diagnosis, review, or plan, inspect and report without changing
  files or external state. For an authorized change, make the smallest complete
  scoped implementation, validate it, and report remaining gaps.
- Plan non-trivial work before editing. If internal work has a Linear issue and
  authenticated access, put the implementation plan there before or alongside
  the PR. Public contributors may put the plan in the PR. Keep private tracker
  links and planning text out of public commits, PRs, and tracked docs.
- Get explicit maintainer approval before merge, deployment, release, production
  changes, destructive operations, irreversible migrations, credential or access
  changes, spending, or material runtime dependency upgrades. An explicit
  request for the action counts as approval. Preserve unrelated work.
- Do not change `docs/ARCHITECTURE.md` or `docs/specs/*.md` without explicit
  maintainer approval. Read existing contracts when they apply; ordinary work
  does not require a new spec. Add public-safe knowledge notes only when useful.
- Keep prompts, credentials, private operations, customer data, and company
  planning out of this public repository. Do not print secrets in tool output.
  Publish only sanitized evidence and text.

## Task-specific reading

| Work                                                                                                                                       | Read before implementation                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI, shared controls, theme, accessibility                                                                                                  | [`docs/DESIGN.md`](docs/DESIGN.md); relevant app and `@conduit/ui` code                                                                                                                                                                                                                           |
| System boundary or broad data flow                                                                                                         | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the applicable existing spec                                                                                                                                                                                                                   |
| Nostr protocol, relay, signer, NDK, NIP-17/NIP-44/NIP-59 messaging, NWC/payment, signed-event cache/outbox, product identity or event code | [`docs/knowledge/decentralized-network-product-posture.md`](docs/knowledge/decentralized-network-product-posture.md), [`docs/knowledge/external-nostr-references.md`](docs/knowledge/external-nostr-references.md), the applicable existing spec, and the relevant public NIP/Open Markets source |
| Checkout, orders, wallet, or guest flow                                                                                                    | Applicable contracts under [`docs/specs/`](docs/specs/) and affected core/app implementation; also use the Nostr row when protocol, signed delivery, or payments change                                                                                                                           |
| Telemetry or smoke artifacts                                                                                                               | [`docs/analytics/events.md`](docs/analytics/events.md) and relevant test/CI rules                                                                                                                                                                                                                 |
| Dependencies, CI, PR, preview, or release                                                                                                  | [`CONTRIBUTING.md`](CONTRIBUTING.md), affected workflow/configuration, and release guidance there; inspect current gates before claiming status                                                                                                                                                   |
| Agent intake, dispatch, review, or hardening                                                                                               | [`docs/knowledge/agent-automation-boundary.md`](docs/knowledge/agent-automation-boundary.md), affected workflows, and `CONTRIBUTING.md` for PR evidence                                                                                                                                           |

Read only the rows the change actually touches. A route can cross several rows.
`docs/README.md` is a navigation aid, not another mandatory startup read.

## Trust and product boundaries

- Durable Nostr account signing uses external NIP-07 or NIP-46 signers. Apps
  must not generate, store, or derive account keys. The bounded guest-order key
  and isolated device-local Portable Wallet credential boundaries are distinct
  exceptions; neither creates a Nostr account. The device-owned `/wallet`
  surface works without a connected signer.
- Product listings use NIP-99 plus the Open Markets working specification for
  `kind:30402`, derived from the earlier GammaMarkets `market-spec`. Check public
  protocol authority before changing event meaning or canonical emission. Do
  not substitute local documentation for the relevant public source.
- A bounded relay read cannot prove global absence. Preserve evidence source,
  freshness, coverage, and stronger prior observations. Keep empty, partial,
  unavailable, stale, conflicting, and malformed states distinct. Require
  positive evidence for irreversible actions; do not let an unavailable source
  veto safe behavior solely because unknown negative evidence might exist.
- Keep relay planning, event parsing/emission, encryption, publishing, and
  signed-event persistence in shared `@conduit/core` boundaries. Routes compose
  workflows. Model ACK, rejection, timeout, and degraded state where decisions
  depend on them. A compatibility exception must be named, bounded, measured,
  repairable, and removable.
- NIP-17 messaging uses the public NIP-44 v2 baseline and NIP-59 wrapping.
  Keep v3 readiness visible, but require public draft/client references and
  explicit capability detection before implementation.
- Payments remain non-custodial. Do not turn cache, partial relay state, or
  advisory notifications into payment, settlement, fulfillment, or purchase
  authority. Preserve signed authority and exact order/fulfillment snapshots.
  Guest checkout must not require a guest inbox, self-copy, or reply channel.
- Telemetry is optional, allowlisted, aggregate, and content-free. Logs,
  diagnostics, smoke artifacts, and agent inputs must not expose pubkeys,
  npubs, nsecs, messages, ciphertext, order contents, invoices, payment hashes,
  addresses, contact details, IPs, fingerprints, signer connection strings,
  NWC URIs, wallet balances, recovery material, or provider credentials.

## Code, validation, and review

- Apps depend on `@conduit/core` and `@conduit/ui`; `@conduit/ui` may use core
  types and pure helpers, never core side effects. `@conduit/core` must not
  depend on UI or apps. Use shared UI primitives before adding app-local controls.
  Do not add Zustand, Jotai, Redux, or another global state library.
- Use Bun, TypeScript strict mode, double quotes, two-space indentation,
  `async`/`await`, and explicit error handling. Check existing implementations,
  dependency docs, and types before adding packages or custom code.
- Match validation to the changed boundary. Use focused tests and relevant
  typecheck, lint, build, telemetry, and smoke checks. Browser evidence is
  appropriate for UI work; stubbed signers do not prove cryptography or relay
  delivery. Inspect the final diff and distinguish local checks, CI, preview,
  human QA, release, and production observation.
- PRs target protected `main`, use Conventional Commit titles by default, and
  follow [`.github/pull_request_template.md`](.github/pull_request_template.md).
  Tie acceptance criteria to current-head evidence and name gaps. Human review
  remains required. Protocol, auth, payment, privacy, security, migration,
  secret, destructive-state, and release work needs maintainer-owned validation.
- Agent code-changing workflows require maintainer intent and a risk gate.
  High-risk work requires human-owned planning. Agent output never authorizes
  merge, release, or production changes.
