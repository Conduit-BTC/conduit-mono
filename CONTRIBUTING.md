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

### Planning and Specs

Conduit uses a combined Linear + docs workflow:

- Linear tracks execution, ownership, and status
- `docs/plans/*` tracks delivery scope and sequencing
- `docs/specs/*` tracks implementation requirements
- `docs/knowledge/*` holds supporting notes and references, not the final source of truth

If work changes product requirements, protocol behavior, shared UX rules, or cross-team implementation expectations:

1. Open the relevant docs/spec PR first.
2. Merge that PR to `main`.
3. Start the implementation `feat/*` branch only after the docs/spec change lands.

For UI and theming work, also check [docs/DESIGN.md](docs/DESIGN.md) before introducing new shared styles or tokens.

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
```

### Pull Requests

- Keep PRs focused on a single concern
- Use the repo PR template in `.github/pull_request_template.md`
- Write a clear description of what changed and why
- Link the relevant Linear issue
- If applicable, link the docs/spec PR that established the implementation contract
- Include a test plan (how to verify the changes work)
- PRs require review before merging to `main`
- PRs from forks may need a maintainer to approve GitHub Actions before CI runs

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
- `build-signet`
- `preview-links`

Direct Cloudflare Pages checks are useful preview signals, but they are not
required branch-protection gates because fork PRs cannot reliably produce them.
The `preview-links` job posts branch preview links for same-repository PRs and
skips preview comments for fork PRs with an explicit log message.

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

All relay data goes through TanStack Query hooks in `@conduit/core`:

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

- NWC-based Lightning invoicing (NIP-47)
- Invoice generation only — no balance management
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
├── protocol/       # NDK singleton, event builders
├── schemas/        # Zod validators
├── hooks/          # Shared React Query hooks
├── context/        # Auth context
├── db/             # Dexie database
└── utils/          # Formatters, helpers

packages/ui/src/
├── components/     # shadcn/ui + custom components
├── hooks/          # UI hooks (useViewport, etc.)
└── styles/         # CSS, theme tokens, typography
```

## Questions?

- Check [docs/README.md](docs/README.md) for the documentation map
- Check [ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design
- Check [DESIGN.md](docs/DESIGN.md) for shared design and theming guidance
- Check [docs/specs/](docs/specs/) for feature specifications
- Check [IMPLEMENTATION.md](docs/plans/IMPLEMENTATION.md) for build phases
