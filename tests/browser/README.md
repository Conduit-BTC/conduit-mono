# Isolated read and checkout browser tests

Install dependencies and the disposable Chromium distribution once:

```sh
bun install
bunx playwright install chromium
```

Run the same scenarios unattended or in a visible test browser:

```sh
bun run test:browser
bun run test:browser:headed
```

For interactive debugging, run `bun run test:browser:headed --debug`.
The Playwright configuration starts a dedicated Vite test app on
`http://127.0.0.1:4318` and stops its server when the run ends. An existing server
on that port causes a failure rather than reuse. Each test receives a fresh
non-persistent browser context. No installed extension, normal Chrome profile,
wallet, account login, or production session is used.

The local test app imports the real outgoing-state engine, Buyer runner and
Merchant reconciliation worker. It substitutes provider and repository boundaries
with synthetic controlled responses. The outgoing fixture is derived from the
retained outgoing tests and contains synthetic signed invoice bytes, not an issued
payment request. Its state is restored through the production validator. The
NIP-07 substitute signs synthetic events with a disposable test identity; ordinary
signature verification remains enabled.

Page HTTP requests may reach only the dedicated loopback origin. All browser
WebSocket connections are intercepted and closed, and service workers are blocked.
The Vite app ignores dotenv files and does not expose ordinary `VITE_*` environment
variables. There is no live payment/provider adapter wired into these scenarios.
These are page-traffic controls, not a machine-wide network firewall.

Coverage:

- Lost provider response followed by absent history retains a submitted attempt
  without another send.
- Account change, explicit cancellation and pause revoke work after an awaited
  read; an admitted read drains rather than being mistaken for a cancelled send.
- Simulated document visibility loss invokes the real runner's pause. This tests
  the DOM/runner seam, not OS window minimization or the production route's event
  wiring.
- A concurrent activation cannot acquire an already-running Buyer runner.
- The serial Merchant worker owns the first candidate independently of a synthetic selection
  marker, and pause prevents another candidate from starting.
- Synthetic NIP-07 events verify, and external HTTP/WebSocket attempts are denied.

This is a local integration test app, not the complete Shop/Merchant route UI.
It does not cover live relay transport, recovery-wallet initialization, actual
provider settlement, full cart/pricing/funding flows, cross-tab durable execution,
or the cause/outcome of any production incident. The retained offline recovery
admission tests remain separate. Mock success is not evidence of funded settlement.

On failure, Playwright retains synthetic screenshots and traces under the ignored
`test-results/browser/` directory. Open a trace with
`bunx playwright show-trace <path-to-trace.zip>`. Never point this configuration at
production, load real identities or seed funded browser storage into it.

Local harness typecheck: `bun node_modules/@typescript/native/bin/tsc -p tests/browser/tsconfig.json`.
The `.pw.ts` suffix keeps Playwright cases out of Bun's ordinary unit-test discovery.

Public feed scenarios use separate `public-feeds.html` and
`public-event-feeds.html` test pages. They invoke the shared production read
owners (and profile React Query hooks) with disposable signed fixtures and real
WebSocket transport intercepted entirely in process. No server connection is
made. Each case attaches content-free destination counts. The exact Vite loopback
socket is closed and counted separately from relay destinations; query tokens
are not retained in diagnostic URLs, and traces are disabled for these cases.

Product cases cover browse/refresh/increased-limit reads, ranked hydration,
family/deletion support, profile/follow/search reads, partial/total outages and
rate limiting with 105 advertised sources. Event cases cover discovery, real
continuation, calendar/series/assignment/authorization support and retained signed
negative evidence with 120 advertised sources. Unscoped payment/exact and
organizer-action controls still contact their advertised sources, establishing
that feed policy is not a global relay cap. These are API/hook journeys, not
full production-route or live-network qualification.
