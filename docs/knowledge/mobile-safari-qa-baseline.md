# Mobile Safari QA Baseline

This runbook defines a repeatable, public-safe browser QA baseline for the Market,
Merchant, and Wallet booth paths. It combines fast browser automation with a
small manual device matrix for behavior that only actual mobile operating systems
and installed signer apps can prove.

The baseline is designed to finish in 110 minutes. A run is complete only when
every required matrix cell has a result and every failure has a reproducible,
public-safe note. `BLOCKED` and `FAIL` are valid results; silently skipping a cell
is not.

## Validation boundary

Use exact language when reporting results:

- **Playwright WebKit** runs Playwright's patched WebKit build with an emulated
  iPhone viewport, user agent, and touch input. It is useful browser-engine
  regression coverage, but it does **not** run branded Safari and is not a real
  iPhone test.
- **Playwright mobile Chromium** likewise emulates a mobile device. It is not a
  physical Android Chrome test.
- **Real Mobile Safari** means Safari was exercised on a physical iPhone and the
  evidence records the device model, iOS version, and Safari build. An iOS
  Simulator, desktop responsive mode, and Playwright WebKit do not satisfy this
  claim.
- Native signer handoff, the software keyboard, OS background suspension,
  constrained WiFi, iCloud Private Relay, and return from another app remain
  manual real-device checks.

Playwright documents both its [browser implementation boundary][playwright-browsers]
and [device emulation capabilities][playwright-emulation]. A passing automated run
may be reported as "Playwright WebKit passed"; it must never be shortened to
"Mobile Safari passed."

## Version policy

Select devices at run time, then record exact versions in the run log. Do not
silently substitute a simulator or a desktop browser for a physical device.

| Lane                  | Required version policy                                                                        | 2026-08-10 baseline snapshot                                             |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| iPhone current        | Physical iPhone on the current stable iOS release, normal Safari                               | iOS 26.6, released 2026-07-27 ([Apple release notes][ios-current])       |
| iPhone previous       | Physical iPhone on the previous Apple-supported iOS branch, normal Safari                      | iOS 18.7.9, released 2026-05-11 ([Apple release notes][ios-previous])    |
| Optional older iPhone | The oldest iPhone/iOS combination still expected at the booth                                  | Record as an additional lane; it does not replace either required iPhone |
| Android               | Physical Android phone on current stable Chrome and current Android System WebView             | Record model, Android, Chrome, and WebView versions                      |
| Desktop               | Current stable desktop Chrome at 1024x768 and 1440x900; add current macOS Safari as supporting | Record operating system, browser version, and both tested viewport sizes |
| Automation            | Repository-pinned Playwright WebKit and Chromium builds                                        | Record Playwright version and project names from the tested commit       |

Recheck the linked vendor release pages on the day of a run. If the current or
previous supported branch changes, update the selected devices in the run log;
the version policy is authoritative, not the snapshot.

## Fixture terminology

For this runbook, a **zap-out preset** is a preconfigured booth QA fixture: a
known synthetic product and cart plus an approved test signer/payment setup that
starts the zap-out path in a ready state. The current product has no user-facing
saved zap-out preset feature. Preparing the fixture is outside the two-tap count,
but every in-product tap after the fixture is loaded counts. This terminology
does not add or imply a new product feature.

## Requirement register

Each P1/P2 criterion below has exactly one row in the device matrix. A criterion
passes only when its observable condition is met in every required (`M`) lane.
Automated (`A`) and supporting (`S`) lanes add confidence but do not replace a
required real-device result.

| ID    | Priority | Observable pass condition                                                                                                                                                                                                                                                     |
| ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-01 | P1       | At the narrowest supported portrait width and in landscape, no primary content or action is clipped, covered by browser chrome, or the cause of page-level horizontal scrolling.                                                                                              |
| P1-02 | P1       | Primary navigation, dialog close, signer choices, checkout controls, and retry actions work by touch without hover; adjacent targets do not cause accidental activation and primary targets provide a 44-by-44 CSS-pixel touch area.                                          |
| P1-03 | P1       | Focusing, typing, selecting, and dismissing the software keyboard keeps the active field, its label/error, and the next action reachable; the page does not involuntarily zoom and entered checkout data is preserved.                                                        |
| P1-04 | P1       | Internal links plus browser Back, Forward, and refresh return to a usable route without blank content, lost navigation, duplicate submission, or a trapped modal.                                                                                                             |
| P1-05 | P1       | NIP-46 setup presents a usable connection path; Clave handoff and return work on iPhone, Amber handoff and return work on Android, and cancel/reject returns to a recoverable signer screen without exposing connection material.                                             |
| P1-06 | P1       | After signer connection, refresh and same-browser foreground resume restore or clearly reconnect the supported authentication session; disconnect removes access cleanly. Guest state follows its documented same-browser lifetime.                                           |
| P1-07 | P1       | A clean browser session can complete guest checkout without a signer: fields validate, order submission is single-shot, navigation reaches a clear result, and refresh does not create a second order.                                                                        |
| P1-08 | P1       | With the zap-out booth fixture loaded, initiating zap-out and invoking the existing confirm/handoff action takes no more than two Conduit taps; cancel, signer rejection, or return from the wallet leaves a clear retry path and no duplicate payment attempt.               |
| P1-09 | P1       | A submitted guest order appears once in Merchant and its receipt/status is readable. The merchant explicitly chooses the proposed `Update to N` action, approves it with the merchant signer, and confirms available stock reaches N after one signed update.                 |
| P1-10 | P1       | If the anonymous zap signer is unavailable or rejects before payment starts, checkout offers the private-invoice fallback once without looping and that fallback payment can complete. After a payment handoff begins, recovery never creates a second invoice automatically. |
| P1-11 | P1       | On venue-like WiFi, one logical relay endpoint does not accumulate parallel WebSocket connections; a disconnect/reconnect recovers without a stalled checkout or duplicated order. Record iCloud Private Relay state without recording endpoint names.                        |
| P1-12 | P1       | After the app is backgrounded for 30–60 seconds mid-checkout, foreground resume preserves entered fields and the current order/payment state or presents a safe retry. It never silently restarts payment or duplicates an order.                                             |
| P2-01 | P2       | Rotating the device, resizing the visual viewport, and returning from another app do not leave fixed UI, scroll position, or focus in an unusable state.                                                                                                                      |
| P2-02 | P2       | Offline, timeout, signer rejection, and invalid-form states use readable, non-sensitive messages and leave an obvious retry, edit, or cancel action. Repeating that action is idempotent where money or orders are involved.                                                  |

## Device and automation matrix

Legend: `A` = automated assertion, `M` = required manual check, `S` = supporting
spot check, `—` = not applicable. An `A` result identifies the Playwright project;
it does not satisfy an `M` cell.

| Requirement | Playwright WebKit / mobile Chromium                         | iPhone current Safari   | iPhone previous Safari  | Android current Chrome  | Desktop current browser                     |
| ----------- | ----------------------------------------------------------- | ----------------------- | ----------------------- | ----------------------- | ------------------------------------------- |
| P1-01       | A: both                                                     | M                       | M                       | M                       | M                                           |
| P1-02       | A: representative 44 px targets in both                     | M                       | M                       | M                       | S                                           |
| P1-03       | A: both for layout, focus, and persistence only             | M                       | M                       | M                       | S                                           |
| P1-04       | A: browser navigation and reload                            | M                       | M                       | M                       | M                                           |
| P1-05       | A: affordances only                                         | M: Clave native handoff | S: Clave native handoff | M: Amber native handoff | S: QR/connection path only                  |
| P1-06       | A: storage and reload only                                  | M                       | M                       | M                       | M                                           |
| P1-07       | A: checkout form and reload only; no submission             | M                       | M                       | M                       | M                                           |
| P1-08       | —: manual fixture, tap count, and native handoff            | M                       | S                       | M                       | S                                           |
| P1-09       | —: focused unit contracts are separate; full flow is manual | M: buyer leg            | S: buyer leg            | M: buyer leg            | M: Merchant receipt and signed stock update |
| P1-10       | —: focused unit contract coverage is separate               | M                       | S                       | M                       | M                                           |
| P1-11       | —: physical network/socket observation                      | M                       | M                       | S                       | S                                           |
| P1-12       | A: reload interruption boundaries only; no OS suspension    | M                       | M                       | M                       | —                                           |
| P2-01       | A: viewport/focus smoke only                                | M                       | M                       | M                       | S                                           |
| P2-02       | A: invalid-form, cancel, and recovery affordances only      | M                       | S                       | M                       | M                                           |

## 110-minute full run

Use synthetic test data and the smallest approved non-production payment amount or
test rail. Never put signer connection strings, invoices, order contents, relay
hosts, customer data, addresses, email addresses, phone numbers, pubkeys, or
credentials into screenshots, videos, logs, or issue reports.

| Phase                                       |      Budget | Output                                                                    |
| ------------------------------------------- | ----------: | ------------------------------------------------------------------------- |
| Preflight and test-data reset               |       8 min | Commit/build identity, device versions, clean test state, starting stock  |
| Playwright WebKit + mobile Chromium         |      18 min | Command, project names, counts, traces/screenshots for failures           |
| Current iPhone Safari core and failure flow |      30 min | Required iPhone evidence, including Clave, keyboard, WiFi, and background |
| Previous-branch iPhone Safari delta pass    |      18 min | Required previous-iOS evidence and any compatibility variance             |
| Android Chrome core and Amber pass          |      15 min | Required Android evidence                                                 |
| Desktop buyer/Merchant regression           |      12 min | Checkout result, Merchant receipt, and stock evidence                     |
| Evidence review and failure filing          |       9 min | Completed matrix and one reproducible note per failure                    |
| **Total**                                   | **110 min** | Complete run under two hours                                              |

If setup consumes the budget, stop and mark affected cells `BLOCKED`; do not remove
checks to report an artificial pass.

### 1. Preflight

- [ ] Record the tested commit, build/environment label, date, and runner. Do not
      record private URLs or credentials.
- [ ] Record each physical device model, OS version, browser version/build, Chrome
      WebView version where applicable, and iCloud Private Relay state on iPhone.
- [ ] Use normal browsing mode. Private Browsing is not a valid session-persistence
      test.
- [ ] Close duplicate booth tabs, clear only the test profile's site data, and
      confirm the device has sufficient battery and a stable clock.
- [ ] Create or select synthetic test inventory, record starting available stock,
      and ensure at least two units remain so a single decrement is observable.
- [ ] Prepare the synthetic zap-out booth fixture through the normal product and
      wallet UI: select a published synthetic product with at least two units of
      stock, confirm the merchant has enabled direct Lightning payment, connect
      the approved test wallet, add one item, and fill checkout with synthetic
      contact data until `Zap out` is enabled. Record only a non-sensitive
      fixture label. This ready checkout state is the fixture boundary and the
      next Conduit interaction starts the two-tap count; do not describe it as a
      user-facing preset.
- [ ] Configure screen capture with synthetic data. Exclude QR codes, connection
      URIs, invoices, notifications, and browser/developer-tool views containing
      endpoints.

### 2. Automated engine baseline

Run the focused mobile suite from a clean checkout:

```bash
bunx playwright test e2e/mobile-safari-baseline.playwright.ts \
  --project=mobile-webkit --project=mobile-chromium
```

- [ ] Record the Playwright version, both project names, pass/fail counts, duration,
      and tested commit.
- [ ] Inspect every retained trace, screenshot, and video for sensitive test data
      before attaching it to a public pull request.
- [ ] Label the result `Playwright WebKit`, not `Safari` or `iPhone`.

### 3. Current iPhone Safari

- [ ] In portrait, open the Market product and cart paths. Tap primary navigation,
      use Back/Forward, rotate once, and confirm no clipped content or horizontal page
      scroll (P1-01, P1-02, P1-04, P2-01).
- [ ] Open signer setup. Confirm NIP-07 is not presented as an iPhone option, start
      the NIP-46 Clave handoff, cancel once, then connect and return. Refresh and
      background/foreground once; confirm a usable restored or reconnecting session
      (P1-05, P1-06, P2-02). NIP-46 behavior follows [NIP-46][nip-46].
- [ ] Load the preconfigured zap-out booth fixture, then initiate zap-out and invoke
      confirm/handoff. Count every Conduit tap after the fixture is loaded;
      wallet-app confirmation steps are outside the two-tap budget. Cancel once and
      confirm a safe retry (P1-08).
- [ ] In a clean guest session, enter checkout data with the software keyboard.
      Exercise text, email, phone, select/autocomplete, validation, Next/Done, keyboard
      dismissal, and scroll-to-error. Confirm no focus zoom and no covered action
      (P1-03, P1-07).
- [ ] Background Safari for 30–60 seconds mid-checkout, then return through the app
      switcher. Confirm fields and transaction state are preserved or safely
      recoverable (P1-12).
- [ ] Run the anonymous-signer and constrained-WiFi drills below before submitting
      one guest order. Record only synthetic, non-sensitive evidence (P1-10, P1-11).

### 4. Previous-branch iPhone Safari

- [ ] Repeat the portrait/landscape, touch, keyboard, navigation, guest checkout,
      refresh/session, background-resume, and constrained-WiFi required cells.
- [ ] Spot-check Clave handoff, zap-out recovery, anonymous-signer fallback, and the
      buyer leg of Merchant receipt/stock. Promote a spot check to a full check if the
      OS branch behaves differently from the current iPhone.

### 5. Android Chrome and Amber

- [ ] Repeat viewport, touch, keyboard/form, navigation, guest checkout,
      refresh/session, rotation, offline/error, and background-resume checks.
- [ ] Start Amber handoff, cancel once, connect and return, then refresh. Record the
      actual installed Amber and Chrome versions without recording the connection URI.
- [ ] Load the preconfigured zap-out booth fixture and exercise its 2-click path,
      then exercise anonymous-signer fallback. Confirm no duplicate invoice,
      payment attempt, or order.

### 6. Desktop and Merchant completion

- [ ] In current desktop Chrome, set the viewport to 1024x768 and then 1440x900.
      At both breakpoints, repeat navigation, refresh/session, guest checkout,
      invalid-form, offline/error, and duplicate-submit regression checks; confirm
      primary content and actions remain visible without horizontal page scroll.
- [ ] Choose exactly one of the submitted synthetic guest orders as the Merchant
      receipt/stock target. In Merchant, confirm one readable receipt/status. Review the proposed inventory
      change, choose the exact `Update to N` action once, explicitly approve the
      merchant signer request, and wait for successful delivery. Compare the final
      available stock with the recorded starting value; it must reach N after that
      one signed update (P1-09). Receipt alone does not decrement stock.
- [ ] When macOS Safari is available, add a supporting desktop Safari result. Do not
      use it to replace either physical iPhone lane.

## Failure drills

### Anonymous signer unavailable

1. Begin the anonymous-zap checkout path with the signer unavailable or reject the
   signer request before payment handoff.
2. Confirm the private-invoice fallback is offered once and the user can cancel or
   continue without a loop.
3. Continue through the offered private-invoice path and complete the approved
   test payment. Confirm one paid order and one proof/receipt state, with no
   duplicate invoice, order, or payment attempt.
4. Repeat the drill with a cancellation before payment. Retry the initiating
   action and confirm it does not create duplicate order or payment state.
5. Separately interrupt connectivity only after a payment handoff begins. Confirm
   the UI resumes/rechecks the existing attempt and never creates a second invoice
   automatically.

### Single-socket venue WiFi

1. Use the normal booth network or a documented venue-like WiFi profile. Record
   only the profile label and iCloud Private Relay on/off state, never SSIDs,
   addresses, or relay endpoints.
2. With one application tab open, use Safari Web Inspector or privacy-safe local
   diagnostics to count simultaneous sockets per logical relay endpoint. Endpoint
   values must be redacted.
3. Navigate between Market, Wallet, and checkout, then background and resume. A
   logical endpoint must not accumulate parallel connections.
4. Disable WiFi for 10 seconds before order submission, restore it, and confirm one
   clear recovery path. Repeating the action must not duplicate an order.
5. If socket count cannot be observed, mark the socket assertion `BLOCKED` even if
   the user flow succeeds.

[WebKit bug 302561][webkit-302561] reported that iCloud Private Relay could allow
only the first of multiple WebSockets to the same host and port on affected iOS
builds. The public bug is currently `RESOLVED MOVED`, and its reporter observed the
expected behavior in an iOS 26.3 beta. That status is not blanket validation of the
application, current iOS, older supported iOS, or venue WiFi. Keep P1-11 in every
physical-iPhone run and record the exact OS plus Private Relay state.

### Mid-checkout background and recovery

1. Enter all guest checkout fields but do not submit.
2. Background the browser for 30–60 seconds. Optionally open the installed signer
   once to exercise a realistic app switch.
3. Return to Safari using the app switcher or signer return link.
4. Confirm field values, selected country/region, order identity, and pending
   payment state are preserved or a safe retry is shown.
5. Tap submit/confirm once. Confirm no duplicate receipt, stock decrement, invoice,
   or payment attempt.

## Results and evidence

Use these result values:

- `PASS`: the observable condition was exercised in the named lane and evidence
  identifies the exact build and device/browser.
- `FAIL`: the condition was exercised and did not hold. Link a reproducible,
  public-safe failure record.
- `BLOCKED`: setup or observability prevented a conclusion. State what was missing;
  do not infer a pass.
- `NOT RUN`: no validation claim exists.

For each automated or manual evidence item, record:

- requirement ID and result;
- tested commit/build label and UTC timestamp;
- automation project **or** physical device model, OS, browser, and installed signer
  version as applicable;
- exact public-safe steps, expected result, actual result, and sanitized artifact
  names;
- network profile label and Private Relay state only when relevant; and
- a failure link or follow-up owner when the result is not `PASS`.

Screenshots and videos should use synthetic content and be reviewed before public
attachment. Crop or redact notifications, QR codes, invoices, order/customer
details, pubkeys, connection strings, relay endpoints, browser profiles, and local
paths. A visual artifact is supporting evidence; it does not replace the device
and version fields.

## Dry-run log template

Copy this section for each full run. The baseline below is intentionally `NOT RUN`;
it makes no automated, browser, or real-device validation claim.

### Baseline run — NOT RUN

- Date/time (UTC): `NOT RUN`
- Tested commit/build: `NOT RUN`
- Runner: `NOT RUN`
- Playwright WebKit project/version: `NOT RUN`
- Playwright mobile Chromium project/version: `NOT RUN`
- Current iPhone model / iOS / Safari build / Private Relay: `NOT RUN`
- Previous iPhone model / iOS / Safari build / Private Relay: `NOT RUN`
- Android model / Android / Chrome / WebView / Amber: `NOT RUN`
- Desktop OS / browser: `NOT RUN`
- Synthetic inventory starting quantity: `NOT RUN`
- Total duration: `NOT RUN`
- Overall result: `NOT RUN`

| Requirement | Playwright WebKit | Mobile Chromium | iPhone current | iPhone previous | Android Chrome | Desktop | Evidence/failure link |
| ----------- | ----------------- | --------------- | -------------- | --------------- | -------------- | ------- | --------------------- |
| P1-01       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-02       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-03       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-04       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-05       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-06       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-07       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-08       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-09       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-10       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-11       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P1-12       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P2-01       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |
| P2-02       | NOT RUN           | NOT RUN         | NOT RUN        | NOT RUN         | NOT RUN        | NOT RUN | —                     |

Before closing a run, verify that every required matrix cell is `PASS`, `FAIL`, or
`BLOCKED`, the duration is under two hours, and every `FAIL` has a reproducible
record. Keep unresolved checks visible as remaining manual work.

[ios-current]: https://support.apple.com/en-us/128066
[ios-previous]: https://support.apple.com/en-la/127111
[nip-46]: https://github.com/nostr-protocol/nips/blob/master/46.md
[playwright-browsers]: https://playwright.dev/docs/browsers
[playwright-emulation]: https://playwright.dev/docs/emulation
[webkit-302561]: https://bugs.webkit.org/show_bug.cgi?id=302561
