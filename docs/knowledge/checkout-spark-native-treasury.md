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
Pre-funding approval explains this policy. The receipt reports the actual
Conduit allocation, collected unused reserves and native total separately.

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
IDs. Available and owned funds must equal the attributed remainder, with no
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

The implementation is pinned to Spark SDK 0.12.1, with a pure injected codec and
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
