# Claude Instructions - Conduit Monorepo

## Project Context

This is the Conduit monorepo - a decentralized Nostr-based commerce platform. See AGENTS.md for project overview and tech stack.

## Documentation

- **Docs Index**: `docs/README.md` - Documentation layout and source-of-truth rules
- **Architecture**: `docs/ARCHITECTURE.md` - System diagrams, protocol, data flow
- **Design**: `docs/DESIGN.md` - Shared design system and theming guidance
- **Specs**: `docs/specs/*.md` - Feature specifications

## Before Starting Implementation

1. Read `docs/README.md` to understand which docs are authoritative.
2. Read the relevant `docs/specs/*.md` before changing feature or protocol behavior.
3. For UI/theming work, read `docs/DESIGN.md` before introducing shared style values or tokens.
4. If the work changes product requirements, protocol behavior, or shared implementation expectations, update the relevant contract in the implementation PR before merge and keep contract and code aligned.
5. Use `@conduit/core` Zod schemas for validation. Interop parsing stays best-effort, but shared contracts should be reflected in repo docs first.
6. For Nostr protocol, relay, signer, messaging, payment, product-event, cache, or outbox work, read `docs/knowledge/external-nostr-references.md` and the relevant public NIP/GammaMarkets source before implementation.

Product strategy, ticket status, ownership, sequencing, private commercial plans, and private operating context live outside this public repository.

Reviewer-owned contract check:

- Implementation PRs should separate contract changes from implementation changes in the PR description.
- Reviewers block merge when a required contract is missing or disagrees with the implementation, not because it was not pre-merged on another branch.
- Reviewer decisions are `Contract updated in this PR`, `No contract change needed`, `Follow-up docs cleanup`, or `External/architecture decision required before merge`.
- Draft docs-only follow-up PRs only when a reviewer or maintainer asks.

## UI Component Rules

- Use shadcn-style primitives through `@conduit/ui` before adding app-local controls.
- Do not hand-roll native `<select>`, custom listboxes/comboboxes, dialogs, dropdowns, tabs, sheets, or textareas in app routes when `@conduit/ui` already provides the primitive.
- If a common primitive is missing, add it to `packages/ui/src/components`, export it from `@conduit/ui`, and consume it from apps.
- Keep route files focused on workflow composition and state. Shared keyboard behavior, focus management, overlay behavior, and reusable control styling belong in `@conduit/ui`.
- If an exception is intentional, document the reason and expected follow-up in the PR description.

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

- Non-custodial Lightning payment requests, NWC/WebLN payment rails, and payment proofs
- No balance management
- No refund processing in-app

## Nostr Event Handling

### Event Kinds Reference

```typescript
// packages/core/src/protocol/kinds.ts
export const EVENT_KINDS = {
  PROFILE: 0, // User metadata (NIP-01)
  DM_LEGACY: 4, // Encrypted DM legacy (NIP-04)
  DELETION: 5, // Event deletion (NIP-09)
  ZAP_REQUEST: 9734, // Zap request (NIP-57)
  ZAP_RECEIPT: 9735, // Zap receipt (NIP-57)
  RELAY_LIST: 10002, // Relay list (NIP-65)
  DM_GIFT_WRAP: 1059, // NIP-17 gift wrap
  PRODUCT: 30402, // Product listing (NIP-99 + GammaMarkets `market-spec`)
} as const
```

### Nostr Client Usage

NDK is the current edge library used by shared protocol helpers in `packages/core`. Apps should prefer shared `@conduit/core` hooks/helpers over direct route-local NDK calls:

```typescript
import { getNdk, connectNdk } from "@conduit/core/protocol"
```

Current work may continue using NDK where it is the established repo pattern. For new relay-heavy, source-aware, or performance-critical behavior, call out in the PR if NDK appears to constrain the design and a shared adapter boundary should be considered. Do not introduce a broad custom relay substrate without an accepted architecture spec.

Product listings are NIP-99 + GammaMarkets `kind:30402`. Do not introduce alternate product-listing protocol terminology, schemas, or assumptions. NIP-17 private-message work uses NIP-59 seals/gift wraps and NIP-44 v2 as the current public encryption version. Any newer encryption-version implementation must be source-gated by public draft/client references and explicit capability discovery.

New `giftWrap`, publish, unwrap/decrypt, relay planning, event parsing, and source-resolution behavior should live behind `@conduit/core` unless the PR documents why route-local code is unavoidable.

## Shared Packages

### @conduit/core

- `types/` - TypeScript interfaces (Product, Order, Profile, etc)
- `protocol/` - Nostr client helpers, event builders, relay utilities
- `schemas/` - Zod validators for Nostr events
- `utils/` - formatPrice, formatPubkey, cn()

### @conduit/ui

- `components/` - Button, Card, Dialog, Form, etc
- `styles/` - Tailwind config, theme tokens

## Tech Stack

| Layer        | Choice                                            |
| ------------ | ------------------------------------------------- |
| Runtime      | Bun                                               |
| Build        | Vite 6 + SWC                                      |
| Framework    | React 19                                          |
| Routing      | TanStack Router                                   |
| Server State | TanStack Query over shared Nostr protocol helpers |
| Client State | React Context (auth only)                         |
| Persistence  | localStorage (cart, preferences)                  |
| Database     | Dexie (IndexedDB) - orders, messages, cache       |
| Forms        | react-hook-form + Zod                             |
| Validation   | Zod schemas in `@conduit/core`                    |
| UI           | shadcn/ui + Tailwind                              |
| Analytics    | Privacy-constrained optional telemetry only       |

**No state management library.** TanStack Query handles all relay data. Dexie handles local persistence.

## Current Operational Notes

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

Use `CONTRIBUTING.md` and `.github/workflows/ci.yml` as the canonical merge-check sources. Current GitHub-owned gates include changed-file format, PR title, lint, typecheck, test, color policy, telemetry policy, E2E smoke, the mainnet build, and preview-link automation. Direct Cloudflare Pages checks are useful signals, but they are not branch-protection gates because fork PRs cannot reliably produce them.

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
- Use Conventional Commits for commit messages and PR titles: `type(scope): description`
- Use `.github/pull_request_template.md` for PRs

### Packages

- Build order matters: core → ui → apps
- Never create circular dependencies
- Run `bun run typecheck` before committing

### Context Files

- `context/` is gitignored - ephemeral only
- Permanent source-of-truth docs live in `docs/`
- `docs/specs/` is authoritative for feature and protocol requirements
- `docs/knowledge/` is for supporting notes and references, not final implementation contracts
- Meeting notes stay in context/

## Public Repo Posture

Treat `conduit-mono` as a public client/shared-code repository.

When writing commit messages, PR descriptions, or tracked public-facing docs:

- treat this repo as a public-facing client/shared-code repo
- keep repo-scope language aligned with the actual monorepo contents
- avoid internal company-planning framing

Prefer language centered on:

- Market
- Merchant
- Store Builder
- shared packages
- protocol/spec implementation
- trust/provenance and contributor-safe engineering context

If discussing separate repositories, keep them distinct from the current `conduit-mono` scope unless the repo structure has actually changed.

Private company context belongs in private planning or `context/`, not in tracked public history, unless explicitly requested.

## References

- Existing repos (for patterns only, not merging):
  - `/Users/dylangolow/workspace/CONDUIT/conduit-market-client`
  - `/Users/dylangolow/workspace/CONDUIT/merchant-portal`
- GitHub: https://github.com/Conduit-BTC
