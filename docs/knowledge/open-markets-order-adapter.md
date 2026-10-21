# Open Markets numeric order adapter

Owner: Commerce/Core maintainers. This describes client behavior, not deployment
or another client's certification. Source: the current Open Markets
[order communication flow](https://github.com/OpenMarketsFoundation/specification#4-order-communication-flow-and-payment-processing).

- Status: unified numeric writer with historical readers, implemented for candidate validation.
- Canonical target: an explicitly selected, versioned commerce envelope that
  avoids the NIP-18/NIP-25 inner-kind collisions. No proposed kind is activated
  by this adapter.
- Started: 2026-10-15. Next review: 2026-11-15.
- Rollout control: reviewed release commit and immutable per-order writer
  checkpoints. No environment toggle can widen supported operations or peers.
- Activation: local candidate validation only; production admission requires
  maintainer approval and the separate client/signer/payment evidence below.

The divergence was verified by source inspection on 2026-10-15: Open Markets
uses numeric tags and text, while existing Conduit writers use named tags and
JSON. The independent-client report in [issue 623](https://github.com/Conduit-BTC/conduit-mono/issues/623)
was based on code review, not a completed live purchase. Requiring Conduit's
extension prevents an otherwise authenticated order from reaching Merchant.

## Supported journey

An independent buyer sends a NIP-17/NIP-59 kind-16 rumor with numeric type 1,
structured tags and human-readable content. Merchant can review the request,
accept or decline, send a Lightning invoice, receive a kind-17 Lightning claim,
verify payment, and send numeric status/shipping updates. Market can also select
numeric orders for an independent merchant and receive that merchant's invoice,
confirmation, conversation and fulfillment updates. Kind 1327 remains an
experimental proposal, not an enabled writer.

### New Market orders

New Market checkout writes one Open Markets numeric type-1 order. There is no
compatibility selector, size-based writer switch, probe order or second
representation. Its common tags and human-readable content remain readable by
independent clients. A version-2 `conduit` extension preserves the complete
approved order payload and original canonical tags in the same encrypted rumor,
including per-item shipping, signed quotes, pickup snapshots and router markers.
This is a Conduit extension to the working Open Markets contract, not a claim
that independent clients implement the richer features or that kind 1327 is active.

Ordinary orders require no capability declaration. Advanced terms require each
exact authorized signed product listing to declare the required subset of
`["conduit_commerce", "2", "per_item_shipping", "event_pickup", "router_checkout"]`.
Merchant publishes that declaration with new or updated listings. Checkout carries
those signed revisions in `conduit_commerce_support` inside the extension; both
encoder and receiver validate them. Brand tags, inbox declarations and relay
responses do not establish support. Existing listings without the declaration must
be updated by the seller before a new advanced order can proceed. The buyer sees
an actionable refresh request before funding; there is no downgrade or hidden
named-order fallback. Already staged orders keep their original continuation path.

Before wrapping or staging a new order, persist its ID, parties and
`open_markets_v2` writer in `orderWireFormats` and `orderLifecycles`. New routed
checkout preparations persist the same writer before funding preparation. Saved
named orders, numeric-v1 orders and historical routed preparations with no writer
metadata retain their original grammar. A checkpoint cannot change its parties or
version. Recovery republishes the original signed encrypted wrap; it never
re-encodes from current checkout controls. Historical missing metadata means the
deployed named contract only for those historical records.

The version-2 extension is `{payload, tags}`; common identity, amount, currency,
items, invoice and status fields must agree with the full snapshot. Unknown or
conflicting extensions stay non-actionable. Multiple shipping coordinates remain
per-item in the full snapshot; the common shipping tag is emitted only when it is
unambiguous. Version 1 retains its 32 KiB extension bound. Version 2 uses the shared
512 KiB message bound, with the existing final encrypted-frame transport bound
still enforced independently. Oversized work fails explicitly without truncation,
changing formats or losing signed shipping evidence.

Payment reports use kind 17 with the exact Lightning invoice, its amount and
an optional preimage. Conversation uses kind 14 with the original wire order
ID as `subject`. These follow-ups use the saved lifecycle's format and party
pair. Numeric history without its saved outbound format cannot silently send
a named conversation reply. Guest checkout retains its existing outbound-only
identity and contact/recovery rules; it gains no guest inbox or conversation.
Buyer status projection binds to the exact saved numeric format or an
authenticated buyer-authored original, so lifecycle loss does not erase a
merchant's confirmed, completed or cancelled state. Conflicting formats and
unrelated participants cannot gain that authority. Merchant receipt verification
still requires exact payment evidence; buyer reports remain unconfirmed.
The exact saved numeric buyer order also binds incoming conversation when its
outgoing history/self-copy is missing. Another sender using the same wire ID
remains a separate direct message and cannot gain that order's authority.
Guest format checkpoints expire with that same session, including choices saved
before encrypted staging. Guest cleanup removes them alongside expired order data;
signed-in choices retain their existing recovery lifetime.

Database version 28 applies the complete additive union of main's v27 roster
index and the undeployed adapter candidate's v27 format table. It upgrades both
installed lineages, as well as older named-order databases, without rewriting installed
order, invoice, wallet or encrypted outbox records. Rollback must preserve this
table, the numeric reader and staged wraps; never downgrade the database or
rebuild pending sends into the other representation.

Core's `open-markets-orders.ts` codec and CommerceInbox own ingestion. There is
no second inbox, relay planner, transport or server-side order translator.
NIP-44 v2, recipient and seal/rumor binding, encrypted device-local history,
protected reads and immutable delivery remain in force. NIP-44 v3 selection
still requires public references and explicit capabilities.

## Identity and incomplete terms

Actionable input requires exactly one valid recipient, subject and order ID.
Supported singleton tags cannot conflict. Amounts and quantities are bounded
integers. Product and optional shipping coordinates name the recipient merchant.
Unknown versions, malformed values, unrelated reposts/reactions and unsupported
payment rails never gain action authority.

The local order ID is `open-markets:` plus SHA-256 of canonical JSON
`[[partyA, partyB].sort(), wireOrderId]`. This is a local correlation alias,
not a wire protocol. Replies preserve the wire ID. Independent buyers using the
same wire ID cannot share invoice/recovery state. Encrypted originals and their
provenance are retained unchanged.

An external order's amount is its requested aggregate total in sats. It does
not establish individual prices, shipping breakdown, listing revision,
destination eligibility or special pickup authority. Those values remain
unknown; current catalog hydration supplies display information only. Merchant
reviews the request before accepting or invoicing. Conflicting terms suspend
consequential actions while conversation remains available.

## Reply and payment boundaries

| Operation          | Compatible wire                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| Invoice            | Kind 16, type 2, exact sats amount and Lightning invoice                                           |
| Acceptance         | Kind 16, type 3, pending                                                                           |
| Verified payment   | Kind 16, type 3, confirmed                                                                         |
| Fulfillment/status | Kind 16, type 3, supported mapped status                                                           |
| Shipping           | Kind 16, type 4, processing/shipped/delivered/exception; shipped exposes optional carrier/tracking |
| Conversation       | Kind 14, subject equal to wire order ID                                                            |

Numeric replies have human-readable content. A bounded versioned `conduit`
tag preserves richer local semantics, including acceptance versus
pending and verified paid versus a remote claim. Its identities, amount,
invoice, mapped status and tracking must agree with the common fields.
Independent buyers need no extension on their orders or receipts. On Merchant,
unextended confirmation/completion/cancellation remains a report and cannot
establish settlement or effective cancellation. In Market, an exact locally
selected numeric order binds the wire ID and both parties: its merchant's
pending/confirmed/completed/cancelled updates receive the same buyer-facing
acceptance/payment/completion/cancellation meaning as named merchant updates.
That projection is account-local; it grants no receiving-wallet authority.

Processing/delivered/exception shipping phases remain non-authoritative reports
on Merchant. The exact owning Market order can display processing and delivered;
exception stays a report with its note. Refund operations remain inspectable
external records. A refund request is
never emitted as cancellation. Corrections that need richer local metadata
remain in the bounded extension; no refund transfer is initiated here.

Installed-version numeric orders with a validated Conduit extension may already
have named replies and pending invoices under their original wire ID. The inbox
joins those replies only for the exact buyer and merchant pair, and only when no
distinct named initial order conflicts. Existing invoice records and paid
confirmation operations keep their original keys, grammar, and encrypted bytes.
A new numeric order without positive historical named operation evidence keeps
numeric replies. Decode-rule version 7 rebuilds that view from retained wraps.

A singleton recipient `p` tag may have an optional bounded WebSocket relay hint.
The hint does not grant delivery authority or select the commerce format.

Kind-14 notes remain in the direct inbox. Accepted outgoing Market and Merchant notes are
saved as encrypted direct-message projections before the optional self-copy;
a refused self-copy cannot erase the sender's accepted conversation from Messages
or its derived order preview on reload. Named order messages retain their
existing order projections.
Initial named and numeric orders retain the existing fixed, recipient-only
order advisory after declared-inbox acknowledgement. Guest advisories retain
one-use scope, privacy and no-self-copy restrictions; proofs and conversation
never trigger another advisory. Exact authenticated order matching uses the raw
wire order ID alongside its rumor ID and parties, without changing the local alias.
Orders may additionally preview a note only for an existing external order with the exact subject and two-party
identity. The preview cannot grant financial or fulfillment authority.

A supported kind-17 receipt has one Lightning invoice and optional preimage.
Its amount must match the invoice. If supplied, a valid 32-byte preimage's
SHA-256 must match the payment hash. A three-entry `payment` tag without a
preimage is an unverified payment report, not a malformed message or settlement.
Kind 17 never falls back to the kind-16 Conduit extension parser. A disguised
order/status extension remains external evidence, including under an unknown
version. Decode-rule version 7 reprocesses retained unsupported reports while
preserving the earlier kind-17 authority restriction and genuine deletions or
message-expiration decisions.
The supported receipt remains an unverified claim. Automation additionally requires the exact
authenticated merchant-issued invoice and the existing receiving-wallet
settlement verifier. Wrong-party, wrong-invoice, unsupported or conflicting
claims cannot confirm payment. Existing manual verification stays explicit.
Repeated claims cannot credit settlement or stock twice.

A numeric type-2 payment request may advertise multiple payment options. The
adapter selects exactly one Lightning BOLT11 option regardless of tag order;
Bitcoin/eCash and other alternatives remain retained evidence without payment
authority. Duplicate or conflicting Lightning entries, malformed selected
Lightning fields, missing supported options and invalid amount/expiry remain
non-actionable. Kind-17 receipts still require one payment report; this does
not enable other settlement rails. Decode-rule version 7 reprocesses retained
multi-option invoices rejected by the earlier decoder without rewriting wraps.

Numeric invoice replies include the BOLT11 `expiration` deadline. If a peer
supplies this common tag, it must match the invoice's decoded validity deadline.
It limits paying that invoice, not retention of its authenticated order history:
an expired invoice still correlates an eventual payment report. Outer-wrapper
expiration and ordinary NIP-40 disappearing messages retain their existing TTL.
Invoice totals may differ after merchant review; the buyer sees the existing
amount-change warning, and the merchant's note explains adjustments.

Reply format selection comes from the retained authenticated order; new Market
orders always use numeric version 2, never a client brand or relay-declaration tag. Select one representation before
staging. Retry exact rumor and encrypted delivery bytes under existing authority. Missing history cannot
silently select an incompatible writer. The decode-rule upgrade reprocesses
previously retained external wrappers.

Safety/payment and data-integrity requirements remain hard gates. Source
discovery and ecosystem adoption are capability/migration conditions; unavailable
optional metadata cannot invalidate a retained authenticated order.

| Observed state                         | Read behavior                            | Write behavior                                                      |
| -------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| Existing named order                   | Existing projection                      | Existing named writer                                               |
| Supported authenticated numeric order  | Merchant review with unknown terms shown | One numeric reply chosen before staging                             |
| Partial relay read with retained order | Preserve retained evidence and coverage  | Existing bounded delivery plan and ACK semantics                    |
| Missing retained order history         | Preserve external records                | No guessed numeric writer                                           |
| Malformed/unknown version or rail      | Inspectable external record              | No action authority                                                 |
| Conflicting terms                      | Explicit conflict and conversation       | No consequential actions; agree in Messages and request a new order |

Relay sources and maximum fanout remain those of the shared NIP-17 planner and
the validated-order compatibility lane in `docs/specs/protocol.md`. This codec
adds no relay, wildcard subscription, fanout, server, or cross-account source.
An empty bounded read is not proof of global absence. Staging, zero/partial ACK,
session replacement and exact retry retain the existing delivery safeguards.

## Measurement and removal

`CommerceInbox` exposes content-free `diagnostics.orderAdapter` counts over the
currently retained, decrypted logical history: distinct canonical orders,
distinct compatible orders, compatible non-order messages and conflicting
compatible orders. The order denominator is canonical plus compatible orders.
Re-wrapping a logical message does not add a count. These account-local counts
are tested; they are not uploaded telemetry or evidence of global adoption.
Unsupported/malformed decode counts and delivery outcomes remain in the
existing diagnostics. No identifiers, contents, invoices or relay URLs enter
these counters.

Before production admission, maintainers must record the candidate's cross-client
journey and receiving-wallet verification separately from synthetic evidence.
At the review date, compare retained-history counts and supported-client results.
Removing new numeric admission requires zero observed numeric-only orders for
30 days across two supported releases, successful versioned-envelope journeys
for every supported peer, and an explicit reviewed maintainer change. Incomplete
coverage postpones removal; it is not a zero. Keep historical readers and exact
pending delivery bytes for the supported recovery window. Widening, renewal or
removal never follows silently from a timer or another client's brand tag.

## Validation and further migration

Authentic encrypted tests cover intake, receipts, duplicate/conflicting terms,
local identity, format pinning, installed pending invoices and retained-history
recovery. Peer vectors are derived from
[nostrich-marketplace at 668198e](https://github.com/nostrichOS/nostrich-marketplace/tree/668198e3388ba35e0fcc3a2a4a9e9503402de69e),
`src/orders/orders.ts` and `docs/orders.md`. Local-relay browser journeys cover
both directions: numeric intake/replies and unified Market checkout, merchant invoice,
no-preimage report, merchant confirmation, conversation, fulfillment and reload.
They use real NIP-44/NIP-59 encryption with runner-owned identities and simulated
peers. Wallet-verifier tests, browser observations, actual external clients,
real signers/devices and live settlement are distinct evidence classes.
Local tests do not certify Nostrich or a production deployment. Diagnostics
remain content-free.

Merge, deployment and production decisions require separate maintainer approval.
Rollback must preserve readers and exact staged work; it must not rewrite
history or create a second semantic send. The future versioned envelope needs
its own schemas, explicit capability selection, compatibility/recovery evidence
and retirement policy. Another marketplace's adoption is not a prerequisite to
implementing that experimental migration.

New event pickup and routed-payment orders retain all authenticated snapshots and
markers in numeric version 2. Complete terms are a validated-payload property,
independent of wire grammar. Stock, organizer handoff, receipt and routed-payment
commitments use the original wire ID; participant-scoped inbox aliases never enter
those commitments. Existing named pickup/router orders keep their saved writer.
An occupied raw-ID journal belonging to another order fails closed before stock
mutation; ordinary numeric orders retain participant-qualified acceptance keys.

## Review corrections

Direct-message composers inherit an order reference only from an authenticated
order/participant pair or a verified reply chain. A note composed in Messages
returns to its order after reload. Plain chats and advisory companion messages
cannot manufacture that context; ambiguous ancestry remains unassociated.

Independent orders can omit item format. Merchant must resolve each genuinely
unknown line as shipping or digital before fulfillment. That decision is encrypted,
bound to the original terms and parties, and recovered after reload. It does not
rewrite the buyer's order, override known fields, change acceptance hashes or
repeat inventory work. Digital orders can complete without invented tracking;
shipping orders retain the existing shipping workflow.

New signed-in numeric checkout and order-message actions expose the existing inbox
readiness state. Initial order delivery remains available when signer and merchant
routing checks pass, even if sender-inbox discovery is pending, partial, unavailable
or missing. The notice explains that receiving updates and sending replies may
require inbox setup; it does not give optional sender copies veto power over a
recipient-accepted order. Local recovery and truthful backup status remain intact.
Missing setup opens Network in a separate tab so checkout and message drafts
survive. Direct replies retain their strict messaging preflight; users refresh
discovery and retry after setup. Retained authenticated declarations survive partial
discovery. Existing staged delivery and guest recipient-only flows retain their
established recovery and authority rules.

## Converged reply, payment and storage boundaries

Both buyer reply surfaces use the shared buyer publisher. The immutable saved
format or authenticated original order selects the writer; recovered numeric
orders keep the raw wire ID and exact buyer/merchant pair. Numeric notes remain
kind 14 after reload or lifecycle loss. Participant-qualified advisory URLs
resolve raw numeric IDs only through their authenticated original. Legacy
unqualified advisory content is still recognized; ambiguous or filtered targets
never select another conversation. Market order rows retain the authenticated
conversation messages so raw checkout links also resolve without a local lifecycle.

A numeric upfront Lightning receipt does not require a preceding merchant invoice
message. It remains unverified until the receiving wallet proves the exact incoming
invoice, hash, amount and settlement. When a merchant invoice exists it must match.
Signed-in kind-17 reports require the recipient's authenticated inbox declaration,
not the sender's optional inbox. Guest receipt delivery stays recipient-only.

Ordinary independent numeric orders can enter merchant inventory acceptance using
their authenticated aggregate terms. Missing historical item prices and formats
remain unknown. Encrypted acceptance and replay bindings preserve those terms,
and a replay cannot decrement stock again. Event pickup and organizer stock
handoff require complete authenticated terms, including numeric version 2 snapshots.

Installed versions stored extension-backed numeric acceptances under the raw wire
ID. Reads and retries resolve those records only through the authenticated numeric
original, exact participants and unchanged accepted terms. They retain the original
record key, encrypted evidence and publication work instead of creating a second
acceptance under the local alias. A different buyer's raw-ID record does not block
another conversation; conflicting terms or duplicate matching decisions require
reconciliation. Named orders cannot opt into this compatibility path by choosing
an alias-shaped ID. Keep this bounded reader until installed raw-ID acceptances no
longer need recovery; schema upgrades alone cannot retire it.

Schema version 30 converges main versions 27–29 and adapter versions 27–28,
preserving format choices, discovery indexes, organizer stock records and exact
encrypted delivery bytes. Decode rules version 9 combines retained numeric-envelope
reprocessing, authenticated note context and version-2 snapshots with the current
machine-message and deletion safeguards. Upgrade,
reply, payment and browser fixtures remain synthetic evidence; the external-client,
live-signer, device and receiving-wallet acceptance gates above remain separate.
