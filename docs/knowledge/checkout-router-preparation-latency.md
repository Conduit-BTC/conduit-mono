# Checkout Router Preparation: Controlled Read Baseline

## Evidence and scope

The offline fixtures exercise the real Market settled-order entry and funding
preparation boundaries. They create valid runtime-signed synthetic products and
profiles, inject controlled profile/LNURL reads, and replace wallet and delivery
operations with existing deterministic fixtures. They do not contact a relay,
receiver, wallet provider or signer service.

Each pending read is held behind a gate. One release wave completes the reads
currently admitted together; another wave is required for work admitted later.
This measures request counts and dependency serialization without a flaky
wall-clock threshold. Each release advances a test-owned monotonic diagnostic
clock by 10 ms. An outer `observeCheckoutSparkOperation` measures the real
preparation call against that clock; financial clocks keep their existing fixed
fixture value. The isolated read cases have one sample per recipient count.
The composed preparation case has two samples per recipient count: fresh and
repeated client invocations with the same signed inputs and independent stores.
Neither is a latency distribution, percentile, live-provider benchmark or
hosted-release sign-off. CPU work and test-fixture construction are not timed by
the virtual clock.

The baseline is commit `2029d606`. The comparison uses identical current
fixtures with only the two preparation modules loaded from that commit into an
isolated test process. No checkout files, saved plans or deadlines are rewritten.

| Read boundary    | Recipients | Baseline requests | Current requests | Baseline max in flight | Current max in flight | Baseline release waves | Current release waves |
| ---------------- | ---------: | ----------------: | ---------------: | ---------------------: | --------------------: | ---------------------: | --------------------: |
| Payment profiles |          1 |                 1 |                1 |                      1 |                     1 |                      1 |                     1 |
| Payment profiles |          3 |                 3 |                3 |                      1 |                     3 |                      3 |                     1 |
| Payment profiles |          8 |                 8 |                8 |                      1 |                     4 |                      8 |                     2 |
| LNURL metadata   |          1 |                 2 |                1 |                      1 |                     1 |                      2 |                     1 |
| LNURL metadata   |          3 |                 6 |                3 |                      1 |                     3 |                      6 |                     1 |
| LNURL metadata   |          8 |                16 |                8 |                      1 |                     4 |                     16 |                     2 |

The metadata fixture uses distinct endpoints. A separate shared-endpoint case
asserts one observation when Merchant and supplier authorize the same address.
Two isolated preparations of the same destination each perform a fresh read;
the second invocation is not a claim about warm provider latency. Failed
observations are not retained for retry.

## Controlled preparation-to-ready timings

The composed case invokes real settled-order entry, real funding preparation
and their unchanged validation/storage boundaries. Existing provider fixtures
hold profile and metadata reads, wallet initialization, hidden funding-invoice
creation, recovery acknowledgement and order publication behind controlled
gates. The outer diagnostic observer ends when the prepared order returns.
Stage durations are captured at those actual call boundaries, not inferred only
from expected request counts. Fresh and repeated invocations produced the same
values below for both baseline and current implementations.

All values are controlled milliseconds with 10 ms per admitted network wave:

| Stage                                         | Baseline 1 | Current 1 | Baseline 3 | Current 3 | Baseline 8 | Current 8 |
| --------------------------------------------- | ---------: | --------: | ---------: | --------: | ---------: | --------: |
| Recipient profiles                            |         10 |        10 |         30 |        10 |         80 |        20 |
| LNURL metadata                                |         20 |        10 |         60 |        10 |        160 |        20 |
| Endpoint preflight, including both rows above |         30 |        20 |         90 |        20 |        240 |        40 |
| Wallet initialization                         |         10 |        10 |         10 |        10 |         10 |        10 |
| Hidden funding-invoice creation               |         10 |        10 |         10 |        10 |         10 |        10 |
| Recovery ACK                                  |         10 |        10 |         10 |        10 |         10 |        10 |
| Funding preparation, metadata through ACK     |         50 |        40 |         90 |        40 |        190 |        50 |
| Bound-order publication to ready              |         10 |        10 |         10 |        10 |         10 |        10 |
| Whole preparation to ready                    |         70 |        60 |        130 |        60 |        280 |        80 |

The preflight and funding-preparation rows overlap their component rows; they
are not additional costs. Synchronous signed-term checks still run but have no
injected delay. The controlled fixed wallet/invoice/ACK/order weights are test
inputs, not measurements of deployed services. No external funding payment is
submitted. Shopper approval, mobile-wallet handoff and external funding wait
are user time: explicitly excluded and not sampled. This evidence covers
preparation, not post-funding commerce execution or retirement.

## Reproduce

From the repository root, run the deliberately red baseline comparison:

```sh
bun test --preload ./scripts/dev/checkout_router_preparation_baseline.ts tests/checkout-spark-settled-preparation.test.ts tests/checkout-spark-multi-item-entry.test.ts --test-name-pattern 'shares one fresh observation|bounds independent payout|measures controlled preparation-to-ready'
```

The current concurrency/request assertions fail against the baseline. Its
single-recipient profile control retains the same read/wave counts but also
fails the new diagnostic-observer assertion, because that observer did not
exist at the baseline. The preload requires the baseline commit to be available
in local Git history.

Run the same controlled cases against the current implementation:

```sh
bun test tests/checkout-spark-settled-preparation.test.ts tests/checkout-spark-multi-item-entry.test.ts --test-name-pattern 'shares one fresh observation|bounds independent payout|measures controlled preparation-to-ready'
```

Run the complete focused preparation safety checks:

```sh
bun test tests/checkout-spark-preparation-reads.test.ts tests/checkout-spark-settled-preparation.test.ts tests/checkout-spark-multi-item-entry.test.ts tests/checkout-spark-settled-entry.test.ts
```

## Preserved boundaries

Only independent, read-only preparation work overlaps, with at most four reads
in flight per batch. Results retain canonical obligation order. Failure or
revoked buyer/guest authority stops queued work; all admitted reads drain before
the operation rejects. No wallet, funding invoice or private order is created
from a failed/revoked preflight. Payment-scope relay policy, exact selected signed
revisions, receiving qualification, allocation/range checks, financial clocks,
funding disclosure, recovery acknowledgement and provider-send authority remain
unchanged.

Range readiness and receiving qualification consume the same fresh LNURL
observation within one destination's preparation. This is not a persistent or
cross-preparation cache, invoice authority or permission to skip later recipient
and settlement verification. Diagnostic observers receive only allowlisted
operation labels, operation status, bounded duration and a count; they do not
receive destinations, signed events, invoice/provider payloads or errors.
