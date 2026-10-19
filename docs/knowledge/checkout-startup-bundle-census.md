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

## Route-component splitting comparison

Market and Merchant enable the installed TanStack router plugin's
`autoCodeSplitting` option. The router retains route matching, search validation
and guards while loading route components on demand. No route behavior, SDK
initialization policy, dependency or wallet authority changes are intended.

Production-profile builds compared against main at
`66c80f4a2cf5a2e076469ad9dfc0831fdbc8ea1b` produced these cold, anonymous
`/privacy-policy` observations in Linux desktop Chromium:

| App      | Before raw JS | After raw JS | Before computed gzip-9 | After computed gzip-9 | Before/after JS requests |
| -------- | ------------: | -----------: | ---------------------: | --------------------: | -----------------------: |
| Market   |     5,125,400 |    3,914,959 |              1,419,772 |             1,166,745 |                   8 / 28 |
| Merchant |     4,858,696 |    3,839,607 |              1,321,625 |             1,121,509 |                   9 / 21 |

The browser fulfilled all application requests from local build output under the
canonical application hostnames and blocked external HTTP and WebSocket access.
Both privacy pages rendered without page errors. Checkout, orders and wallet
route-component chunks were absent from the initial requests. Shared wallet
and pricing helpers still load with the shell. The smaller initial payload uses
more requests; this is not a measured latency or physical-device improvement.
Computed compressed sizes are per-file gzip level 9, not CDN transfer evidence.

Both apps displayed their existing error page when the emitted About component
chunk was deliberately unavailable, then recovered through the reload control.
The About browser suite covers this failure/recovery behavior in development;
the emitted-chunk check qualifies the optimized production build separately.
Existing signed-in surface tests cover direct product, order, checkout (Market)
and wallet navigation on desktop Chromium and mobile WebKit.

## Disposition and next measurement

Keep startup/import changes separate from payment preparation and scheduling
changes. Route components now defer, while a substantial shared shell remains.
The census does not establish which code dominates runtime cost, which deferred
SDK is loaded by a particular user flow, or whether changing wallet initialization
would improve startup safely.

Owner role: frontend performance maintainer, coordinating with the wallet
lifecycle maintainer for any SDK-initialization boundary.

Next capture same-context repeat resource loading, module evaluation/long tasks
and first usable UI on a physical phone with cache/device conditions recorded.
Keep those results separate from provider operations, external funding/user wait
and this emitted-byte census. No device or deployed startup latency improvement
is claimed here.
