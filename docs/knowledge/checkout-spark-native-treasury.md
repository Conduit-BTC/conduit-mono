# Checkout Spark native final collection

The native final fee rail applies only to new checkout plans created with an
approved, configured Spark treasury receive address. It does not convert
historical funded Lightning plans or sweep arbitrary wallet balances.

## Payment order and accounting

`Merchant → supplier split(s) → one native Spark payment to Conduit`

All required commerce payments must independently settle first. Let `C` be the
net credit attributed to the exact funding receive, and `Dᵢ` each verified
commerce winner's total debit, including its actual outgoing fee:

`Final native collection = C − ΣDᵢ`

That amount consists of the settled Conduit allocation plus unused authorized
commerce fee reserves. Each commerce invoice and its maximum fee exactly fill
that recipient's allocation; the unused portion is the difference between its
reserved and actual outgoing fee. An archived replacement attempt must have
fresh exact proof of terminal closure and zero net debit.

The checkout's small inbound network allowance is not a ceiling on unused
outgoing reserves. The final collection can therefore differ from the displayed
coordination estimate, while the fixed buyer funding total cannot increase.
Pre-funding approval explains this policy in a concise note. Recorded payment
data retains the actual Conduit allocation, collected unused reserves and
native total separately; the ordinary buyer view shows aggregate payment
accounting without another native-transfer detail panel.

## Frozen destination and request

Spark receiving addresses identify a wallet on a network and are reusable.
Clients receive only this public address, never a treasury seed or signing key.
The pinned SDK codec validates its network and canonical encoding and rejects
an invoice-bearing address as deployment configuration.

Before funding is exposed, each plan freezes a deterministic invoice UUID and
a canonical, unsigned, sender-restricted, open-amount Spark invoice request.
The checkout wallet identity is the only permitted sender; the approved
treasury identity is the receiver. The amount is frozen only after exact
commerce settlement. The invoice UUID is not a fabricated provider transfer ID.

Both Market and Merchant use the same public configuration. Approved retired
addresses remain explicitly allowlisted during rotation; old plans never
redirect to a new destination. See [deployment configuration](quantum-router-deployment.md).

## Safe execution and recovery

Preparation requires fresh authenticated exact credit, recipient-origin
evidence, successful commerce history and net-zero closed attempts. Before
sending, two complete equal wallet-history scans must contain only these known
payment IDs or positively proven internal swaps described below. Available and
owned funds must equal the attributed remainder, with no
pending transfers. Extra deposits, unknown outgoing activity, partial history
or unavailable evidence pause collection rather than enlarge or subsidize it.

The pinned native adapter requires a zero provider fee. A future nonzero or
unknown fee pauses; the client does not reduce the amount or silently switch
rails. Prepared and possible-send snapshots are durably saved and their private
recovery packages acknowledged before submission.

Once submission may have occurred, reload and merchant recovery query the same
request and actual provider transfer. Absence or a timeout does not authorize
another send. A completed invoice query alone is insufficient: exact sender,
receiver, network, amount, outgoing transfer type and claimed terminal completion
must also match. Pending/finalized-but-unclaimed transfers are not paid receipts.

Commerce remains paid if final fee collection needs attention. Recovery material
is retained until all exact payments are independently verified and an
authenticated complete zero-owned/available/pending inspection permits local
retirement. Zero attributed remainder causes no native send and no invented
paid receipt. This is not an always-on executor or a guarantee against funds
arriving after terminal observation.

## Proposed legal wording

For maintainer/legal review, not an effective Terms release:

> The coordination fee is a best-effort estimate. After the required recipient
> payments settle, Conduit receives its settled fee allocation and any unused
> authorized routing-fee reserves in one final Spark transfer. Actual collection
> may differ from the estimate, but cannot increase the checkout total you
> approved. The payment receipt shows the amount actually collected.

Released archived legal text is unchanged. Publication requires the existing
[new-version and effective-date process](product-legal-documents.md).

## Provider references and validation boundary

The implementation is pinned to Spark SDK 0.13.0, with a pure injected codec and
provider port in Core and separate app adapters. Relevant public references:

- [Spark invoices](https://docs.spark.money/wallets/spark-invoices)
- [Spark addressing](https://docs.spark.money/wallets/addressing)
- [Create sats invoice](https://docs.spark.money/api-reference/wallet/create-sats-invoice)
- [Query Spark invoices](https://docs.spark.money/api-reference/wallet/query-spark-invoices)
- [Native transfers](https://docs.spark.money/api-reference/wallet/transfer)
- [Balances](https://docs.spark.money/wallets/balances)
- [Fee estimates](https://docs.spark.money/api-reference/wallet/estimate-fees)

Synthetic tests exercise amount attribution, recipient binding, relay recovery,
possible-send replay protection and retirement. They do not establish deployed
provider behavior. Funded buyer routing and cold Merchant recovery on the
candidate build remain maintainer-owned release validation.

## Session Context Updates

<!-- session-doc-update:7105ba65b8da -->

### 2026-10-05

Completed internal denomination swaps may appear alongside the expected payment
IDs. Each extra swap needs fresh authenticated SDK history and SSP request
evidence: a unique succeeded zero-fee primary/counter pair on the frozen network,
exact checkout-to-configured-SSP and return ownership, exact returned-leaf links,
and equal conserved values. Two complete stable scans must agree on both history
and request facts. Type labels, equal amounts, balance alone, partial pairs and
unavailable evidence cannot authorize collection or exact-history retirement.

<!-- session-doc-update:dcc55dcbb64f -->

### 2026-10-08T17:35:40.342Z

Buyer execution and claim-capable Merchant recovery share the Core financial
workflow. Core owns verified credit admission, fact-before-projection persistence,
exact sibling-attempt reconciliation, next-obligation preparation, write-ahead
execution, Conduit-last collection, and evidence-gated retirement. Actor adapters
retain session/time authority, independent receiver proofs, provider operations,
storage and protected delivery. Authority is checked across asynchronous boundaries;
an actor label is not permission. Immediate Merchant observation remains a separate,
query-only path without wallet claim or send capability.

New credit below the frozen funding weights pauses rather than reducing approved
obligations. Historical short-funded projections remain readable for reconciliation,
but cannot authorize another payout. No additional funding or refund flow is implied.

A positive pre-provider cancellation may permit an exact native-intent retry only
after durable cancellation readback, using a process-local capability bound to the
same repository, revision and immutable intent. Imported failure labels, missing
history and actual or possible provider invocations cannot authorize replay.

Completed local execution queues are cleaned only after the exact durable terminal
marker and encrypted recovery archive are read back. Interrupted cleanup resumes
without reopening the wallet or invoking a payment provider. Terminal cleanup may
retry at most four exact stored recovery envelopes within one ten-second transport
window; it never signs a replacement envelope. Fresh checkout preparation performs
local-only cleanup instead of waiting on these network retries. Unacknowledged
delivery and late, revoked callbacks cannot authorize payment or discard evidence.
Encrypted recovery evidence,
independent settlement facts, replay markers and required pending delivery work are
retained. Local queue cleanup does not establish atomic provider-side closure or
prove that funds cannot arrive later.
