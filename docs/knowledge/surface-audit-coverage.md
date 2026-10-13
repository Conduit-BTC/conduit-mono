# Direct-route surface audit coverage

`e2e/shared-ui-surface-audit.playwright.ts` checks independent empty,
degraded and readiness route shells. Each route/theme pair runs in desktop
Chromium, mobile Chromium (Pixel 7), and mobile WebKit (iPhone 13). Each case
uses Playwright's fresh test context and full configured device options.

## Coverage mapping

Before this change, each `${area} surface audit in ${theme} @${area}` case
visited every route below, creating a fresh context between visits. The
replacement `${area} surface audit in ${theme}: ${route} @${area}` cases
execute the same assertions independently. For **each** row, the mapping
applies to both `day-market` and `night-market` and all three projects.

| Area     | Routes retained, one replacement case per route                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market   | `/`, `/products`, `/merchants`, `/sellers`, `/zapouts`, `/events`, `/cart`, `/checkout`, `/orders`, `/messages`, `/profile`, `/preferences`, `/wallet`, `/network`, `/about`, `/terms-of-service`, `/privacy-policy` |
| Merchant | `/`, `/products`, `/events`, `/events/new`, `/orders`, `/messages`, `/profile`, `/wallet`, `/shipping`, `/network`, `/about`, `/terms-of-service`, `/privacy-policy`                                                 |

The 12 tour cases become 180 route cases. All 180 route visits remain in real
browsers. The three project instances of `Merchant legacy Payments opens
Wallets before the next route navigation @merchant` retain the same shared
page, redirect, title and subsequent navigation assertions. Nothing moves to
helper-only tests. Full discovery changes from 613 to 781 unique project
cases and from 656 to 824 area executions; the overlapping area memberships
outside this file remain unchanged.

## Invariants and fixtures

Every route retains:

- A runtime-generated external signer, signed empty profile and local relay
  declarations, empty context storage and the selected named theme.
- Visible root and heading or catalog navigation, with no error boundary or
  sign-in gate.
- Actual bundled font loading, independent of nonessential image completion.
- Document-width containment, absence of decorative gradient backgrounds,
  and the existing panel-radius limits, measured in the browser.
- The existing content-free phase, route index, navigation/crash and pending
  resource observations. A failure stops only its route case.

The `/wallet` cases also retain the exact wallet URL and visible Add a wallet
assertions. Each `/` case retains the held-image probe, proving that a pending
nonessential image does not prevent UI and font readiness. Optional local
masked screenshots retain their existing names and scope; required CI still
uploads only sanitized evidence.

Signer identities are disposed after each case. Playwright owns page/context
teardown on success or failure. The standard per-case timeout replaces the
long aggregate tour timeout; assertions and their limits are unchanged.

Populated audits, browser history, payment-state permutations, mobile footer
positioning, invoice persistence and serial cross-app commerce journeys keep
their existing browser coverage. Splitting independent route shells does not
justify splitting those stateful sequences or changing their fixtures.

Selection, shard configuration, zero retries, manifest/SHA verification and
artifact privacy rules remain unchanged. More precise case outcomes and
smaller units are the purpose of this change; timing and reliability claims
require measured candidate evidence.

Progress and manifest names allow only this file's fixed area/theme/route
combinations. Unknown or sensitive variants remain redacted, and retained
evidence remains title-free. Failure commands are explicitly source-group
reproducers; their file-and-line selection includes the generated route group.
