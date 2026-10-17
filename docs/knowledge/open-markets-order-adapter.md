# Open Markets numeric order adapter

Owner: Commerce/Core maintainers. This describes client behavior, not deployment
or another client's certification. Source: the current Open Markets
[order communication flow](https://github.com/OpenMarketsFoundation/specification#4-order-communication-flow-and-payment-processing).

- Status: proposed compatibility lane, implemented for candidate validation.
- Canonical target: an explicitly selected, versioned commerce envelope that
  avoids the NIP-18/NIP-25 inner-kind collisions. No proposed kind is activated
  by this adapter.
- Started: 2026-10-15. Next review: 2026-11-15.
- Rollout control: reviewed release commit and authenticated per-order format
  selection. No environment toggle can widen supported operations or peers.
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

Standard checkout exposes **Order compatibility**: **Conduit** (the existing
named kind-16 JSON contract, the default) or **Open Markets** (numeric type 1).
The buyer selects Open Markets when the merchant requests that contract.
Neither a `client` tag, kind-10050 inbox declaration, relay response nor empty
lookup establishes commerce-format support. There is no probe order or second
representation. Private router checkout requires its existing Conduit contract;
the selector explains that requirement and submission checks it before wallet
preparation. This adapter does not change payment routing policy.

Before wrapping or staging a new order, save its order ID, buyer, merchant and
selected format in the device-local `orderWireFormats` table. The staged
`orderLifecycles.orderWireFormat` also freezes that choice. A different party
pair or format cannot reuse it. Missing historical metadata means the deployed
named contract. Recovery republishes the original signed encrypted wrap;
it never re-encodes the order from current checkout controls. Changing a seller
or starting another order does not change a pending order or invoice.

Numeric order `amount` is the aggregate sats total including delivery. Common
tags carry product coordinates, quantities and optional delivery/contact fields;
text carries the buyer's note. The bounded extension retains the already
approved Conduit snapshot inside the same recipient's encryption. Multiple
different shipping coordinates cannot be represented by this common contract
and fail before delivery rather than silently dropping a line's terms.

Payment reports use kind 17 with the exact Lightning invoice, its amount and
an optional preimage. Conversation uses kind 14 with the original wire order
ID as `subject`. These follow-ups use the saved lifecycle's format and party
pair. Numeric history without its saved outbound format cannot silently send
a named conversation reply. Guest checkout retains its existing outbound-only
identity and contact/recovery rules; it gains no guest inbox or conversation.
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

Numeric replies have human-readable content. An optional bounded `conduit`
version-1 tag preserves richer local semantics, including acceptance versus
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
numeric replies. Decode-rule version 6 rebuilds that view from retained wraps.

A singleton recipient `p` tag may have an optional bounded WebSocket relay hint.
The hint does not grant delivery authority or select the commerce format.

Kind-14 notes remain in the direct inbox. Accepted outgoing Market notes are
saved as encrypted direct-message projections before the optional self-copy;
a refused self-copy cannot erase the sender's accepted conversation on reload.
Orders may additionally preview a note only for an existing external order with the exact subject and two-party
identity. The preview cannot grant financial or fulfillment authority.

A supported kind-17 receipt has one Lightning invoice and optional preimage.
Its amount must match the invoice. If supplied, a valid 32-byte preimage's
SHA-256 must match the payment hash. A three-entry `payment` tag without a
preimage is an unverified payment report, not a malformed message or settlement.
Kind 17 never falls back to the kind-16 Conduit extension parser. A disguised
order/status extension remains external evidence, including under an unknown
version. Decode-rule version 6 reprocesses retained unsupported reports while
preserving the earlier kind-17 authority restriction and genuine deletions or
message-expiration decisions.
The supported receipt remains an unverified claim. Automation additionally requires the exact
authenticated merchant-issued invoice and the existing receiving-wallet
settlement verifier. Wrong-party, wrong-invoice, unsupported or conflicting
claims cannot confirm payment. Existing manual verification stays explicit.
Repeated claims cannot credit settlement or stock twice.

Numeric invoice replies include the BOLT11 `expiration` deadline. If a peer
supplies this common tag, it must match the invoice's decoded validity deadline.
It limits paying that invoice, not retention of its authenticated order history:
an expired invoice still correlates an eventual payment report. Outer-wrapper
expiration and ordinary NIP-40 disappearing messages retain their existing TTL.
Invoice totals may differ after merchant review; the buyer sees the existing
amount-change warning, and the merchant's note explains adjustments.

Reply format selection comes from the retained authenticated order; new Market
selection comes from the buyer's explicit checkout choice, never a client
brand or relay-declaration tag. Select one representation before staging. Retry exact rumor and
encrypted delivery bytes under existing authority. Missing history cannot
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
both directions: numeric intake/replies and Market selection, merchant invoice,
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
