# Checkout Startup: Emitted JavaScript Census

## Reproduce

After a completed optimized build from the repository root:

```sh
bun run build
bun run scripts/dev/measure_checkout_startup_bundle.ts
bun test tests/checkout-startup-bundle-census.test.ts
```

The measurement reads the built Market and Merchant `index.html`, deployment
profile manifest and JavaScript chunks. It scans the emitted ESM import graph;
it never imports/evaluates the application, opens a browser, initializes a
wallet, reads credentials or contacts a network. The census is bounded to 512
JavaScript files and 128 MiB per app and fails on missing or escaping module
references instead of silently undercounting them.

Initial JavaScript is the union of HTML module entries, module-preload hints
and their static import closure. Deferred JavaScript is the additional closure
reachable through literal dynamic imports. Other emitted JavaScript is outside
that graph, not necessarily unused: workers and computed runtime references are
not established by a literal ESM import scan. SDK-only byte attribution is not
claimed.

## Observed optimized local-profile build

One completed build with the default code-owned `local` deployment profile
produced the following byte census. These are current artifact sizes, not a
before/after optimization comparison or hosted production configuration.

| App      | JavaScript boundary                | Chunks |  Raw bytes | Computed gzip-9 bytes |
| -------- | ---------------------------------- | -----: | ---------: | --------------------: |
| Market   | Initial static closure             |      6 |  5,081,591 |             1,406,738 |
| Market   | Additional literal-dynamic closure |      7 |  6,604,825 |             2,863,688 |
| Market   | Other emitted JavaScript           |      1 |     33,538 |                12,785 |
| Market   | All emitted JavaScript             |     14 | 11,719,954 |             4,283,211 |
| Merchant | Initial static closure             |      7 |  4,802,684 |             1,304,854 |
| Merchant | Additional literal-dynamic closure |      7 |  6,604,825 |             2,863,687 |
| Merchant | Other emitted JavaScript           |      1 |     33,538 |                12,785 |
| Merchant | All emitted JavaScript             |     15 | 11,441,047 |             4,181,326 |

Compressed bytes are the sum of independently computed per-file gzip level-9
sizes. They are not observed HTTP transfer sizes or a CDN compression claim.
CSS, fonts, images, request headers, cache behavior, JavaScript evaluation,
rendering, SDK initialization and physical-phone startup are not sampled.
The script makes zero network requests. A repeat census of identical artifacts
is not warm-browser or repeat-device timing evidence.

## Disposition and next measurement

Keep startup/import changes separate from payment preparation and scheduling
changes. There is now a measured emitted-byte basis for a follow-up: the initial
static closure is roughly 4.8–5.1 million raw JavaScript bytes. That does not
establish which code dominates runtime cost, which deferred SDK is loaded by a
particular user flow, or whether changing wallet initialization would improve
startup safely.

Owner role: frontend performance maintainer, coordinating with the wallet
lifecycle maintainer for any SDK-initialization boundary.

Next measure a managed-profile build's actual anonymous startup with all
external networking blocked: record cold-cache and same-context repeat resource
transfer, module evaluation/long tasks and first usable UI. Repeat on a physical
phone with cache/device conditions recorded before moving imports or changing
wallet initialization. Keep those results separate from provider operations,
external funding/user wait and this emitted-byte census. No device or deployed
startup latency improvement is claimed here.
