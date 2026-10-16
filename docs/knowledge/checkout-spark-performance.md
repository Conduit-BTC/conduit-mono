# Checkout Spark workflow performance

These measurements distinguish work performed by the financial workflow from
waiting owned by its foreground scheduler. They combine synthetic, content-free
regression evidence with a local emitted-artifact census, not funded-provider,
phone, relay or production latency claims. The payment contracts in
[the router spec](../specs/universal-checkout-router.md)
and [native final collection](checkout-spark-native-treasury.md) remain authoritative.

For the before/after preparation baseline, bounded read concurrency and
per-destination observation reuse, see [preparation measurements](checkout-router-preparation-latency.md).
For emitted startup JavaScript rather than device timings, see the
[startup bundle census](checkout-startup-bundle-census.md).

## Preparation to invoice-ready

The composed preparation fixture now covers actual settled-order entry through
funding preparation and bound-order publication to ready, including controlled
wallet initialization, hidden funding-invoice creation and recovery ACK ports.
With 10 ms per admitted read wave, 1/3/8 recipients improve as follows:

| Whole preparation to ready | 1 recipient | 3 recipients | 8 recipients |
| -------------------------- | ----------: | -----------: | -----------: |
| Baseline controlled ms     |          70 |          130 |          280 |
| Current controlled ms      |          60 |           60 |           80 |

There are two samples per recipient count: fresh and repeated invocations with
the same signed inputs and independent stores. They agree; neither is a real
warm-wallet or network distribution. See the linked preparation note for stage
timings, source baseline, before/after commands and unchanged safety checks.
Approval, external-wallet handoff and user funding wait remain explicitly
excluded. These values must not be added to the differently composed workflow
sampler below as though they were one end-to-end trace.

## Reproduce the workflow census

From the repository root:

```sh
bun run scripts/dev/measure_checkout_spark_workflow.ts
```

The script exercises the real shared financial workflow and Buyer native
provider/commerce-proof helpers against synthetic provider and storage ports.
It uses fresh runtime Nostr identities, valid synthetic invoice/preimage pairs
and a nondecreasing injected clock. Each selected provider read, preflight, send
or recovery-ACK port advances that clock by exactly 10 ms; local storage,
authority callbacks and inspection-handle open/cleanup add no virtual time.
These are controlled port delays, not raw SDK request delays. The script does
not initialize a real wallet, read environment credentials, contact a network
or make a payment. Output contains scenario names, outcomes, elapsed durations
and aggregate counters only.

For each 1/3/8-commerce-leg case, it runs three fresh synthetic-port fixtures,
then three samples reusing one synthetic manager/repository-port fixture. The
reused fixture resets its fake provider/store state between samples; this is
repeat-path isolation, not production payment replay or real warm SDK evidence.
Each complete sample proves credit admission, settles all commerce and commits
the native leg. A subsequent shared-workflow invocation re-attests the exact
saved commerce, reports `already_paid` without another send, and retains the
active wallet/recovery state. Failure throws instead of reporting a successful
sample. Automatic wallet retirement is not part of the current completion path.

The script reports sample count, median and maximum for each phase. Virtual
provider/transport time and actual local fixture-execution wall time are separate
clock domains; do not add them together. The latter has no real provider wait
and is not application CPU profiling. Fixture acquisition reports wall time and
construction count, not checkout setup or invoice-ready time. Reused-fixture
acquisition intentionally performs no construction after the first sample.
External user funding wait is explicitly `not-sampled`. No observed network
distribution, p95, throughput or physical-device result is implied.
Counts describe these scenarios and may improve; they are not permanent protocol
requirements or a reason to remove fresh authority/evidence checkpoints.

### Controlled phase timing

Both fresh-port and same-port groups produced these virtual durations. Each
cell is the median **and** maximum of its three samples, in milliseconds, with
fixed 10 ms port latency. This is a reproducible service-delay model, not a
prediction for live checkout.

| Measured phase                                      | 1 commerce leg | 3 commerce legs | 8 commerce legs |
| --------------------------------------------------- | -------------: | --------------: | --------------: |
| Exact funding observation and Core credit admission |             10 |              10 |              10 |
| Preprepared Core commerce completion                |             70 |             270 |            1120 |
| Buyer native commitment                             |            380 |             500 |             800 |
| Completed-state reconciliation                      |             10 |              30 |              80 |

The final phase repeats the shared workflow against its retained all-paid
state. It performs 1/3/8 exact commerce-history reads and paid-fact callbacks,
with zero new sends, preflights, recovery acknowledgements or wallet-inspection
opens. This is not a fresh receiver claim or a safe-retirement measurement.
The earlier native-commitment phase independently proves its own exact payment;
the repeat does not manufacture or replace that proof. The fixture does not
compose the Merchant claim-capable recovery adapter.

### First native finalization after all commerce is paid

Each scenario starts with independently checkable paid commerce and no native
intent. Every run completes the native leg exactly once.

| Provider/application port         | 1 commerce leg | 3 commerce legs | 8 commerce legs |
| --------------------------------- | -------------: | --------------: | --------------: |
| Exact Lightning history           |              6 |              18 |              48 |
| Exact funding credit              |              5 |               5 |               5 |
| Full-history pages                |              8 |               8 |               8 |
| Available balance                 |              4 |               4 |               4 |
| Owned balance                     |              4 |               4 |               4 |
| Pending-transfer lists            |              4 |               4 |               4 |
| Inspection reader open / cleanup  |          4 / 4 |           4 / 4 |           4 / 4 |
| Native inspect / preflight / send |      2 / 1 / 1 |       2 / 1 / 1 |       2 / 1 / 1 |
| Recovery acknowledgement callback |              3 |               3 |               3 |
| Local invoice-origin checks       |              5 |              15 |              40 |

These are port invocations, not raw SDK requests. Each full-history scan fits
one page here. The eight pages represent four separately guarded equal-scan
pairs, not pagination. Recovery callbacks do not prove live relay acceptance.
Receiver-network calls are zero because these fixtures have no receiver binding;
this does not measure qualified receiver verification or promise a verifier cache
hit for real payments.

The shared workflow first re-attests the commerce intents. Native preparation,
preflight admission, post-submitted-ACK admission and the final SDK send guard
then independently prove commerce; successful native reconciliation rechecks the
commerce facts without the pre-send balance test. These boundaries explain the
repetition and must not be collapsed into an across-phase evidence cache.

### Shared-owner commerce execution

The commerce phase starts with every commerce intent already prepared. It runs
one commerce advancement per leg; this phase excludes the later native leg and
does not use the commerce app/SDK send adapter. All commerce settles exactly once.

| Shared-workflow port              | 1 commerce leg | 3 commerce legs | 8 commerce legs |
| --------------------------------- | -------------: | --------------: | --------------: |
| Exact reconcile                   |              2 |              12 |              72 |
| Paid-fact callback                |              1 |               6 |              36 |
| Recovery acknowledgement callback |              3 |               9 |              24 |
| Preflight / send                  |          1 / 1 |           3 / 3 |           8 / 8 |

This fixture exposes repeated sibling observations, including paid intents.
It is not a complete end-to-end checkout cost: sequential invoice preparation,
the concrete SDK adapter, receiver binding and renewals add other
work. Do not combine the two tables into an estimated live latency.

## Nested Buyer observation measurements

These tests exercise the real exact-Lightning SDK reconciliation and the actual
Buyer foreground runner with controlled clocks. No production timeout or
takeover policy changes are made by the measurements.

```sh
bun test tests/spark-sdk.test.ts --test-name-pattern 'measures the default exact Lightning polling bound'
bun test tests/checkout-spark-settled-shopper-runner.test.ts --test-name-pattern 'measures'
```

The raw SDK cases use 1/3/8 independent attempts, not a whole Buyer checkout:

| Raw exact-SDK observation                             | 1 attempt | 3 attempts | 8 attempts |
| ----------------------------------------------------- | --------: | ---------: | ---------: |
| Pending → paid at first 500 ms poll: total virtual ms |       500 |       1500 |       4000 |
| Status reads for those completed attempts             |         1 |          3 |          8 |
| Never paid: total virtual ms                          |     60000 |     180000 |     480000 |
| Status reads for those pending attempts               |       120 |        360 |        960 |

Every case makes zero sends. The default 60-second value is a per-observation
ceiling, not a fixed successful-payment delay. Native calls have no additional
injected latency here. The SDK-open fixture's five consecutive privacy
observations require four 500 ms waits (2000 ms); those waits are deliberately
excluded from this exact-observation table, not interpreted as real SDK startup.

The composed Buyer cases distinguish its outer waits from nested SDK waiting:

| Buyer case                                                              | Total virtual ms | SDK wait / status reads | Outer waits         | Send invocations |
| ----------------------------------------------------------------------- | ---------------: | ----------------------- | ------------------- | ---------------: |
| First leg's history missing until third outer wait, 1/3/8 commerce legs |       11000 each | 0 / 0                   | 2000, 4000, 5000 ms |        2 / 4 / 9 |
| One commerce leg plus Lightning fee, each ready after 125000 ms         |           250000 | 244000 ms / 488         | 2000, 4000 ms       |                2 |
| First admitted payout permanently pending                               |           311000 | 300000 ms / 600         | 2000, 4000, 5000 ms |                1 |

Every composed case invokes the funding payer once and does not replay a payout.
The last case returns `paused / reconciliation_timeout`; an already admitted
exact observation drains rather than being mistaken for cancellation. The nested
250000/311000 ms fixtures preserve their existing **45-minute takeover** solely
to isolate the five-minute checking budget. They do not authorize new two-minute
plans to dispatch later payouts after handoff. Ordinary current-session and
handoff guards remain unchanged. Controlled waiting is not live-provider speed,
external user payment wait or evidence supporting a shorter safety deadline.

## Merchant wallet-open lifecycle

The separate composed Merchant census exercises actual advancement, credit,
history, signed selection, preparation, continuation and recipient proofs with
typed device-local storage. It measures the supported
historical **ordinary Lightning Conduit fee leg** (`lightning_fee_leg`), not
schema-four native treasury wallet lifetimes.

```sh
bun scripts/dev/measure_checkout_spark_merchant_lifecycle.ts
bun test tests/checkout-spark-merchant-lifecycle-measurement.test.ts
```

| Measured lifecycle call                    | 1 commerce leg | 3 commerce legs | 8 commerce legs |
| ------------------------------------------ | -------------: | --------------: | --------------: |
| Credit inspection wallet opens             |              1 |               1 |               1 |
| Payout history wallet opens                |              3 |               7 |              17 |
| Preparation wallet opens                   |              2 |               4 |               9 |
| Continuation wallet opens                  |              2 |               4 |               9 |
| Total opens / cleanups                     |          8 / 8 |         16 / 16 |         36 / 36 |
| Sends, including the Lightning fee         |              2 |               4 |               9 |
| Advancement invocations                    |              5 |               9 |              19 |
| Controlled initialization contribution, ms |            800 |            1600 |            3600 |

Each case is one complete offline sequence. The fixed 100 ms per open is a
sensitivity-model input, not measured native initialization. Maximum concurrent
wallets remain one. All-paid advancement returns `verified`, retaining the
active exact payment/recovery state; a repeated completed invocation adds zero
opens and zero sends and leaves that saved state unchanged. Automatic wallet
retirement is neither invoked nor measured. The harness
limits its module substitution to the recovery credential transport; wallet and
provider ports are controlled fixtures. It runs that mock in an isolated
subprocess so it cannot affect other tests. Exact typed progress
snapshots and opaque signed wrap fixtures advance between phases. Network
attempts are rejected. Relay/discovery/decrypt/signing costs, real provider
initialization and real cold/warm/device behavior are not measured. Do not add
this historical Lightning-plan table to the native-finalization census.

## Startup emitted-byte measurement

One optimized `local`-profile build yielded these initial static JavaScript
closures. The [startup bundle census](checkout-startup-bundle-census.md) contains
the import-graph method, dynamic and other emitted bytes, commands and limits.

| App      | Initial raw bytes | Computed per-file gzip-9 bytes |
| -------- | ----------------: | -----------------------------: |
| Market   |         5,081,591 |                      1,406,738 |
| Merchant |         4,802,684 |                      1,304,854 |

This is an artifact-size baseline, not a before/after optimization or phone
timing. Computed gzip sizes are not observed HTTP/CDN transfer sizes. Module
evaluation, cache effects, rendering, SDK initialization, CSS/fonts/images and
managed deployment startup remain outside the byte census.

## Scheduling result and follow-up disposition

The shared scheduling improvement belongs to the Merchant reconciliation
worker: after a completed phase leaves the same signed discovery candidate in
place, a guarded progress hint avoids misclassifying that progress as an
unchanged pending observation. The controlled-clock reproduction changes the
next worker-owned wait from 30,000 ms to 750 ms. This is a scheduling-delay
measurement, not a claim that wallet or relay operations become that much faster.
The hint is neither signed progress nor send authority; the next operation must
still authenticate the current order, session, takeover deadline and exact
provider evidence.

The composed regression is
`tests/checkout-spark-merchant-progress-scheduling.test.ts`:

```sh
bun test tests/checkout-spark-merchant-progress-scheduling.test.ts
```

It composes the app advancement, discovery controller and shared worker through
offline signed-page/provider/receipt seams. An unchanged candidate after
successful progress formerly waited 30,000 ms; the guarded path waits 750 ms.
A fresh signed pointer already wakes after 750 ms. Unchanged uncertain progress
still uses the existing 30,000 ms cooldown. All values use the injected clock,
not wall-clock provider samples.

The other measured candidates remain separate. These role-based handoffs
describe technical follow-up, not release approval.

| Candidate                           | Measured disposition and reason                                                                                                                                                                                                            | Owner role                                                    | Next action                                                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2. Repeated commerce re-attestation | Defer broad reuse. The native census measures 6/18/48 exact-history reads; several repeats cross durable state, recovery ACK and send-admission boundaries, where freshness is intentional.                                                | Shared financial-workflow maintainer                          | Evaluate concurrency or observation sharing only within one guarded unchanged-revision phase; count qualified receiver requests separately and retain every later fresh pre-send/uncertain-send check.                                     |
| 4. Nested Buyer observation waits   | Defer a polling-policy change. Controlled SDK/runner cases now demonstrate the nested waiting and admitted-read drain; 60 seconds is a ceiling, not unavoidable paid latency, and fewer checks alone do not establish safe admission.      | Wallet-adapter and Buyer foreground-runner maintainers        | Compare a single-observation adapter whose runner owns waiting against the measured pending cases, preserving the five-minute admission bound, handoff, exact reconciliation and no replay. Events may wake checks, never prove payment.   |
| 5. Merchant wallet lifetimes        | Defer lifetime pooling. The historical Lightning-plan census measures 8/16/36 bounded open/cleanup pairs and 800/1600/3600 ms only under the injected 100 ms/open model; real cold/warm cost and native-treasury lifetimes remain unknown. | Merchant recovery and wallet-lifecycle maintainers            | Measure real initialization plus native-path lifetimes, then assess bounded same-order reuse with exact identity, local locking, query-only/claim-capable separation, revocation and drained-cleanup negatives; no broad credential cache. |
| 6. Startup/SDK loading              | Defer import/startup changes. Initial static closures are now measured at approximately 5.1/4.8 million raw bytes; bytes do not identify evaluation cost or the effect of already-dynamic SDK loading.                                     | Frontend performance maintainer, with wallet-lifecycle review | Profile a managed build's cold-cache and same-context repeat transfer/evaluation/first-usable UI with external networking blocked, then repeat on a physical phone before moving imports or wallet initialization.                         |

Together the fixtures now cover controlled preparation-to-ready, funding
observation, commerce completion, native commitment and a separate composed
Merchant recovery-to-verified-completion lifecycle with retained wallets. They are complementary measurements,
not one deployed end-to-end trace or a measured latency distribution. Real SDK
cold/warm initialization, native-path Merchant lifetimes, qualified receiving
service latency, mobile behavior and external user funding waits remain
unsampled. Do not relabel behavior-only tests or computed bundle bytes as those
timings.

No deadline shortening, ACK skipping, receiver-proof relaxation, optimistic paid
projection or possible-send replay is part of the performance improvement.
The samplers follow the existing retained-wallet completion behavior; they do
not restore automatic retirement or equate a payment with safe wallet deletion.
Synthetic checks cannot close the existing funded,
mobile-lifecycle, receiving-provider or maintainer-owned release-validation gaps.
