# Conduit Monorepo

## Project Overview

Conduit is a decentralized commerce platform built on Nostr protocol. This monorepo contains three applications sharing common infrastructure:

- **Market** (`apps/market`) - Buyer-facing marketplace for product discovery and purchase
- **Merchant Portal** (`apps/merchant`) - Seller dashboard for product management, orders, and communications
- **Store Builder** (`apps/store-builder`) - Placeholder app for future standalone merchant storefront work

## Architecture

### Monorepo Structure

```
conduit-mono/
├── apps/
│   ├── market/           # Buyer marketplace
│   ├── merchant/         # Seller dashboard
│   └── store-builder/    # Future storefront placeholder
├── packages/
│   ├── core/             # Types, protocol, schemas, utilities
│   └── ui/               # Shared React components
├── docs/
│   ├── README.md         # Docs index and source-of-truth guide
│   ├── DESIGN.md         # Shared design system and theming guidance
│   ├── plans/            # ROADMAP.md, IMPLEMENTATION.md
│   ├── specs/            # Feature specifications
│   └── knowledge/        # Supporting notes and references
└── context/              # Ephemeral files (gitignored)
```

### Tech Stack

| Layer        | Technology                                                         |
| ------------ | ------------------------------------------------------------------ |
| Runtime      | Bun                                                                |
| Build        | Vite 6 + SWC                                                       |
| Framework    | React 19                                                           |
| Routing      | TanStack Router (file-based, type-safe)                            |
| Server State | TanStack Query over shared Nostr protocol helpers                  |
| Client State | React Context (auth only)                                          |
| Persistence  | localStorage (cart, preferences)                                   |
| Database     | Dexie (IndexedDB) for orders, messages, cache                      |
| UI           | shadcn/ui + Tailwind CSS                                           |
| Forms        | react-hook-form + Zod                                              |
| Validation   | Zod schemas in `@conduit/core`                                     |
| Protocol     | Nostr via `@conduit/core` helpers; NDK is the current edge library |
| Analytics    | Privacy-constrained optional telemetry only                        |

**No Zustand. No Jotai. No state management library.**

### Nostr Protocol

Core event kinds used:

- **Kind 0** - User profile metadata
- **Kind 5** - Event deletion (NIP-09)
- **Kind 10002** - Relay list (NIP-65)
- **Kind 30402** - Product listings (NIP-99 + GammaMarkets `market-spec`)

Authentication: External signers only (NIP-07, NIP-46). No key custody.
Messaging: NIP-17 encrypted DMs for buyer-merchant communication.
Payments: NWC-based Lightning payments (NIP-47).

Nostr-sensitive work must read `docs/knowledge/external-nostr-references.md` and the relevant public NIP/GammaMarkets source before coding. Product listings are NIP-99 + GammaMarkets `kind:30402`; do not introduce alternate product-listing protocol terminology, schemas, or assumptions.

## Session Workflow

1. **Start**: Read `AGENTS.md`, then:
   - `docs/README.md` - Documentation layout and source-of-truth rules
   - `docs/ARCHITECTURE.md` - System diagrams, protocol, data flow
   - `docs/plans/ROADMAP.md` - Strategic epochs and direction
   - `docs/plans/IMPLEMENTATION.md` - Current build phases and deliverables
   - `docs/knowledge/self-healing-agent-system.md` - Public-safe agent automation boundary

2. **Before building**: Read the relevant `docs/specs/*.md` for feature details
   - For UI/theming work, also read `docs/DESIGN.md`
   - For Nostr protocol, relay, signer, messaging, payment, product-event, cache, or outbox work, also read `docs/knowledge/external-nostr-references.md`

3. **Plan before implementing**: For non-trivial implementation work, write a concise plan from the relevant spec/docs. If the user has already asked for implementation, proceed after the plan unless the work hits a stop condition.

4. **Spec-first rule**:
   - If work changes product requirements, protocol behavior, or shared implementation expectations, land the relevant docs/spec PR to `main` before starting the implementation `feat/*` branch

5. **Reviewer-owned context follow-up**:
   - For implementation PRs, surface possible docs drift in the PR or final summary, but do not silently bundle broad repo-context changes into the code PR.
   - The reviewer decides: `No docs follow-up needed`, `Docs-only PR after merge`, or `Docs/spec PR required before merge`.
   - Draft docs-only follow-up PRs only when a reviewer or maintainer asks.

6. **End**: Report validation and any doc/status follow-ups. Do not edit planning status checkboxes unless the user explicitly asks; live execution status belongs in Linear. When Phase 2 exit criteria appear complete, prompt the user that it may be time to archive or delete `docs/plans/PHASE_2_IMPLEMENTATION.md`.

## Nostr Task Routing

Treat these as Nostr-sensitive changes: `packages/core/src/protocol/*`, relay settings/planning, NDK calls, event parsing/emission, signer auth, NIP-17/NIP-44/NIP-59 messaging, NWC/payment behavior, Dexie cache/outbox behavior for signed events, product identity, and route code that publishes, fetches, unwraps, or decrypts Nostr events.

- Check public protocol sources before implementation, not after review.
- Prefer shared protocol helpers and hooks in `@conduit/core`; route files should compose prepared state and workflows.
- Do not add route-local `giftWrap`, publish, unwrap/decrypt, relay fanout, or event parsing when a shared helper exists or should be deepened.
- Model relay partial failure, stale/degraded state, source disagreement, and publish ACK/reject/timeout where user decisions depend on freshness.
- Keep diagnostics content-free: no plaintext, ciphertext, invoices, order contents, addresses, phone/email, signer secrets, NWC URIs, or message bodies.
- Keep NIP-44 v3 readiness visible when messaging work touches that area. Be truthful that public NIP-44 is currently v2, but do not remove v3 planning; gate implementation on public draft/client references and explicit capability detection.

## Protected Files

Do not modify without explicit confirmation:

- `docs/ARCHITECTURE.md` - System architecture and diagrams
- `docs/plans/IMPLEMENTATION.md` - Technical build guide
- `docs/specs/*.md` - Feature specifications

## Public Repo Posture

Treat `conduit-mono` as a public client/shared-code repository.

When writing:

- commit messages
- PR titles
- PR descriptions
- tracked public-facing docs

avoid framing this repo around:

- internal company planning
- repo-scope assumptions that do not belong to `conduit-mono`

Keep public language focused on:

- Market
- Merchant
- Store Builder
- shared packages
- protocol/spec implementation
- trust, provenance, and open-source-safe engineering context

If discussing future repo boundaries, keep `conduit-services` clearly separate from the current `conduit-mono` scope unless the repo structure has actually changed.

Keep private company context out of tracked public history unless explicitly requested.

## Agent Automation Boundary

- Keep agent workflows in this public repo sanitized and least-privilege.
- Linear is the team-facing target for automated triage; GitHub issues are community-facing.
- Private prompts, dashboard links, Linear/Slack/Cloudflare runbooks, credentials, and release coordination belong outside this public repo.
- Code-changing agent workflows require maintainer intent, such as an `agent-ready` or `agent-fix` label, and must not run for high-risk protocol/auth/payment/privacy work without human planning.
- Telemetry and smoke artifacts used by agents must follow `docs/analytics/events.md` and must not include pubkeys, npubs, nsecs, invoices, order contents, addresses, message contents, IPs, fingerprints, signer connection strings, or NWC URIs.

## Commands

```bash
# Development
bun install              # Install all dependencies
bun run dev              # Start all apps in parallel
bun run dev:market       # Start Market only
bun run dev:merchant     # Start Merchant Portal only
bun run dev:store-builder # Start Store Builder only

# Build
bun run build            # Build all packages then apps
bun run build:packages   # Build shared packages only

# Quality
bun run typecheck        # Type check all packages
bun run lint             # Lint all packages
bun run telemetry:check  # Enforce privacy-safe telemetry allowlist
bun test                 # Run tests

# Clean
bun run clean            # Remove all node_modules
```

### Local Dev Ports

When agents start local app servers, prefer the 7000 port range so the repo has stable, predictable URLs:

- Market: `7000`
- Merchant Portal: `7001`
- Store Builder: `7002`

For remote browser access over Tailscale or a forwarded host, bind Vite to all interfaces and pass the port explicitly, for example:

```bash
bun run --filter @conduit/market dev --host 0.0.0.0 --port 7000
bun run --filter @conduit/merchant dev --host 0.0.0.0 --port 7001
```

## Code Style

- **TypeScript strict mode** - All code must pass strict type checking
- **Double quotes** for strings
- **2-space indentation**
- **async/await** over .then() chains
- **Explicit error handling** - No swallowed errors

### UI Component Rules

- Use shadcn-style primitives through `@conduit/ui` before adding app-local controls.
- Do not hand-roll native `<select>`, custom listboxes/comboboxes, dialogs, dropdowns, tabs, sheets, or textareas in app routes when `@conduit/ui` already provides the primitive.
- If a common primitive is missing, add it to `packages/ui/src/components`, export it from `@conduit/ui`, and consume it from apps.
- Keep route files focused on workflow composition and state. Shared keyboard behavior, focus management, overlay behavior, and reusable control styling belong in `@conduit/ui`.
- For UI/theming changes, read `docs/DESIGN.md` and keep tokens/components aligned with the shared design system.

### Import Order

1. External dependencies (react, TanStack, etc)
2. @conduit/core imports
3. @conduit/ui imports
4. Relative imports (./components, ../utils)

### Component Structure (TanStack Router)

```
apps/market/src/
├── routes/              # TanStack Router file-based routes
│   ├── __root.tsx       # Root layout (header, footer)
│   ├── index.tsx        # Home page (/)
│   ├── products/
│   │   ├── index.tsx    # Product grid (/products)
│   │   └── $productId.tsx  # Product detail (/products/:id)
│   ├── cart.tsx         # Cart page
│   ├── checkout.tsx     # Checkout (auth required)
│   ├── orders.tsx       # Order history and details surface
│   ├── messages.tsx     # DM inbox
│   ├── network.tsx      # Relay/network settings
│   ├── wallet.tsx       # Buyer wallet setup
│   ├── store/
│   │   └── $pubkey.tsx  # Merchant storefront
│   ├── u/
│   │   └── $profileRef.tsx # Profile reference view
│   └── profile.tsx      # User profile
├── components/          # Shared app components
├── hooks/               # App-specific hooks (useCart, etc)
├── lib/                 # Utilities, guards, query client
└── main.tsx             # App entry point
```

## Package Dependencies

Apps depend on packages, never the reverse:

```
apps/market     ─┬─> @conduit/core
                 └─> @conduit/ui
apps/merchant   ─┬─> @conduit/core
                 └─> @conduit/ui
packages/ui     ───> (external + React only)
packages/core   ───> (external only)
```

## Environment Variables

```bash
# .env.local (gitignored)
VITE_DEFAULT_RELAYS=
VITE_BLOSSOM_SERVER_URL=https://blossom.conduit.market
```

The canonical relay reset list lives in `packages/core/src/config.ts` and currently starts with `wss://conduitl2.fly.dev`. Do not add retired Conduit relay hosts to active docs or examples.

## GitHub CI/CD

Pipeline stages include changed-file formatting, PR title, lint, typecheck, tests, color policy, telemetry policy, E2E smoke, the mainnet build, and preview-link automation. See `CONTRIBUTING.md` and `.github/workflows/ci.yml` for the current gates.

Protected branches: `main`
Pull request required for all changes.

## Git and PR Conventions

- Use Conventional Commits by default for commits: `type(scope): description`
- Use the same convention for PR titles unless the PR is a release or sync promotion with an explicit repo-level naming rule
- Branch names for new work should use conventional prefixes such as `feat/*`, `fix/*`, `chore/*`, or `docs/*`
- Use `.github/pull_request_template.md` for all PRs
- For spec-driven work, merge the relevant docs/spec PR to `main` before starting the implementation `feat/*` branch
