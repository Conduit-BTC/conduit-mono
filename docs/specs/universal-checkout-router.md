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
specifications needed to recompute the final SAT amounts and verify exact
signed source/selection binding. Deterministic SAT, MSAT and BTC prices need no
fiat service. Fiat conversion requires the separately authenticated live-rate
snapshot described below; conversion consistency or a buyer-supplied rate alone
is not economic authority. No per-order online Merchant quote approval is
required for this supported signed-rate policy.
Shipping-table allocations must retain their exact signed policy and per-line
allocation, not an invented unit fee.

Valid existing listings do not require republishing or a router opt-in marker.
Unmarked listings retain their ordinary merchant allocation; marked supplier
terms require the exact signed revision. Missing or unsupported authority
blocks coordinated upfront payment before funding rather than enabling a
direct recipient payment. Free orders need no funding. Shipping or payment
that genuinely requires Merchant negotiation remains an order/DM flow outside
upfront coordination. Event-Market-specific admission and organizer commissions
have separate contracts; this contract does not invent their missing authority.
V1 uses only ordinary private Lightning payments for Merchant and supplier
payouts. Public routed zaps, identified and anonymous, are deferred. Signed-in
and guest shoppers use the ordinary funding/routing flow; this does not disable
non-routed zaps or a provider's global zap capability.

Historical direct-payment orders and funded router plans retain their original
payment and fulfillment semantics. Hosted activation, implementation coverage,
deterministic tests, funded acceptance and production observation are separate
facts; this contract is not a release sign-off.

## Approval, funding and disclosure

1. Validate current signed commerce, allocation, recipient and fulfillment
   evidence. Freeze checkout/order identities, exact revisions, quantity,
   pricing and shipping snapshots, ordered obligations, destinations, stable
   outgoing identifiers and fee responsibility.
   Every required Merchant and supplier Lightning endpoint must satisfy an
   accepted, mode-qualified receiving contract before wallet creation or
   funding disclosure. Unsupported endpoints block checkout, not fall back to
   an uncoordinated direct payment.
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
The funding invoice, supplier payouts and Conduit collection remain private;
they never become public NIP-57 checkout payments.

## Signed live fiat pricing

Display and checkout share a common bounded currency request and authenticated
cache from the dedicated rate service, which obtains the existing live price
feeds with bounded fallback and signs a versioned rate snapshot. Missing an
unrelated currency does not block an available checkout currency. Cache reuse
preserves the original issue, provider-observation and expiry timestamps; it
cannot refresh stale evidence. The service receives no cart, account, order,
recipient or invoice.
Its key is pricing-only, distinct from account and anonymous-zap keys. Market
authenticates the snapshot against the deployment's public verification ring
and reauthorizes exact signed products, selected variations and shipping at
that rate before freezing the quote. Refreshing rate provenance is not a
material price change; changed SAT amounts or fulfillment terms require a
new shopper review and cannot silently raise an approved total.

Retain the exact attestation with the immutable quote and private order/recovery
evidence. Before exposing funding, validate its validity against the fresh
provider-confirmed funding request creation time, including native timestamp
precision. Merchant recovery independently anchors the original quote to that
same exact provider receive, not a shopper timestamp or the recovery clock.
Expiry of the rate snapshot today does not invalidate a correctly authenticated
historical quote. Retain old verification keys for saved plans; changing the
service, key or current rate cannot reprice a funded plan. Missing authority or
time evidence pauses fiat financial admission without changing its obligations.
For immediate live reads only, an explicit issuance tolerance of at most one
second accommodates small service/client clock differences. It cannot extend
expiry, provider age or historical funding-time verification. Mixed fiat feeds
retain optional per-currency provenance covering every non-USD rate exactly;
when present it is authoritative and signed. Historical quotes without that
extension retain their original digest bytes.
The standalone service and trusted deployment policy require explicit
activation; dormant code and synthetic tests do not establish live readiness.

## Qualified receiving endpoints

Receiver support is a verified capability contract, not a wallet-brand
allowlist or the presence of a LUD-21 advertisement. Trusted deployment policy
qualifies exact pay-request, callback and verifier origins, verifier path and
historical private-invoice account binding. Fresh metadata identifies the frozen
Lightning address; invoices bind their description hash to that exact metadata.
Public receiving capability is not a V1 admission or release dependency.

Retain a portable receiver binding with each exact prepared intent. It is an
untrusted lookup hint, not a buyer-issued proof. Both clients independently
read the qualified verifier for the exact invoice, network, amount and hash.
Receiver settlement additionally requires its settled result and matching
preimage, separately from exact native Spark debit/transfer proof. An unpaid
issuance check or matching local origin alone cannot mark a bound leg settled.
Delayed verification preserves and reconciles the same possible send; it never
requests a replacement invoice or pays again. Historical attempts lacking
independent recipient evidence remain paused. See
[receiver qualification](../knowledge/checkout-spark-recipient-verification-compat.md)
for qualification, provider retention and live acceptance requirements.

## Deferred public routed zaps

New V1 plans do not authorize public Merchant-payout zaps. Historical public
plan policies and exact intents retain their original digests and identifiers;
they are never stripped or rewritten into private payments. Reconcile possible
sends against exact evidence. Missing public recipient proof, signing authority
or unsupported renewal stays paused, without another invoice or payment.
Optional public receipt absence is not proof that a payout was unpaid.

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

Merchant settlement observation starts when authenticated exact-order recovery
and source evidence are available, independently of takeover. A pinned,
query-only adapter must not initialize or synchronize a wallet, claim funds,
change privacy, create invoices or sign/send transactions. Bound all reads and
fence late results after timeout, account/order change or suspension. Receiver
verification alone is informational: paid commerce requires its exact native
funding credit and all required commerce debits plus recipient proof. Verified
commerce may enable fulfillment before takeover without advancing the saved
router state. Merchant claim-capable recovery, fee collection and retirement
retain the original takeover boundary and independent evidence requirements.

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

An exact receive below the frozen commerce-plus-Conduit weights pauses for
reconciliation; it does not proportionally reduce approved commerce obligations,
request automatic extra funding or create a replacement invoice. Historical
short-funded records remain readable for exact payment reconciliation, but
grant no new preparation or send authority. Recipient outgoing fees within
their approved allocations remain distinct from an inbound funding shortfall.

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

An exact Lightning or native intent may retry only after durable, positive
pre-provider cancellation evidence. The executor retains that terminal
cancellation and requires a process-local capability bound to the exact
repository, committed revision and unchanged intent, issued only after durable
readback of a positively prevented provider submission. A restored or imported
failure label cannot recreate the capability. Fresh authority, invoice-window,
recipient and recovery-checkpoint checks still precede dispatch. Any actual or
potentially actual provider invocation remains query-only until independently
reconciled; missing history does not establish cancellation.

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

After positive terminal readback, completed execution queues and preparation
claims may be cleaned to release bounded queue capacity. First persist and
verify exact encrypted recovery evidence in the device-local archive. Keep the
terminal replay marker and encrypted Merchant progress, preserve active and
uncertain entries, and resume interrupted cleanup from the saved terminal
marker. Queue cleanup never deletes the wallet credential or establishes an
atomic provider-side closure that the adapter has not proven.

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
  one buyer-approved plan; missing or changed evidence fails before wallet work.
  Fiat evidence includes an authenticated bounded live-rate snapshot and the
  original provider funding-time anchor; converted-price consistency alone is
  insufficient.
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
- Every required endpoint is qualified before funding. Supported cold partial
  recovery independently verifies already-paid recipients, completes remaining
  obligations and retires only on fresh terminal zero-funds evidence; historical
  unbound attempts remain unverified rather than inferred from balance.
- Privacy and guest-scope negatives reject generic, cross-order, wrong-recipient,
  stale and malformed recovery without leaking payment or recovery material.

Tests must distinguish deterministic provider fixtures from deployed-provider
enforcement, real signer/relay cryptography, physical mobile wallet handoff and
funded receiving-side confirmation. Fresh uninterrupted funded checkout,
genuine Merchant fallback/device/inbox QA and cold-hosted attribution of
already-paid buyer-issued invoices remain explicit acceptance work. Qualification
must include external mobile payment, Safari termination with the Merchant
offline during funding, and later Merchant restoration. No synthetic contract
or imported buyer claim closes that live acceptance gate. Terms
wording remains subject to a maintainer-owned new legal version and effective
date. This contract does not edit archived legal releases, merge, deploy or
waive final human review.
