# Contributing to Conduit

## Getting Started

1. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/Conduit-BTC/conduit-mono.git
   cd conduit-mono
   bun install --frozen-lockfile
   ```

   The frozen install keeps the checked-in dependency graph intact and also
   installs the pre-commit hook that formats and lints staged files.

2. Read [README.md](README.md) for local dev setup (relay, env vars, seed data).

3. Read [AGENTS.md](AGENTS.md) for repository safeguards and task-specific
   reading. Use [docs/README.md](docs/README.md) to find deeper guidance.

## Development Workflow

### Branches

Create branches from `main` with short prefixes:

| Prefix      | Use                   |
| ----------- | --------------------- |
| `feat/`     | New features          |
| `fix/`      | Bug fixes             |
| `refactor/` | Code restructuring    |
| `docs/`     | Documentation only    |
| `chore/`    | Maintenance, deps, CI |

Examples: `feat/product-search`, `fix/invoice-qr-case`, `chore/upgrade-ndk`

### Specs and Repo Context

[AGENTS.md](AGENTS.md) sets the repository safeguards and reading routes;
[docs/README.md](docs/README.md) indexes public implementation context.
Read an applicable existing contract before changing its behavior. Ordinary
work does not require a new spec. Keep internal plans in the relevant private
tracker when one exists, and keep private links and text out of public PRs.

### Reviewer-Owned Context Check

Reviewers decide whether implementation work would benefit from public context
updates. This is not a mechanical documentation gate.

During review, mark one of:

- `Public context updated in this PR`
- `No public context update needed`
- `Durable contract or external decision needed`

Request a durable contract update when the behavior has broad or long-lived public implications. Do not block an otherwise complete implementation solely because it lacks a new spec document.

### Commits

- Use Conventional Commits for commit messages: `type(scope): description`
- Use the same convention for PR titles unless the PR follows an explicit release or sync naming rule

### Build Order

Packages have build dependencies. Always build in order:

```
@conduit/core -> @conduit/ui -> apps
```

The root `bun run build` handles this automatically. If building manually:

```bash
cd packages/core && bun run build
cd packages/ui && bun run build
cd apps/market && bun run build
```

### Formatting

CI checks Prettier formatting on changed files with `scripts/ci/prettier_changed.ts`.
The same helper is available locally:

```bash
bun run format:fix     # Format changed files
bun run format:check   # Check changed files without writing
```

If a PR fails the `format` check:

1. Pull or fetch the latest branch.
2. Run `bun run format:fix`.
3. Commit the formatting changes.
4. Push the branch again.

The format helper intentionally skips generated files, `bun.lock`, ignored build outputs,
and files under `context/`.

### Before Committing

```bash
bun run format:check # Must pass - no Prettier changes needed
bun run typecheck   # Must pass — no TS errors
bun run lint        # Must pass — no lint errors
bun test            # Must pass
bun run telemetry:check # Must pass when telemetry/analytics surfaces are affected
```

### Pull Requests

- Keep PRs focused on a single concern
- Use the repo PR template in `.github/pull_request_template.md`
- Write a clear description of what changed and why
- Keep private tracker links and planning context out of the public PR
- List the existing public implementation context checked and any public context changed with the code
- Include a test plan (how to verify the changes work)
- PRs require review before merging to `main`
- PRs from forks may need a maintainer to approve GitHub Actions before CI runs

### Acceptance Criteria, Evidence, and QA

Define stable acceptance criteria such as `AC-1` before implementation. Make
each criterion an observable success, failure, or regression-sensitive outcome.

Map every criterion to one evidence row in the pull request template. Include:

- the exact test or manual check;
- the environment and signer fidelity;
- a result tied to the current head SHA;
- any remaining gap and its owner.

Generic CI gate checkboxes are not behavioral evidence. Label evidence by its
actual layer:

- unit or contract;
- browser UI with a stubbed signer;
- browser integration with real local cryptography;
- local NIP-46 and relay integration;
- deployed preview;
- protected live canary;
- real extension, mobile signer, browser, or device QA.

A mock signer does not prove a valid signature or NIP-44 exchange. A local
adapter does not prove a third-party extension popup, mobile handoff, public
relay, or deployed-preview result.

For each critical flow change, add or update the matching Playwright or smoke
test. If that is not practical, state the uncovered criterion and require the
named manual QA. New or changed smoke tests must declare an explicit `@market`,
`@merchant`, or `@commerce` area. Use `@commerce` only for the hermetic
cross-app flow that requires both Market and Merchant, as defined in the
testing specification. Do not use title capitalization as test ownership.

The author proposes one review and QA disposition:

- **Evidence sign-off:** human code review is still required, but every
  criterion has deterministic current-head evidence and no separate product QA
  is needed.
- **Targeted human QA:** a person must complete the named visual, interaction,
  preview, signer, browser, or device checks.
- **Maintainer-owned validation:** a maintainer must own the plan for protocol,
  auth, payment, privacy, security, migration, secret, destructive-state, or
  release changes.

An author or agent cannot downgrade a high-risk change to evidence sign-off.
The reviewer confirms or raises the disposition. New commits invalidate prior
candidate-specific manual and preview evidence.

See [the automated smoke testing and pull request evidence specification](docs/specs/testing-e2e.md)
for the full confidence, signer, artifact, and selection contract.

### User-Reported Bugs

GitHub bug reports use `.github/ISSUE_TEMPLATE/bug_report.yml`, which applies
the `bug` and `user-reported` labels. Maintainers should triage these by:

1. Checking that no Nostr secret keys (`nsec`), signer connection URLs/codes,
   seed phrases, passwords, NWC connection strings, payment credentials, full
   shipping addresses, phone numbers, or other sensitive personal information
   were included.
2. Confirming the affected app, route, build, and shortest reproduction path.
3. Acknowledging valid reports so the community can see they entered the
   maintainer triage path, then closing duplicates or out-of-scope reports with
   a short note.

## CI and Preview Deploy Notes

### Cloudflare Pages projects

- Mainnet:
  - `conduit-market`
  - `conduit-merchant`
- Signet:
  - `conduit-market-signet`
  - `conduit-merchant-signet`

### Important setup constraints

- Signet projects must be Git-connected Pages projects. Direct Upload projects cannot be switched to Git source later.
- Configure build runtime vars on both preview + production configs:
  - `BUN_VERSION=1.3.5`
  - `NODE_VERSION=20`
- Without those vars, Cloudflare can fall back to `npm install`, which breaks Bun workspace installs.
- Public frontend behavior comes from `deploy/pages-profiles.json`, not Pages
  dashboard `VITE_*` feature toggles. A Pages Git build whose deployment URL
  belongs to a repo-owned Signet project derives `staging`; other non-`main`
  branches derive `preview`, and `main` derives `production`. An unknown or
  incomplete profile fails during Vite config loading.
- Pages build metadata and operator configuration remain part of the trusted
  release boundary. Dashboard `VITE_*` values do not directly resolve managed
  public feature state. CI builds the same explicit profile and checks each
  emitted `/.well-known/conduit-deployment.json` for the expected profile,
  source commit, feature value, and public-config digest. At runtime,
  compatibility routing fails closed if an official Shop or Sell host is not
  compiled as `production`, or a Signet Pages host is not compiled as
  `staging`; ordinary Pages previews keep their compiled preview behavior.

### Required checks before merge

Branch protection on `main` expects GitHub-owned CI gates to pass:

- `format`
- `pr-title`
- `lint`
- `typecheck`
- `test`
- `color-policy`
- `telemetry-policy`
- `e2e-smoke`
- `build-mainnet`
- `preview-links`

Direct Cloudflare Pages checks are useful preview signals, but they are not
required branch-protection gates because fork PRs cannot reliably produce them.
The `preview-links` job verifies branch preview links for same-repository PRs
and publishes them in the read-only job summary. It skips preview verification
for fork PRs with an explicit log message. PR comments require separate,
default-branch-controlled automation; candidate workflows do not receive a
write token. Bot-authored PRs receive a noncanonical preview check and cannot
satisfy the required `preview-links` context.

Account-authenticated agent workflows run outside this public repository.
The reviewer receives immutable source snapshots and no GitHub token. Trusted
delivery code validates inline locations and rechecks the PR base and head.
It submits actionable findings as resolvable inline review conversations.
Schema and SHA checks reject malformed or stale results. Human approval remains
mandatory; candidate prompt injection can still affect review quality.

Use an exact `/agent review` or `/agent simplify` PR comment for an advisory
rerun. Owners, members, and collaborators can use conversation or inline review
comments. Requests are polled and may be delayed. Automatic correctness review
runs for each eligible head. A clean correctness pass can start one automatic
Ponytail pass per PR; new heads do not rearm it after an attempt or failure.
See [Agent Automation Boundary](docs/knowledge/agent-automation-boundary.md).

The former `agent-review-handoff` workflow context is retired. Agent reviews
remain advisory and do not determine mergeability. Keep strict up-to-date branch
protection enabled so a base change invalidates candidate checks.

The final Ponytail review must state exactly one of `Ponytail outcome: LEAN`,
`Ponytail outcome: FINDINGS`, or `Ponytail outcome: DELIVERY BLOCKED`. `LEAN`
requires the exact `Lean already. Ship.` line and zero inline comments.
`FINDINGS` requires one or more actionable inline comments. `DELIVERY BLOCKED`
fails the workflow.

The required `e2e-smoke` check aggregates path-aware Market, Merchant, and
cross-app commerce Playwright shards. App-local changes keep their owning app
shard and add commerce when they affect the shared checkout, order, product,
messaging, relay, signer, or payment flow. Shared runtime changes and pushes to
`main` run every critical shard; docs-only changes skip browser installation.
Market runs in three single-worker jobs. Their project-aware discovery manifests
must combine to the complete Market selection with no missing or repeated tests.
Market browser fixtures use synthetic mainnet invoices so Spark wallet setup and
manual invoice handoff share a supported network; Commerce uses testnet.
The local `test:e2e`, `test:e2e:mobile`, and `test:e2e:webkit` commands run
each selected area with its own network and verify their discovered test union.
Use those commands for full runs; direct unscoped `playwright test` cannot
serve Market and Commerce with different Lightning networks.
Playwright area tags select the tests. CI rejects an untagged smoke test or a
selected area that contains zero tests.

## Code Conventions

### General

- Double quotes for strings
- 2-space indentation
- Async/await over `.then()` chains
- Explicit error handling at system boundaries

### React Components

```typescript
// Composition over configuration
// Use cn() for conditional classes
import { cn } from "@conduit/core"
import { Button } from "@conduit/ui"

interface ProductCardProps {
  product: Product
  className?: string
}

export function ProductCard({ product, className }: ProductCardProps) {
  return (
    <div className={cn("rounded-lg border p-4", className)}>
      {/* ... */}
    </div>
  )
}
```

### Data Fetching

Relay data should go through shared TanStack Query hooks or protocol helpers in `@conduit/core`. NDK remains an offline compatibility edge for signing, encryption, event construction, and explicit planned publishes; it is not a relay discovery or read API. Routes should not invent new relay fanout or source-resolution behavior when shared helpers already exist:

```typescript
import { useQuery } from "@tanstack/react-query"
import { getMarketplaceProducts } from "../protocol/commerce"

export function useProducts(limit = 60) {
  return useQuery({
    queryKey: ["products", { limit }],
    queryFn: async () => (await getMarketplaceProducts({ limit })).data,
    staleTime: 1000 * 60,
  })
}
```

### State Management

- **Server state**: TanStack Query (relay data, profiles, products)
- **Auth state**: React Context in `@conduit/core`
- **Local persistence**: Dexie (IndexedDB) for orders, messages, cache, wallet
  descriptors, and local provider credentials
- **Ephemeral UI state**: `useState` / `useReducer`
- **No state management library** (no Zustand, Redux, Jotai)

### Shared Code

- Types, schemas, and protocol logic go in `@conduit/core`
- UI components go in `@conduit/ui`
- App-specific components stay in the app's `components/` directory
- Never create circular dependencies between packages

For Nostr-sensitive changes, prefer deepening shared `@conduit/core` protocol modules over copying event construction, publish, unwrap/decrypt, relay planning, or parsing into routes.

## Protocol Constraints

These are non-negotiable across all code:

### Authentication

- Durable account signing uses external signers only (NIP-07, NIP-46)
- Do not generate, store, or manage a user's durable Nostr account private key.
  A bounded `guest_ephemeral` browser key may serve one guest order and merchant.
  Keep it only in same-tab session storage for recovery of up to 24 hours. Limit
  signing to the initial private order and same-order payment reports. It must
  never become an account key or nsec.
- A revocable NIP-46 client connection key must use encrypted browser-local
  storage and must be deleted on logout. Store a CI client key only as a
  protected Actions environment secret. Use it only in a post-merge, main-only,
  expected-SHA-verified job behind a GitHub environment with required reviewers.
  Candidate-controlled code must never receive the CI key. Keep the browser key
  inside its client-session boundary. Neither client key is an account key or
  nsec. Do not place either key in source fixtures, logs, or artifacts.
- Identity = pubkey only
- Portable Wallet recovery material is a separate, device-local credential
  boundary governed by [the wallets specification](docs/specs/wallets.md); it
  does not permit Nostr account-key custody

### Privacy

- **No** behavioral tracking or person profiling
- **No** message-content collection by product telemetry
- Explicit, privacy-constrained operational events only; see
  `docs/analytics/events.md`
- Treat browsers, counterparties, relays, wallets, signers, merchant-selected
  services, and Conduit-operated supporting endpoints as distinct data
  boundaries. Do not claim all data stays on one device or only on relays.
- Wallet credentials, recovery material, invoices, payment content, selected
  wallet instance IDs, and wallet balances must not enter logs or telemetry

### Payments

- Non-custodial Lightning through Portable Wallets, NWC/WebLN payment rails,
  invoices, and payment proofs
- Client code may display and manage device-local Portable Wallet balances
  through the documented provider boundary
- No fund custody

## File Organization

```
app/src/
├── routes/         # TanStack Router file-based routes
├── components/     # App-specific components
├── hooks/          # App-specific hooks
└── lib/            # Query client, guards, utilities

packages/core/src/
├── types/          # TypeScript interfaces
├── protocol/       # Nostr client helpers, event builders
├── schemas/        # Zod validators
├── hooks/          # Shared React Query hooks
├── context/        # Auth context
├── db/             # Dexie database
└── utils/          # Formatters, helpers

packages/ui/src/
├── components/     # shadcn/ui + custom components
└── styles/         # CSS, theme tokens, typography
```

## Questions?

- Check [docs/README.md](docs/README.md) for the documentation map
- Check [ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design
- Check [DESIGN.md](docs/DESIGN.md) for shared design and theming guidance
- Check existing [docs/specs/](docs/specs/) when a durable feature contract applies
