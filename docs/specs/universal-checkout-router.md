# Universal Checkout-Scoped Spark Router

## Scope and authority

This is the contract for new Conduit-coordinated upfront checkout payments.
An enabled router uses one shopper-created, isolated checkout-scoped Spark
wallet, one ordinary private Lightning funding invoice and one immutable
authorized plan. NWC, WebLN, a registered Portable Wallet and an external
Lightning wallet fund that invoice; they do not bypass the router to pay
recipients directly.

Price currency and a selected product variation do not justify a direct-pay
fallback. Resolve the validated final SAT quote and bind the exact signed
listing revisions, selected variation, quantity and agreed fulfillment and
shipping. Preserve source price/currency, conversion evidence and selected
specifications needed to independently validate that quote. A conversion is
not a merchant-signed exchange-rate oracle. Shipping-table allocations must
retain their exact signed policy and per-line allocation, not an invented
unit fee.

Valid existing listings do not require republishing or a router opt-in marker.
Unmarked listings retain their ordinary merchant allocation; marked supplier
terms require the exact signed revision. Missing or unsupported authority
blocks coordinated upfront payment before funding rather than enabling a
direct recipient payment. Free orders need no funding. Shipping or payment
that genuinely requires Merchant negotiation remains an order/DM flow outside
upfront coordination. Event-Market-specific admission, organizer commissions
and optional public payout activity have separate contracts; this contract
does not invent their missing authority.

Historical direct-payment orders and funded router plans retain their original
payment and fulfillment semantics. Hosted activation, implementation coverage,
deterministic tests, funded acceptance and production observation are separate
facts; this contract is not a release sign-off.

## Approval, funding and disclosure

1. Validate current signed commerce, allocation, recipient and fulfillment
   evidence. Freeze checkout/order identities, exact revisions, quantity,
   pricing and shipping snapshots, ordered obligations, destinations, stable
   outgoing identifiers and fee responsibility.
2. Obtain approval of the fixed funding total, best-effort coordination fee
   estimate, payment reserves, recipient fee deductions and Conduit-last
   collection. The coordination allocation is added on top of the authorized
   commerce amount, including agreed shipping; it does not replace that amount.
   A changed plan, destination, allocation policy, spending limit or funding
   fee/total revokes the old approval. Fitting an outgoing fee within
   its already authorized allocation does not change that funding total.
3. Create the isolated wallet and hidden funding invoice. Validate the actual
   signed invoice's amount, network and expiry, and freeze wallet/invoice
   identity in the versioned plan. Unavailable prerequisites preserve intent
   and recovery state without exposing an invoice or choosing another rail.
4. Require a valid current Merchant-authored kind `10050`. Use the standard
   [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) delivery and
   [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) protection
   for the exact machine-only Merchant recovery message. Persist the exact
   encrypted wrapper before relay I/O and require the normal recipient-inbox
   relay acknowledgement before funding disclosure. Relay acceptance is not
   Merchant receipt, order acceptance or payment settlement. No nested
   application encryption, Merchant application ACK or generic DM/order
   compatibility route is added for this recovery capability.
5. Select an eligible funding source under its existing approval boundary.
   An explicit external Cash App/Lightning/copy/QR action must durably reserve
   possible payment before returning the same exact invoice. Mount, reload,
   changing a default or closing a panel does not authorize payment. Once
   submission or external disclosure may have occurred, an uncertain result
   remains bound to that invoice/source and cannot switch rails or pay again.

Funding is credit to the isolated wallet, not proof of any recipient payment.
Router funding and required settlement do not emit or claim a public NIP-57
request, receipt or checkout message. A public zap on an actual Merchant
payout is separate work under [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md).

## Preparation failure and exact continuation

Saving a plan or cart claim must not permanently block a purchase when recovery
delivery fails before an order exists. Continuation must match the original
durable order draft, plan, wallet, invoice, buyer, Merchant, network and source
authority; a newer cart is not a substitute.

When the exact encrypted wrapper survives, resume its persisted delivery and
read back its required acknowledgement. Preserve the same plan, wallet,
invoice and ciphertext even when a write, callback or acknowledgement reports
failure after committing. Do not mint a second exposed invoice.

Cleanup is permitted only for a positively proven pristine, unexposed
preparation with no credit, possible payment, outgoing intent, order binding or
recovery-delivery uncertainty. CAS-matched abandonment of that pristine
preparation and verified claim cleanup must succeed before the cart becomes
available for a new preparation. This is not retirement of a funded wallet or
permission to discard payment evidence. Failed cleanup, unreadable state,
changed ownership or possible exposure remains a
visible recovery state; absence, invoice age and aggregate balance alone do
not prove safe abandonment.

## Separate funding and execution deadlines

Normal new plans request a fifteen-minute funding invoice and freeze Merchant
takeover two minutes after preparation. The actual signed funding expiry is
validated. Existing plans keep their saved deadlines; neither a heartbeat nor
an inferred abandonment time rewrites them.

The same exact funding invoice may be presented or reopened until its funding
expiry, including after takeover, provided the current buyer/order, durable
recovery acknowledgement and exact funding guards still pass. Funding-only
approval, disclosure and payment do not restore buyer outgoing authority.
Merchant recovery can reconcile exact late credit under the original plan.
Expiry is not proof that payment never started and does not erase recovery or
authorize an automatic replacement funding invoice.

Buyer outgoing admission ends at the two-minute boundary. The existing
sixty-second preparation buffer for a new payout is separate from invoice
validity. A send admitted before handoff must drain or reconcile under its
same saved identifiers even when completion is late. A terminal result may be
reported only against the current bound order and buyer session; reporting a
saved paid fact grants no new send authority.

Within the same approved foreground activation, exact funding/outgoing checks
may continue with bounded backoff for at most five minutes. This is not an
always-running executor, extension of outgoing authority or permission to
re-enter a funding payer. Pause, hidden page, navigation, identity/order change
or withdrawn approval stops new dispatch. Reload requires renewed same-plan
approval and reconciliation, not automatic authorization.

## Settlement, Merchant trust and retirement

Conforming clients independently verify exact funding and each commerce
payment, including recipient association, before continuing. An invoice
signature, preimage, balance change, public receipt or imported buyer label
alone does not establish all required recipient and settlement facts. Unknown,
partial, contradictory or unavailable evidence pauses rather than replaying.
Buyer and Merchant use the same immutable obligations and attempt identifiers.
Independent browser stores and local locks are not a distributed lease;
provider duplicate/overlap behavior must be validated separately.

Merchant and supplier Lightning payments settle before Conduit. Each commerce
leg bears its own outgoing fee within its allocation. With the approved native
policy, final Conduit collection is the exact attributed funding credit minus
verified commerce debits: settled Conduit allocation plus unused authorized
commerce-fee reserves. It cannot increase the approved buyer total or collect
unrelated deposits. The configured public destination and canonical native
request are frozen; rotation cannot redirect an existing funded plan. Unknown
or nonzero native provider fees pause the supported zero-fee path. See
[native final collection](../knowledge/checkout-spark-native-treasury.md) and
[deployment policy](../knowledge/quantum-router-deployment.md).

Merchant recovery deliberately grants bearer spending control over only the
isolated checkout wallet from delivery of its credential. Handoff timing,
frozen allocations and Conduit-last ordering constrain conforming clients;
they are not cryptographic restrictions on a credential holder. Deliberate fee
circumvention is an accepted Merchant-abuse risk, not an automatic detection
capability. Supplier allocations are the Merchant's configured relationships,
not a Conduit guarantee against Merchant abuse. Incorrect destinations,
premature client dispatch, duplicate payments or credential disclosure outside
the intended recipient remain implementation defects. The exception gives no
access to the buyer's funding wallet and no Conduit-operated custody.

Recovery requires a retained relay copy and the Merchant eventually running a
client. There is no Conduit-held credential, background keeper or guaranteed
eventual settlement. After possible submission, query the same attempt; a
timeout or absent lookup cannot authorize another send. Native completion
requires exact claimed-transfer evidence, not only invoice finalization.

The bounded Merchant-only Lightning renewal in
[wallets.md](wallets.md#lightning-closed-attempt-invoice-renewal) requires positive
terminal unpaid closure, zero historical net debit and full spendable return. Preserve
the prior attempt in append-only history, create only its permitted successor
for the same frozen recipient, and persist/acknowledge the exact new recovery
snapshot before dispatch. Expiry, an imported prepared status or a wallet
balance is not renewal authority.

A final collection problem never makes paid commerce unpaid or repeats it.
Retirement separately requires conclusive terminal payment/claim/refund state,
fresh complete exact history and zero owned/available/pending funds. Keep a
non-secret terminal marker that rejects replay. Unknown activity or extra
funds blocks retirement; a zero attributed remainder does not fabricate a
native payment receipt.

## Privacy, guest scope and compatibility

Account signing remains external NIP-07/NIP-46. The isolated Spark credential
is not a Nostr account key or registered reusable wallet. Recovery plaintext
must not enter ordinary messages, order UI, search, notifications, logs,
telemetry, screenshots or support artifacts. Persist recovery wrappers and
necessary private reconciliation data only within their approved boundaries.

The guest capability in [protocol.md](protocol.md#client-ephemeral-guest-order-key-exception)
may separately seal canonical router recovery for the same order and Merchant
within its existing deadline. It cannot sign generic messages, direct rumors
or other recipients, create another account, extend the twenty-four-hour key
lifetime, or require a guest inbox/self-copy. Guest-key expiry stops new guest
signing, not exact encrypted-wrap retry or the Merchant's independent wallet
recovery authority.

New quote fields, payload versions and renewal generations must preserve old
funded plans' digests, recipients, rails and saved attempts. Unsupported
versions fail closed; missing legacy fields are not filled with current
pricing, destinations or a newer listing revision. Genuine negotiated orders
and historical direct/public-zap payments retain their original authority.

## Acceptance and remaining validation

- Exact signed SAT/converted-price/variation and shipping evidence produces
  one approved plan; missing or changed evidence fails before wallet work.
- Existing valid unmarked listings work without republishing. Unsupported
  upfront preflight never exposes a direct-recipient fallback.
- Durable recovery, required relay ACK and current disclosure guards precede
  every first external invoice action; missing ACK exposes no invoice.
- Plan creation, wrapper persistence and ACK failures reopen or safely abandon
  a pristine preparation without a second exposed invoice or permanently
  blocked cart.
- Funding remains available until exact expiry; outgoing admission ends at
  takeover. Late credit, completion and concurrent actors reconcile the same
  identifiers without assuming a distributed client lock.
- Funding adapters, bounded foreground checks, pause/reload, uncertainty,
  closed-attempt renewal, native final proof and retirement retain their
  independent guards and historical compatibility.
- Privacy and guest-scope negatives reject generic, cross-order, wrong-recipient,
  stale and malformed recovery without leaking payment or recovery material.

Tests must distinguish deterministic provider fixtures from deployed-provider
enforcement, real signer/relay cryptography, physical mobile wallet handoff and
funded receiving-side confirmation. Fresh uninterrupted funded checkout,
genuine Merchant fallback/device/inbox QA and cold-hosted attribution of
already-paid buyer-issued invoices remain explicit acceptance work; no
provider-specific workaround or imported buyer claim closes that gap. Terms
wording remains subject to a maintainer-owned new legal version and effective
date. This contract does not edit archived legal releases, merge, deploy or
waive final human review.
