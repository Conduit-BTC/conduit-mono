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
write token. Bot-authored PRs receive a noncanonical preview check, except for
the configured contributor refresh App on `chore/refresh-repository-contributors`. That
same-repository path must change only the existing contributor snapshot and
match the immutable PR head before it can pass the required `preview-links`
context. It still runs the normal build and preview verification.

Contributor snapshots refresh every Monday at 08:17 UTC or through the manual
`Refresh Repository Contributors` workflow on `main`. The generator runs from
the immutable default-branch revision with a read-only token before the App
write token exists. A dedicated App creates these snapshot updates through the
`contributor-refresh` environment. An absent, invalid, or mismatched App identity
stops the refresh. One fixed branch keeps one reviewable update PR open;
existing branches must belong to the App and have a snapshot-only diff.
Review and merge these PRs normally. After changing the refresh workflow, run
it once after merge to verify the App-created PR and its required checks.

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
Full Market runs in five single-worker jobs; Merchant runs in four. Their
project-aware discovery manifests must combine to each complete area selection
with no missing or repeated tests.
Market browser fixtures use synthetic mainnet invoices so Spark wallet setup and
manual invoice handoff share a supported network; Commerce uses testnet.
The local `test:e2e`, `test:e2e:mobile`, and `test:e2e:webkit` commands run
each selected area with its own network and verify their discovered test union.
Use those commands for full runs; direct unscoped `playwright test` cannot
serve Market and Commerce with different Lightning networks.
Playwright area tags select the tests. CI rejects an untagged smoke test or a
selected area that contains zero tests.
Bounded About/legal composition and existing test-file-only changes use the
explicit [smoke ownership map](docs/knowledge/smoke-selection.md), retaining the
owning app's route/theme/browser baseline. Unknown helpers and runtime changes
expand conservatively; large subsets retain full-area partitions. Build overlaps
independent checks, while preview verification still requires its validated build.

Browser smoke jobs use the official Playwright Noble image with browsers and
system libraries preinstalled. When updating the locked `@playwright/test`
version, update the CI image version and registry digest together. The runtime
contract test rejects version drift. For no-op shards, the image expression
evaluates to an empty string. The Actions runner converts that definition to no
job container, so the no-op step runs on the host without pulling an image.
The aggregate gate still requires successful selection and shard execution.
Keep Bash as the container step shell because smoke steps use Bash arrays and
`pipefail`. Market and Merchant jobs have a 20-minute limit. Commerce has a
25-minute limit for its serial ordinary, ordinary native-router, and receiver setup
lanes. Event native-router cases run in a separate parallel, 25-minute job with
independent app, relay, wallet, signer and browser-storage state. Both jobs remain
required whenever commerce is selected. Limits include setup, evidence upload,
and cleanup. Individual test deadlines
remain unchanged. Job cancellation still fails the aggregate gate, even when
all test artifacts were uploaded successfully.

A retry-dependent pass still fails the smoke gate. Required CI runs use zero
automatic retries; a separate diagnostic rerun cannot turn a failed first
attempt into readiness evidence. Selected coverage and first-attempt requirements
remain unchanged.

Every progress and failure entry includes an opaque case ID derived from
Playwright's test identity. Parameterized cases at the same source line retain
distinct IDs even when their titles are redacted. Compare IDs on the same
tested commit; renaming or moving a test can change its identity.

Each shard retains a seven-day `smoke-evidence-<shard>-<attempt>` artifact. Its
title-free JSON includes source/base/tested SHAs, project and area, case IDs,
first-attempt outcomes and duration buckets, fixed failure categories, repository
locations, and allowlisted diagnostics. It is constructed from approved fields
and scanned before writing. Raw reports, browser output, screenshots, traces,
step titles, and attachments are never uploaded. An artifact records observed
execution; the separate manifest/SHA/first-attempt verifier remains the gate.

The isolated router and receiver setup lanes retain separate `smoke-evidence-router-<attempt>`
and `smoke-evidence-router-receiver-setup-<attempt>` artifacts under the same policy.
Event native cases retain `smoke-evidence-event-router-<attempt>` under that same
policy. Before execution, project-aware discovery verifies that the ordinary and
Event native profiles form the exact full native manifest with no omissions or
overlap. The default local router profile still runs the complete native set;
`PLAYWRIGHT_ROUTER_NATIVE_PROFILE=ordinary` or `event` selects a CI partition.
Each lane runs after an earlier lane fails only when its own setup and selection
succeeded. A later passing lane does not replace an earlier failure.

Schema version 2 retains timing only as fixed duration buckets: `under-1s`,
`1-5s`, `5-15s`, `15-30s`, `30-60s`, `1-5m`, `5-15m`, and `15m-plus`.
Lower bounds are inclusive and upper bounds exclusive; invalid durations use
`unknown`. This applies to setup, execution, each attempt, and diagnostic
elapsed/phase/slowest times. The artifact serializer rejects exact duration
fields. Exact durations remain in the transient verifier report and existing
progress output, which are not uploaded as artifacts.

`reporterSetupBucket` measures reporter construction through the first test start;
it includes subsequent discovery and server startup, not job queueing, container
setup or dependency installation. `executionBucket` measures first test start
through reporter completion, including teardown. A startup failure has zero
execution time, represented as `under-1s`. Use Actions job/step timestamps for the complete critical path
and combined runner-minutes; do not add overlapping wall-clock intervals.

Failures correlate the primary result error with the latest matching leaf step
and retain the last completed boundary before that step. This avoids attributing
equal error contents to an earlier recovered operation or a propagated parent.
Error contents are compared only in memory and are never retained. Categories identify observations such as assertion,
timeout, fixture or browser operation, not a proven root cause. Unknown remains
unknown. Surface audits also record a boolean when WebKit reports a network-process
crash through a WebSocket error; page-crash events and browser stderr may miss
that failure. The socket error text is never retained. Reproduction commands target the source group and browser with one
worker and no retries; a parameterized source line can run several cases.
Check out the recorded tested SHA, match the CI browser image, use fresh app
servers, and match the case ID to distinguish those cases. Local results do not
replace hosted Linux/WebKit or physical-device evidence.

The direct-route surface audit uses a fresh browser context for each route,
with the same project/device options, signer and theme setup, and assertions.
This isolates route shells from WebKit network-process failures observed during
repeated document replacement. Navigation/history and cross-route state tests
retain their own shared-context behavior. No failed navigation is retried.

The privacy-safe reporter
retains allowlisted footer geometry and product-submit readiness categories for
the corresponding fixtures, including the failed first attempt. It drops raw
annotations, form values, identities, message content, and error text. Extend
these diagnostics only with bounded fields and matching privacy regression tests.
Surface audits also retain fixed phase, page-crash and failed-document counters.
CI enables `DEBUG=pw:browser`; the reporter classifies only fixed browser-process
signals in memory and emits content-free counters to the progress log. Raw stderr
stays suppressed. Do not enable `PW_RUNNER_DEBUG`, which bypasses the reporter.
A matching signal is diagnostic evidence, not proof that every timeout shares
the same cause; absence of a signal does not exclude a browser failure.

The reserved-stock journey records failure-only, file-bound control-state
observations at pickup setup and reconciliation: fixed phase/cardinality enums
and availability, visibility, enablement, hit-target and disclosure booleans.
These observations do not establish stock delivery or settlement. Input values,
pickup codes, identifiers, error text, DOM and coordinates remain excluded;
the original operation error and test deadlines are unchanged.

The prepaid-confirmation seam retains only matching input-event and expected
dialog-lifecycle booleans, closed trigger cardinality, and control enablement.
It observes the original gesture without dispatching input or changing order
state. Failure reads and cleanup are best-effort bounded; unavailable observation
is not evidence that an event or dialog never occurred. These observations do
not establish payment or signer state. The original click, assertions, deadlines
and retry policy remain unchanged.

Wallet-balance fixture fetch failures distinguish the fixed Spark-factory and
wallet-controller module boundaries using bounded error categories, request
counts and navigation booleans. The Spark-factory observer rethrows its original
fetch failure even if diagnostic recording fails. These observations retain no module contents,
URLs or error text and do not establish a production-wallet root cause.

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

- NIP-07/NIP-46 and enabled browser/PWA local import share the existing
  account/session owner. Only `packages/core/src/protocol/local-key/` and its
  storage may possess the imported account secret. No key getters, general
  stores/props, logs, telemetry, network submission, export or product key
  generation. Services never receive account keys. Review changes here and
  their dependencies as security-critical; see
  [the focused review contract](docs/knowledge/local-signer-security-review.md).
- Preserve automatic restore, account/revision fencing, cancellation and
  durable logout. Failed deletion is a failure, even after live authority stops.
  Same-origin compromise is outside this containment model. Browser tabs and
  installed apps support nsec sign-in in managed preview and production builds.
  Require maintainer security review and report physical-device validation
  separately from automated browser evidence. Follow the normal reviewed release
  process; do not silently disable previews while claiming testable delivery.
- A bounded `guest_ephemeral` browser key may serve one guest order and merchant.
  Keep it only in same-tab session storage for recovery of up to 24 hours. Limit
  signing to the initial private order, same-order payment reports, and the
  separately constrained router recovery envelopes documented in
  [the protocol specification](docs/specs/protocol.md#client-ephemeral-guest-order-key-exception).
  Event organizer delivery is limited to the organizer frozen in that order's
  exact authorized event binding: the recovery/progress package for a
  version-five organizer-handoff plan, or the separate zero-commerce, zero-fee
  purchase packet with no wallet or
  invoice. It permits no stock records, generic messages, guest inbox, other
  order or recipient, or extension of the existing guest signing lifetime.
  It must never become an account key or nsec.
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
