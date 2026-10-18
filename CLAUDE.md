# Claude Instructions - Conduit Monorepo

Read [AGENTS.md](AGENTS.md) for repository authority, task-specific references,
implementation discipline, trust boundaries, validation, and PR requirements.
Follow its task routing; read additional documents only when the task touches
that boundary. These rules apply without personal or machine-level instructions.

## Sources of truth

- Versions, dependencies, and commands: relevant `package.json` and `bun.lock`.
- Existing implementations and types: affected app and shared-package code.
- Documentation discovery: [docs/README.md](docs/README.md) when the applicable
  document is unknown. Existing contracts apply; ordinary implementation does
  not require a new spec or a separate docs PR.
- UI and theming: [docs/DESIGN.md](docs/DESIGN.md). Compose `@conduit/ui`
  primitives; keep interaction behavior and reusable styling in the shared owner.
- Protocol and wallet authority: applicable contracts under
  [docs/specs/](docs/specs/), plus the public sources required by `AGENTS.md`.
  Preserve the distinct account, separate-origin signer, guest-order, NIP-46
  client-key, and Portable Wallet boundaries; do not replace them with a blanket
  signer or custody rule.
- CI, previews, and release checks: [CONTRIBUTING.md](CONTRIBUTING.md), affected
  workflows/configuration, and relevant operator guidance. Never infer deployment
  or production approval from a local check or passing CI.

## Reviews and public context

Use [.github/instructions/pr-review.instructions.md](.github/instructions/pr-review.instructions.md)
for automated reviews, including trusted-source handling, scope, and delivery.
Use [.github/pull_request_template.md](.github/pull_request_template.md) for PRs.
Reviewers decide whether public context needs updating; a new spec is not a
routine merge gate. Keep private planning, credentials, operations, customer data,
and machine-specific paths out of public history.
