# Contributing to Conduit

## Getting Started

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/conduit-btc/conduit-mono.git
   cd conduit-mono
   bun install
   ```

2. Read [README.md](README.md) for local dev setup (relay, env vars, seed data).

3. Read [ARCHITECTURE.md](docs/ARCHITECTURE.md) to understand the system.

## Development Workflow

### Branches

Create branches from `main` with short prefixes:

| Prefix | Use |
|--------|-----|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `refactor/` | Code restructuring |
| `docs/` | Documentation only |
| `chore/` | Maintenance, deps, CI |

Examples: `feat/product-search`, `fix/invoice-qr-case`, `chore/upgrade-ndk`

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

### Before Committing

```bash
bun run typecheck   # Must pass — no TS errors
bun run lint        # Must pass — no lint errors
bun test            # Must pass
```

### Pull Requests

- Keep PRs focused on a single concern
- Write a clear description of what changed and why
- Include a test plan (how to verify the changes work)
- PRs require review before merging to `main`

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

- Check [ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design
- Check [docs/specs/](docs/specs/) for feature specifications
- Check [IMPLEMENTATION.md](docs/plans/IMPLEMENTATION.md) for build phases
