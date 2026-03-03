# Claude Instructions - Conduit Monorepo

## Project Context

This is the Conduit monorepo - a decentralized Nostr-based commerce platform. See AGENTS.md for project overview and tech stack.

## Planning Documents

- **Architecture**: `docs/ARCHITECTURE.md` - System diagrams, protocol, data flow
- **Roadmap**: `docs/plans/ROADMAP.md` - Strategic epochs (no checkboxes)
- **Implementation**: `docs/plans/IMPLEMENTATION.md` - Build phases with deliverables (checkboxes)
- **Specs**: `docs/specs/*.md` - Feature specifications

## Before Starting Implementation

Review `docs/plans/IMPLEMENTATION.md` Phase 0:
- Extract protocol schemas from legacy repos
- Extract design tokens from legacy/Figma
- Use `@conduit/core` Zod schemas for validation (spec-first; interop parsing is best-effort)

## Critical Protocol Constraints

### Authentication
- External signers ONLY (NIP-07, NIP-46)
- NO key generation, custody, or storage in apps
- Merchant/buyer identity = pubkey only

### Privacy
- NO behavioral tracking or profiling
- NO message content inspection
- System metrics only (relay success, load times)
- All user data stays on user's device or relays

### Payments
- NWC-based Lightning (no custody)
- Invoice generation, not balance management
- No refund processing in-app

## Nostr Event Handling

### Event Kinds Reference
```typescript
// packages/core/src/protocol/kinds.ts
export const EVENT_KINDS = {
  PROFILE: 0,              // User metadata (NIP-01)
  DM_LEGACY: 4,            // Encrypted DM legacy (NIP-04)
  DELETION: 5,             // Event deletion (NIP-09)
  ZAP_REQUEST: 9734,       // Zap request (NIP-57)
  ZAP_RECEIPT: 9735,       // Zap receipt (NIP-57)
  RELAY_LIST: 10002,       // Relay list (NIP-65)
  DM_GIFT_WRAP: 1059,      // NIP-17 gift wrap
  PRODUCT: 30402,          // Product listing (NIP-99 + GammaMarkets `market-spec`)
} as const
```

### NDK Usage
NDK singleton lives in `packages/core`. Apps import and use:
```typescript
import { getNdk, connectNdk } from "@conduit/core/protocol"
```

## Shared Packages

### @conduit/core
- `types/` - TypeScript interfaces (Product, Order, Profile, etc)
- `protocol/` - NDK service, event builders, relay utilities
- `schemas/` - Zod validators for Nostr events
- `utils/` - formatPrice, formatPubkey, cn()

### @conduit/ui
- `components/` - Button, Card, Dialog, Form, etc
- `hooks/` - useViewport, useBreakpoint
- `styles/` - Tailwind config, theme tokens

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Bun |
| Build | Vite 6 + SWC |
| Framework | React 19 |
| Routing | TanStack Router |
| Server State | TanStack Query + NDK |
| Client State | React Context (auth only) |
| Persistence | localStorage (cart, preferences) |
| Database | Dexie (IndexedDB) - orders, messages, cache |
| Forms | react-hook-form + Zod |
| Validation | Zod schemas in `@conduit/core` |
| UI | shadcn/ui + Tailwind |
| Analytics | Plausible + PostHog (privacy configured) |

**No state management library.** TanStack Query handles all relay data. Dexie handles local persistence.

## Current Operational Notes (March 2026)

### Cloudflare Pages projects
- Mainnet projects:
  - `conduit-market` (branch domain suffix: `conduit-market-coo.pages.dev`)
  - `conduit-merchant` (branch domain suffix: `conduit-merchant-33n.pages.dev`)
- Signet projects:
  - `conduit-market-signet`
  - `conduit-merchant-signet`

### Cloudflare preview/deploy gotchas
- Signet projects must be Git-connected Pages projects (`source.type = "github"`), not Direct Upload projects.
- Direct Upload projects cannot be converted to Git source (`8000069` API error). Recreate if needed.
- Keep `BUN_VERSION=1.3.5` and `NODE_VERSION=20` in both preview + production deployment configs.
- If those env vars are missing, Cloudflare may run `npm install` and fail on Bun workspaces (`workspace:*`).
- Cloudflare PR comments are authored by `cloudflare-workers-and-pages[bot]` (note `[bot]` suffix).

### GitHub CI / merge checks
- Required checks on `main` currently include:
  - `lint`, `typecheck`, `test`, `build-signet`, `preview-links`
  - `Cloudflare Pages: conduit-market`
  - `Cloudflare Pages: conduit-merchant`
  - `Cloudflare Pages: conduit-market-signet`
  - `Cloudflare Pages: conduit-merchant-signet`
- `preview-links` is expected to proceed once Cloudflare checks are complete, even if some URL comments arrive late.

### Orders auth gate behavior
- Market and Merchant orders pages should only fetch/show conversations when:
  - `status === "connected"` and `pubkey` is present.
- Do not rely on persisted pubkey alone for gated views.
- Orders polling interval is tuned to `30_000` ms with manual refresh available.

### Refresh button behavior
- Orders refresh uses Lucide `RefreshCw` on the left.
- During refresh: icon spins and pulses.
- State text transitions: `Refresh` -> `Refreshing...` -> `Updated`.

## Code Patterns

### Query Hook Pattern
```typescript
// packages/core/src/hooks/useProducts.ts
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

### Auth Context Pattern
```typescript
// packages/core/src/context/AuthContext.tsx
export function AuthProvider({ children }) {
  const [pubkey, setPubkey] = useState<string | null>(null)
  const connect = async () => {
    const pk = await window.nostr.getPublicKey()
    setPubkey(pk)
  }
  return (
    <AuthContext.Provider value={{ pubkey, connect, disconnect: () => setPubkey(null) }}>
      {children}
    </AuthContext.Provider>
  )
}
```

### Component Pattern
```typescript
// Prefer composition over configuration
import { cn } from "@conduit/core/utils"
import { Button } from "@conduit/ui"

export function ProductCard({ product, className }: ProductCardProps) {
  return (
    <div className={cn("rounded-lg border p-4", className)}>
      {/* ... */}
    </div>
  )
}
```

## Safety Rules

### Git
- Never force push to main
- Use `git restore --staged` not `git reset`
- Confirm before any destructive action

### Packages
- Build order matters: core → ui → apps
- Never create circular dependencies
- Run `bun run typecheck` before committing

### Context Files
- `context/` is gitignored - ephemeral only
- Permanent docs go in `docs/specs/`
- Meeting notes stay in context/

## References

- Existing repos (for patterns only, not merging):
  - `/Users/dylangolow/workspace/CONDUIT/conduit-market-client`
  - `/Users/dylangolow/workspace/CONDUIT/merchant-portal`
- GitHub: https://github.com/Conduit-BTC
