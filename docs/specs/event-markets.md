# Event Markets And Local Pickup

**Status:** future-event implementation contract, not yet enabled. The kind `30409` contract below applies to future Event Markets. The current live event and its existing orders retain the legacy `30405`/`30406` contract described in the compatibility section. No automatic migration or dual authority is implied.

## Future Event Market contract

### Public wire and authority

Future events use the experimental [Open Markets Event Market proposal](https://github.com/OpenMarketsFoundation/specification/pull/15). The organizer signs a dedicated addressable kind `30409` record, `30409:<organizer>:<market-d>`, that links exactly one same-author NIP-52 `31922` or `31923` calendar coordinate, or one same-author finite `31924` schedule coordinate. Its required tags are one `d`, one calendar `a`, and `event_market` with version `2` and `open` or `closed`. Its replaceable revisions contain zero to 128 unique `merchant` rows:

```text
["d", "fair-2027-market"]
["a", "31923:<organizer>:fair-2027"]
["event_market", "2", "open"]
["merchant", "<merchant-1>", "merchant_present", "Booth 12"]
["merchant", "<merchant-2>", "organizer_handoff", "North pickup desk"]
["prev", "<prior-signed-market-event-id>"]  // later revisions
```

The organizer sets and may later edit each merchant's sole mode and public assignment. A duplicate or conflicting merchant row is invalid. The organizer's signed market state controls new commerce; calendar dates describe the event schedule. The `prev` tag identifies the signed parent on an update; the initial revision has none. A writer checks the strongest known revision before editing, preserves unaffected rows, and surfaces known divergent ancestry. NIP-01 replacement is deterministic but not a global compare-and-swap.

For a multi-date market, the signed `31924` contains a finite list of full `31922` or `31923` member coordinates authored by that same organizer. The current `31924` revision alone establishes market membership; an occurrence's own calendar reference cannot add itself. The organizer may publish new concrete NIP-52 dates before extending the schedule, edit one future occurrence, or remove a future occurrence from the schedule without deleting its public event. Past members remain available for timeline and order history. A weekly authoring pattern expands into editable concrete dates and is not published as an RRULE or run by a background scheduler. The initial writer caps one batch at 32 dates for signer usability; this is not a protocol limit.

Kind `3841` is a regular immutable organizer-signed authorization transition scoped to one market coordinate and merchant pubkey. Its empty content and required tags are:

```text
["openmarkets", "event-market-auth", "1"]
["a", "30409:<organizer>:<market-d>"]
["p", "<merchant>"]
["state", "active" | "revoked"]
["seq", "<canonical nonnegative decimal>"]
["auth_parent", "<prior transition id>"]  // zero on a root; up to eight otherwise
["repair", "<kind-5 id>", "<deleted transition id>"]  // only for a reviewed repair
["alt", "Open Markets event merchant authorization"]
```

An active grant with validated observed ancestry and a current roster row are both required for new commerce. Observed incomparable tips, missing parents, and unresolved organizer deletion evidence block admission. A later stale relay response cannot restore a known revoke or erase a conflict. Merchant enrollment is an authenticated merchant-level request or organizer invitation; neither grants admission. Approval signs a causal active grant and adds a row. Revocation signs a descendant revoke and removes the row. Because these are separate relay writes, an interrupted operation must retain signed bytes for exact retry; either an absent row or revoked grant denies admission. Reapproval requires a descendant active grant and a row, and warns that all still-valid, still-tagged products become eligible again. Mode and assignment edits need only a roster revision.

A merchant's kind `30402` product references the market with `["a", "30409:<organizer>:<market-d>"]`. It carries no independent event pickup, booth, handler, or fee. Merchant product publication, edits, untagging, visibility, price, inventory, and payment destination remain under the merchant's signature. No organizer product acceptance occurs. Earlier experimental version-1 `30409` revisions do not imply grants.

### Market and checkout behavior

Read the known organizer-signed market record, causal authorization, and calendar before candidate discovery. Use the organizer's observed NIP-65 write relays with bounded hints and fallback relays; retain unioned signed observations. Derive the finite roster author set, then query kind `30402` by those authors and the exact market `#a` tag. Filters yield candidates only. Before showing an event product, including a direct product link, resolve the current signed product revision and applicable NIP-09 deletion evidence; verify merchant author, market tag, active grant, visibility, and valid product terms. A newer untagged or deleted revision supersedes an older tagged product. Retain stronger known signed market, authorization, and product evidence when relays return stale or partial data. Surface incomplete evidence instead of treating it as proof of admission or removal.

An unpaid cart resolves current open market, calendar, merchant row, active validated authorization tip, product, and payment terms again before payment. A series purchase requires an explicitly selected current or future occurrence with complete signed membership and occurrence evidence. Missing siblings do not invalidate a verified selected date; an unresolved master or selected date blocks its purchase. Its participation identity is market coordinate plus merchant pubkey and, for a series, selected occurrence coordinate. Compatible products from that merchant at the same date form one purchase; products selected for different dates remain separate. A roster revision or booth rename alone does not split it. A material mode, assignment, selected date or membership, product, price, or payee change requires buyer review before payment. Calendar time does not close the whole market; existing single-date open-market behavior remains. There is no separate buyer event-pickup fee; event costs belong in merchant prices, and the merchant remains payee.

Created and paid orders retain the exact market revision, merchant row, observed authorization tip and required ancestry, relevant observed deletion evidence, calendar and product revisions, payee, and accepted terms. Series orders also retain the exact signed `31924` revision and selected occurrence revision so their same-author membership can be verified later. This is a bounded observation snapshot, not proof that no unseen event existed. A later roster, schedule, or occurrence edit does not reinterpret an order. Material handoff changes to an existing order require an explicit authorized per-order update or transfer and buyer notice. Organizer handoff grants physical release duties only under the merchant's private order-specific authority. The merchant's private ready receipt carries `releaseAuthorized: true` after its paid or zero-cost check; it carries no payment confirmation or full order. Private release, delivery, and recovery remain content-minimal and encrypted, and the organizer does not gain merchant payment authority.

### Compatibility and validation

New kind `30409` records do not reinterpret old kind `30405` product collections or per-product kind `30406` event pickups. Retain named legacy readers for the live event and historical orders. Do not derive future participation from previous products, republish all products for a roster edit, or change the live event as a prerequisite.

Future-event validation covers unapproved product spam, automatic admission for approved merchants, product revision/untag/deletion, organizer mode and assignment edits, revocation and reapproval, stale and divergent relays, stale organizer edits, direct links, compatible cart grouping, buyer review, historical order continuity, and composed Market/Merchant browser journeys. Local tests do not establish live-relay convergence or physical handoff.

## Legacy collection and pickup contract

The following contract remains the compatibility path for existing event catalogs and orders. Its `30405` product acceptance and `30406` event pickup records do not grant authority to the future kind `30409` path.

## Legacy Public sources

- NIP-01 addressable events and deterministic replacement
- NIP-09 author-scoped deletion requests
- NIP-19 `naddr` share identifiers
- NIP-52 date- and time-based calendar events (`31922` and `31923`)
- NIP-17/NIP-59 private messages and gift wraps
- NIP-17 kind `10050` private-message relay preferences
- NIP-99 physical product listings (`30402`)
- Open Markets / Gamma product collections (`30405`) and shipping options
  (`30406`)

OpenMarketsFoundation/specification PR 13 is an experimental destination-rule
proposal for shipped orders. Event pickup does not emit or interpret its
`destination_schema` or `destination` tags. A pickup has a fixed public handoff
location; it is not selected by matching a buyer delivery address.

The event-backed collection semantics below are retained for existing Conduit
events and orders. They predate the experimental kind `30409` proposal in Open
Markets PR #15. Core keeps them behind explicit legacy parsing and building
helpers and does not claim that unrelated clients implement the extension.

## Legacy Goals

- Let an organizer publish and update an event catalog with an external signer.
- Preserve organizer, event, collection, pickup, merchant, and product identity.
- Make the organizer-authored collection authoritative for catalog membership.
- Let merchants request participation without being able to forge acceptance.
- Resolve fixed pickup cost and provenance before direct payment.
- Let each accepted merchant choose who performs physical handoff without
  granting the organizer general merchant or order authority.
- Share only a minimal, separately encrypted fulfillment receipt when the
  organizer performs handoff.
- Keep event pages and history shareable after their scheduled end or organizer
  closure. Explicitly open events remain available past the advertised schedule;
  closed and legacy ended events are excluded from selectable presets.
- Represent partial, unavailable, stale, malformed, conflicting, and deleted
  relay evidence honestly.

## Legacy Non-goals

- Global event search or a centralized event registry
- Reputation inferred only from cryptographic authorship
- Ticketing, RSVP, check-in, maps, routing, radius search, or geofences
- Private handoff details in public events
- Shipping-destination rule design
- Sales reporting, organizer payment custody, or organizer access to full orders
- Fully unattended merchant payment confirmation or fulfillment automation
- A public booth event, receipt event, delegation tag, or Conduit registry
- More than one user-selectable physical fulfillment mode in the initial UI

Core parsing must nevertheless preserve repeated collection and
`shipping_option` references.

## Legacy Presentation and operational state

Requirements to resolve, retain, validate, or expose event-market state do not
by themselves require a dedicated shopper-facing warning, card, or disclosure.
Market presents the fulfillment information needed for the shopper's current
decision or order action, in compact ordinary UI. Discovery can defer exact
pickup and handoff details until cart or checkout, before order commitment.
When evidence prevents the current action, the shopper receives concise,
actionable status; underlying relay coverage and protocol diagnostics remain
available on the relevant merchant, organizer, network, or recovery surface.
Recovery information appears in the shopper journey when it changes the action
the shopper can take, without displacing the primary checkout or payment action
with routine relay explanations.

This presentation boundary does not relax signed authority, exact revision and
fulfillment validation, fail-closed payment or handoff gates, durable retry,
receipt privacy, or merchant and organizer operational observability.

## Legacy Identity and coordinates

Every record is identified by its full addressable coordinate:

```text
<kind>:<author_pubkey>:<d_tag>
```

The author pubkey is part of identity. A `d` tag alone is never sufficient.
`naddr` is a display/import encoding of the same kind, author, and `d` value;
Core stores and compares the decoded coordinate.

An organizer-authored event market contains exactly one selected calendar
coordinate and one collection coordinate. It may also contain exactly one
organizer-authored pickup coordinate as a standing offer to perform handoff.
The calendar, collection, and optional organizer pickup must have the organizer
pubkey to receive organizer-authored provenance. A collection that links a
calendar record by another author is third-party curation and is not accepted
by the organizer workflow.

Product coordinates may have different authors. The product author remains the
merchant; adding it to an organizer collection does not transfer authorship.

The selected pickup author determines the handoff party for a product:

- `merchant_handoff`: the pickup author is the product merchant;
- `organizer_handoff`: the pickup author is the collection/calendar organizer,
  and the collection advertises that exact organizer pickup;
- any other pickup author is unsupported in the initial workflow.

This is derived signed evidence, not a Conduit-owned booth record. A booth is a
UI projection of the event collection, merchant identity, accepted products,
and their selected handoff mode.

## Legacy Wire contract

### Calendar event (`31922` or `31923`)

Core accepts the NIP-52 date- and time-based shapes. New timed events emit
`31923` with `d`, `title`, `start`, optional `end`, `start_tzid`, optional
`end_tzid`, all required `D` buckets, and optional `summary`, `image`,
`location`, and `g`. New all-day events emit the NIP-52 `31922` date shape.

Missing required tags, invalid start/end ordering, unsupported timestamps or
dates, malformed time zones, and invalid coordinates are unusable evidence.

### Pickup option (`30406`)

New pickup options emit:

```text
["d", "<pickup id>"]
["title", "<public pickup title>"]
["price", "<non-negative amount>", "<currency>"]
["country", "<ISO 3166-1 alpha-2>", ...]
["service", "pickup"]
["location", "<public handoff location>"] and/or ["g", "<geohash>"]
```

At least one public `location` or `g` value is required. Private instructions
must not be emitted. Other `service` values remain ordinary shipping and are
outside this contract. Pickup resolution never evaluates buyer postal fields or
proposal-only destination predicates.

### Commerce collection (`30405`)

New event collections emit `d`, `title`, optional display metadata, exactly one
NIP-52 `a` coordinate, zero or one organizer pickup `shipping_option`
coordinate, and zero or more organizer-approved product `a` coordinates. An
empty upcoming collection is valid for this extension. Omitting the organizer
pickup means the organizer is not offering to perform handoff; it does not
prevent accepted merchants from using their own pickup records.

Event collections may carry the versioned `conduit_event_market` acceptance
declaration described in [event lifecycle](../knowledge/event-market-lifecycle.md).
This is a bounded Conduit event-market extension, not an upstream Open Markets
field. New event workflows declare `open`; `closed` prevents new event orders
without deleting the event or canceling existing orders. Absent metadata retains
legacy schedule-based acceptance. Ordinary collection updates must preserve it.

The coordinate kind distinguishes the NIP-52 event link from product
membership. Unknown `a` kinds remain preserved as unsupported references but do
not become products. Multiple NIP-52 event links or multiple organizer pickup
options are conflicting evidence for the initial workflow.

### Merchant product (`30402`)

A participating physical product remains merchant-authored. It emits an `a`
reference to the organizer collection as a discoverability claim/request. Its
event-fulfillment `shipping_option` selects exactly one of:

- a merchant-authored pickup option for `merchant_handoff`; or
- the exact organizer pickup option, or the exact event collection that selects
  it, for `organizer_handoff`.

Ordinary collection membership is not a fulfillment reference. Readers
preserve all repeated collection and shipping references, but consequential
resolution fails closed when the full set is ambiguous or has conflicting cost
evidence.

Product-to-collection reference is never proof of acceptance. Only a valid
organizer-authored collection that references the exact product coordinate
grants membership in that catalog.

### Private organizer fulfillment receipt

The buyer's order remains a private buyer-to-merchant commerce message in both
handoff modes. The organizer is never added as a recipient of the full order.

For `organizer_handoff`, the merchant must explicitly confirm that payment is
settled (or nothing is owed), the order is ready, and the organizer may release
the product. The merchant may then publish a separate minimal NIP-17/NIP-59
private rumor to the organizer. The rumor type is
`organizer_fulfillment_receipt` and contains only:

- contract version;
- an opaque claim reference derived with domain-separated SHA-256 from the
  private order id, merchant, organizer, and exact collection identity;
- merchant and organizer pubkeys;
- exact calendar, collection, pickup, and product coordinates and signed
  revisions;
- quantity per product; v1 rejects non-empty option/variant fields until the
  cart can bind them to that exact signed product revision;
- literal `paymentConfirmed: true`, `orderReady: true`, and
  `releaseAuthorized: true` assertions; and
- `ready_for_pickup` state and issuance time.

It must not contain buyer contact, delivery address, free-form notes, invoice,
preimage, payment hash, wallet/provider data, or unrelated order fields. Public
product data needed to identify merchandise is resolved independently from the
exact product coordinates rather than copied into the receipt.

The buyer and merchant derive the same claim locally from their private order
context. The organizer receives only the hash and all three surfaces format the
same 12-hex-character pickup code. The buyer presents that code after the
merchant says pickup is ready; neither the order id nor buyer identity is
revealed to the organizer.

The receipt sender must be the product merchant, its recipient must be the
pickup/event organizer, and every item must resolve to the same current exact
organizer-handoff graph. The NIP-59 rumor remains unsigned, but the reader must
authenticate it through the merchant-signed seal and verify that seal and rumor
authors match. Catalog acceptance alone, a merchant request alone, or pickup
authorship alone is insufficient.

Mutual organizer-handoff authorization consists of all of these current signed
facts:

1. the organizer authors the calendar, collection, and advertised pickup;
2. the collection references that pickup and the exact product coordinate;
3. the merchant authors the product and references the collection plus that
   organizer pickup (directly or through the exact collection reference); and
4. the private order snapshots the same graph and explicitly records organizer
   handoff.

Publishing the optional organizer pickup in the current collection is an
explicit standing offer to handle any currently accepted product coordinate
whose merchant selects it. It is not inferred from ordinary catalog acceptance,
and it is off by default in the organizer UI. Removing the product or pickup
from the current collection revokes the offer for future checkout/ready
receipts; it cannot retract an already delivered private receipt.

Missing, stale, deleted, malformed, conflicting, unsupported, or one-sided
evidence never grants receipt or handoff authority.

Before the irreversible `handed_out` acknowledgement, the organizer must still
resolve the exact pickup revision captured by the receipt. A newer calendar,
collection, or product revision is usable only when Core resolves the same
current coordinate graph, merchant acceptance, and organizer-handoff authority;
a replaced pickup revision blocks the acknowledgement.

The organizer may respond with a separate `organizer_handoff_ack` private rumor
that references the exact receipt and claim and carries only `handed_out` plus
its issuance time. That acknowledgement is evidence for the merchant workflow;
it does not authorize the organizer to mark an order paid, change price or
inventory, cancel, refund, or author an ordinary merchant order status.

If the merchant cancels or can no longer honor a delivered ready receipt before
handoff, it sends a separate `organizer_fulfillment_revocation` private rumor.
The revocation references the exact ready receipt and claim, repeats the exact
graph identities, and carries only `revoked` plus issuance time. It contains no
reason or free-form note. Organizer queues reduce ready, revocation, and ack
evidence by exact receipt identity, dedupe identical events, and fail closed on
same-frontier conflicts. A revoked receipt cannot be acknowledged as handed out.

A positively observed and authenticated ready receipt, bound to the current
graph and exact merchandise, is sufficient authority for the organizer to hand
out the product. Inbox pagination and coverage describe message discovery, not
the authority of positive evidence already found. A 400-event page cap,
continued scan, failed relay, stale result, or inability to prove global inbox
completeness therefore does not negate a valid receipt. The UI exposes degraded
discovery on the organizer's operational or recovery surface, while bounded
discovery and retry continue to find additional relevant messages.

Revocation is race-sensitive. A valid matching revocation known before handoff
makes the claim revoked and blocks `handed_out`. A matching acknowledgement and
revocation are conflicting evidence and also fail closed. The possible
existence of an unseen revocation does not invalidate a valid authorization
already found: Nostr relay reads cannot prove the global absence of unseen
events. Sending or delivering a revocation is likewise not proof that the
organizer observed it before physical handoff, so merchant takeover still
requires direct coordination.

## Legacy Evidence and resolution

All consequential resolution validates event id, signature, kind, full
coordinate, required tags, and author relationships before using data.
Addressable revisions use NIP-01 ordering: greatest `created_at`, then lowest
event id for equal timestamps.

Valid same-author NIP-09 deletion evidence is monotonic. An exact `e` deletion
removes that revision. An `a` deletion removes revisions at or before the
deletion timestamp. Cross-author or malformed deletion requests have no effect.

The shared resolver exposes these states rather than collapsing them:

- `active`: all linked current records resolve and new orders are open (explicit
  organizer declaration or a legacy event whose calendar end has not passed);
- `ended`: the organizer explicitly closed new orders, or a legacy event has
  reached its calendar end. The parsed collection distinguishes these cases;
- `missing`: a complete bounded lookup did not observe required positive data;
- `partial`: some planned sources did not complete;
- `unavailable`: no planned source completed;
- `stale`: only previously validated cached evidence is available for a fact
  that needs a current bounded read;
- `deleted`: valid deletion evidence dominates the linked record;
- `malformed`: a required record cannot express the claimed state safely;
- `conflicting`: valid evidence or linked coordinates cannot be reconciled;
- `unsupported`: a version, kind, or reference shape is not implemented.

An empty or failed relay response never erases stronger retained evidence.
Catalog browsing may use retained product data while the resolver preserves its
source, freshness, and coverage. Shopper-facing status describes an action limit
when the evidence changes what the shopper can do; detailed relay and evidence
state remains available on operational or recovery surfaces. A
partial relay view does not veto an exact positive graph when the required
listing, collection, event, and pickup revisions were all observed live; it
does prevent an incomplete negative observation from being treated as
absence. Cached-only required evidence is stale. Direct payment requires that
current positive graph plus a deterministic total. Deleted, malformed,
conflicting, unsupported, unavailable, or stale required evidence blocks direct
payment. Order-first is available only when the remaining order can be
represented safely.

## Legacy Publishing and updates

Organizer publishing uses the connected external signer. Core signs and
publishes each immutable revision through shared relay planning and returns
content-free per-record ACK/reject/timeout state.

For initial creation, the calendar event must receive at least one intended
relay ACK before the collection references it. If the organizer offers handoff,
the organizer pickup must also receive at least one intended relay ACK before
the collection references it. An event without an organizer pickup and an empty
collection are both valid. Updating accepted products republishes the same
collection coordinate only; it never rewrites merchant listings.

Merchant product publication requires an acknowledged pickup option before a
new product revision references it. Retry reuses the exact signed event for the
same semantic operation. Relay ACK means relay acceptance, not global
visibility or organizer receipt.

Private organizer receipts, revocations, and acknowledgements require a usable
recipient kind-10050 inbox. Each signed gift wrap is persisted before its first
relay I/O; retry reuses the exact immutable wrap. Zero ACKs remain an explicit
undelivered state, partial delivery remains visible to the merchant on the
outbox or recovery surface, and a merchant-delivered order is not duplicated
merely because the separate organizer leg needs retry.
The Merchant outbox retains only the exact encrypted wraps plus the bounded,
account-scoped receipt identity and public graph scope needed for retry or a
later revocation after public evidence changes. It does not retain a plaintext
copy of item quantities or the full order. It validates recovery
metadata on read, binds it to the exact signed receipt, and retains only bounded,
URL-free relay acknowledgement references bound to each exact wrap. ACK state is
monotonic, retries target only current non-ACKed inbox relays, terminal history
is pruned, and none of this state is copied into diagnostics.

Private-message discovery remains bounded and truthful. A first response
containing 400 wraps is capped and remains `partial`; later pagination may find
older ready, revocation, or acknowledgement evidence but cannot certify global
absence. Process-local continuation and retry improve discovery. Restart-
durable, convergent deep pagination remains separate follow-up work and is not
an organizer-authority requirement.

## Legacy Product workflows

The initial product fulfillment selector has three intents: Digital, Ship, and
Local pickup. Local pickup can import a collection `naddr`, select bounded
known/followed/featured organizer evidence already discovered by the client, or
create merchant-owned event and pickup records.

For an event product, Merchant presents two explicit handoff choices rather
than an independent receipt-sharing checkbox:

- **Merchant hands out:** select or create a merchant-owned pickup. Organizer
  receipt sharing is off.
- **Organizer hands out:** select the organizer pickup advertised by the event.
  The merchant explicitly opts into the minimal receipt workflow.

Legacy order snapshots without an explicit handoff mode grant no organizer
visibility. A merchant cannot turn organizer sharing on for an already accepted
order. For future orders, changing from merchant to organizer handoff requires a
new exact product fulfillment reference and current organizer acceptance before
checkout can snapshot the new mode.

Participation is `pending` when the product references the collection but the
organizer collection does not reference the product. It is `accepted` only
when both sides reference the exact coordinates and organizer authorship
validates. Closed and legacy ended events are not offered as presets. Explicitly
open events remain selectable beyond their advertised end time.

## Legacy Catalog and discovery

The canonical catalog URL encodes the organizer collection `naddr`. Friendly
aliases may redirect to it but are not metadata or membership authority.

For each selected product, the client resolves its exact linked `30406`, public
pickup terms, and merchant- or organizer-handoff relationship when current
evidence permits, retaining unresolved state otherwise. The page presents
organizer trust context separately from signed provenance, calendar metadata
from the linked NIP-52 record, and only exact product coordinates present in
the organizer collection. Products are grouped or labeled by merchant booth.
Compact catalog cards need not repeat pickup expectations, location, handler
identity, or handoff mode; the cart or checkout review presents the resolved
details before order commitment. Unresolved pickup evidence may limit an action
without adding a per-product relay warning or clarification box.
One-sided merchant claims and forged tags never add products.

Discovery is bounded to imported coordinates and organizer pubkeys already
known through an explicit user, follow, or deployment-curated decision. Core
does not globally ingest self-described events as trusted catalogs.

## Legacy Checkout and order lifecycle

Pickup checkout:

- uses the resolved pickup option price and selected exact revision;
- does not request or emit a buyer delivery address;
- does not show a universal contact form for a signed-in buyer with a usable
  private reply path;
- keeps bounded merchant-only email and phone contact for guest/manual
  order-first cases that cannot receive a private reply;
- blocks or explicitly splits carts that mix pickup and shipped fulfillment;
- snapshots pickup coordinate/revision, price/currency, title, public location,
  organizer pubkey, merchant pubkey, event coordinate, collection coordinate,
  handoff mode, and exact handler pubkey;
- requires a current usable organizer private-message inbox before accepting an
  organizer-handoff order;
- requires snapshot parity before signing or retrying direct payment.

Before the relevant order commitment, the buyer can understand the selected
fulfillment type, public pickup location, and who performs handoff. Compact
fulfillment details in the cart or checkout review satisfy this requirement;
warning cards, repeated fulfillment prose, and technical relay explanations are
not required. Organizer handoff does not require a separate pre-submit
disclosure about the minimal fulfillment receipt; the receipt remains limited
to the operational fields defined above. Mixed merchant- and organizer-handoff
carts are blocked or split unless every physical line resolves to the same
exact handler graph.

The order carries the selected shipping-option coordinate. Pickup orders do not
require carrier or tracking actions. Merchant records `picked_up`/complete
through the existing private order lifecycle without claiming a shipment. For
organizer handoff, a valid organizer acknowledgement may enable that merchant
completion action, but only the merchant authors the ordinary completion status
sent to the buyer.

A lifecycle-only collection revision does not rewrite an existing order or
receipt snapshot. Continuation must verify the original signed collection and
current collection differ only in the lifecycle declaration. Current membership,
pickup, handler, merchandise and revocation checks still apply. Local drafts and
fresh payment retries remain new-purchase actions; a local order id does not
grant permission to bypass closure. Existing merchant invoice authority and
ambiguous-payment reconciliation retain their independent safeguards.

## Legacy Required validation

- An organizer can publish an empty event collection with or without an
  organizer pickup offer, using an external signer and durable exact retry.
- An accepted merchant product with a merchant-authored pickup resolves to
  merchant handoff and produces no organizer private message.
- An accepted product with the exact advertised organizer pickup resolves to
  organizer handoff only when all mutual graph edges and a usable organizer
  inbox are current.
- One-sided, cross-author, ambiguous, malformed, stale, deleted, conflicting,
  unsupported, or inbox-unavailable evidence fails closed.
- The normal merchant UI cannot emit a new ready receipt until the merchant
  explicitly confirms payment is settled or nothing is owed, the order is
  ready, and organizer release is authorized.
- Ready receipts carry only the three literal authorization assertions, strict
  graph, quantities, an empty reserved options field, and opaque claim. Privacy
  tests reject buyer
  contact, addresses, notes, invoices, proofs, payment secrets, and arbitrary
  extra keys.
- Receipt, revocation, and acknowledgement wraps persist before relay I/O,
  retry the exact signed events, expose zero/partial ACK states to the merchant
  on operational or recovery surfaces, and remain idempotent across reload.
- A found valid ready receipt remains actionable when the inbox is capped,
  partial, stale, or otherwise cannot prove completeness; no valid receipt
  means no handoff authority.
- A valid revocation known before handoff removes readiness and prevents
  handout. A hypothetical unseen revocation does not negate found authority; a
  valid organizer acknowledgement grants no merchant-only lifecycle authority.
- Signed-in pickup completes without a contact form. New guest pickup orders
  require both merchant-only email and phone contact and never copy either to
  the organizer. Historical one-contact pickup orders remain readable.
- Cross-app browser fixtures cover event creation, both handoff modes,
  organizer acceptance, compact catalog discovery, cart or checkout fulfillment
  and handler details before commitment, checkout without a delivery address,
  paid or zero-cost ready delivery, organizer handoff acknowledgement, and
  merchant completion.
- Ordinary shipping, digital products, legacy single-recipient orders, and
  non-event Gamma collections keep their prior behavior.

## Legacy Privacy and diagnostics

Public events may contain only intentional public event and handoff details.
Buyer contact remains inside the encrypted buyer-to-merchant order path and is
never copied to the organizer receipt. Telemetry, logs,
diagnostics, test artifacts, screenshots, and demo evidence must exclude
pubkeys as active-user identifiers, product/order contents, messages,
addresses, contact data, ciphertext, invoices, signer secrets, and wallet
connection material.

Operational evidence may include event kind, state class, aggregate relay
counts, and content-free ACK/reject/timeout outcomes.
