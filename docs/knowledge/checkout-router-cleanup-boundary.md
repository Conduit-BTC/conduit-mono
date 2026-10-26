# Checkout router cleanup boundary

New paid checkout uses `prepareCheckoutSparkSettledOrder` and the settled
preparation/funding/shopper runner. The retired Market chain
(`checkout-spark-router-preparation`, `checkout-spark-router-funding`,
`checkout-spark-shopper-advance`, `checkout-spark-outgoing-provider`, and
`checkout-spark-recipient-invoice-witness`) had no application entry-point
caller. Its private tests and witness fixture were removed with it.

This does not retire historical payment state. Keep the Core plan parsers,
reconciliation repositories, recovery readers, encrypted handoffs, tombstones,
and merchant recovery paths. Keep direct-pay order recovery and the active
negotiated/free-order paths. No stored record is migrated or deleted by this
cleanup. The shared preparation lock name also remains stable across tabs.

## Coverage on the live implementation

| Removed coverage                                                          | Retained or moved coverage                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preparation funding terms and recovery-before-disclosure                  | `tests/checkout-spark-settled-preparation.test.ts` and `checkout-spark-settled-preparation-recovery.test.ts`; provider wallet/network/amount/expiry/identity mismatch cases now exercise the live preparation boundary |
| Funding attempt reservation, uncertain result, exact credit and no replay | `tests/checkout-spark-settled-preparation.test.ts` and `checkout-spark-settled-external-funding.test.ts`                                                                                                               |
| Shopper advancement and frozen outgoing invoices                          | `tests/checkout-spark-settled-shopper-runner.test.ts`, `checkout-spark-shared-leg-preparation.test.ts`, and `checkout-spark-settled-outgoing-provider.test.ts`                                                         |
| Recipient invoice/profile evidence                                        | Shared leg preparation, recipient profile, and LNURL invoice tests; settled invoice preparation occurs after funding, so obsolete pre-funding assumptions are not carried forward                                      |
| End-to-end router composition                                             | `tests/checkout-spark-settled-vertical.test.ts` and the commerce router Playwright suite                                                                                                                               |
| Preparation persistence across tabs                                       | `e2e/checkout-spark-browser-runtime.playwright.ts` now uses the live settled store and its busy-tab refusal, retry, reload, and unsupported-lock behavior                                                              |
| Historical local recovery                                                 | The same browser file retains Core repository reload/tombstone/replay checks and concurrent recovery-outbox persistence; Core recovery and reconciliation unit tests remain                                            |

The unused Market wallet-retention forwarding module is gone; tests import the
same Core implementation used by wallet registry reloads. The shared Core
retention guard and its historical takeover-window tests remain.

The obsolete manual-invoice identity helper's test only asserted that its input
was returned unchanged. Actual invoice requests, payment proofs, persisted
attempt recovery, and their tests remain in place.
