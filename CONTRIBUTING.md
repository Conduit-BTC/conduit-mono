# Contributing to Conduit

## Getting Started

1. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/Conduit-BTC/conduit-mono.git
   cd conduit-mono
   bun install
   ```

   `bun install` also installs the pre-commit hook that formats and lints staged files.

2. Read [README.md](README.md) for local dev setup (relay, env vars, seed data).

3. Read [docs/README.md](docs/README.md) for the docs layout and source-of-truth rules.

4. Read [ARCHITECTURE.md](docs/ARCHITECTURE.md) to understand the system.

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

Public `conduit-mono` docs provide implementation context for the code in this repository:

- `docs/specs/*` holds durable implementation contracts where one is maintained
- `docs/ARCHITECTURE.md` tracks system boundaries, protocol surfaces, and data flow
- `docs/DESIGN.md` tracks shared visual and UI-system guidance
- `docs/knowledge/*` holds public-safe implementation notes, research, interoperability references, and reusable agent context

Product strategy, ticket sequencing, ownership, private commercial plans, and private operating context live outside this public repository.

For non-trivial internal work, prefer Plan mode and post the concise implementation and validation plan as a comment on the Linear issue before or alongside opening the implementation PR. Keep private tracker links and planning text out of the public PR. Public contributors without Linear access may put their implementation plan in the PR description.

Read existing specs when they apply, but do not create or update a spec for ordinary implementation work by default. Include public-safe `docs/knowledge/*.md` notes with the implementation when they will materially help future agents or contributors. Update a durable spec, architecture, or design contract when a maintainer requests it or the change genuinely requires one.

For UI and theming work, also check [docs/DESIGN.md](docs/DESIGN.md) before introducing new shared styles or tokens.

For Nostr protocol, relay, signer, messaging, payment, product-event, cache, or outbox work, also check [external-nostr-references.md](docs/knowledge/external-nostr-references.md) and the relevant public NIP or GammaMarkets source before implementation. Product listings are NIP-99 + GammaMarkets `kind:30402`; do not introduce alternate product-listing protocol terminology, schemas, or assumptions.

### Reviewer-Owned Context Check

Reviewers decide whether implementation work would benefit from public context updates. This is not a mechanical documentation gate.

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
The `preview-links` job posts branch preview links for same-repository PRs and
skips preview comments for fork PRs with an explicit log message.

The required `e2e-smoke` check aggregates path-aware Market and Merchant
Playwright shards. App-local changes run only that app's shard, shared runtime
changes run both, docs-only changes skip browser installation, and pushes to
`main` run both shards.

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

Relay data should go through shared TanStack Query hooks or protocol helpers in `@conduit/core`. NDK is the current edge library, but routes should not invent new relay fanout or source-resolution behavior when shared helpers already exist:

```typescript
import { useQuery } from "@tanstack/react-query"
import { getNdk } from "../protocol/ndk"

export function useProducts(filters?: ProductFilters) {
  return useQuery({
    queryKey: ["products", filters],
    queryFn: async () => {
      const ndk = getNdk()
      const events = await ndk.fetchEvents({ kinds: [30402], ...filters })
      return Array.from(events).map(parseProduct)
    },
    staleTime: 1000 * 60,
  })
}
```

### State Management

- **Server state**: TanStack Query (relay data, profiles, products)
- **Auth state**: React Context in `@conduit/core`
- **Local persistence**: Dexie (IndexedDB) for orders, messages, cache
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

- External signers only (NIP-07, NIP-46)
- **Never** generate, store, or manage private keys in app code
- Identity = pubkey only

### Privacy

- **No** behavioral tracking or profiling
- **No** message content inspection
- System metrics only (relay success rates, load times)
- All user data stays on the user's device or their relays

### Payments

- Non-custodial Lightning payment requests, NWC/WebLN payment rails, and payment proofs
- No balance management
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
