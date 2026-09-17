# Event Markets And Local Pickup

**Status:** implementation contract

This contract defines organizer-authored event catalogs and fixed-location
pickup across `@conduit/core`, Market, and Merchant. It uses existing Nostr and
Open Markets event kinds. It does not create a Conduit event kind, registry, or
location tag.

## Public sources

- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) addressable
  events and deterministic replacement
- [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md) author-scoped
  deletion requests
- [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md) `naddr` share
  identifiers
- [NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md) date- and
  time-based calendar events (`31922` and `31923`)
- [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) and
  [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) private
  messages and gift wraps, with
  [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) v2
  encryption
- NIP-17 kind `10050` private-message relay preferences
- [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md) physical
  product listings (`30402`)
- The current
  [Open Markets specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md)
  for product collections (`30405`) and shipping options (`30406`)

OpenMarketsFoundation/specification PR 13 is an experimental destination-rule
proposal for shipped orders. Event pickup does not emit or interpret its
`destination_schema` or `destination` tags. A pickup has a fixed public handoff
location; it is not selected by matching a buyer delivery address.

The event-backed collection semantics below are a backwards-compatible
extension proposed upstream in
`docs/knowledge/open-markets-event-commerce-proposal.md`. Until accepted, Core
must keep them behind explicit event-market parsing/building helpers and must
not claim that unrelated clients implement the extension.

Open Markets keeps each signed kind `30402` product as its source of truth and
does not cascade later collection-setting changes into products. Every event
product therefore projects its inherited handoff arrangement into its own
signed references.

## Goals

- Let an organizer publish and update an event catalog with an external signer.
- Preserve organizer, event, collection, pickup, merchant, and product identity.
- Make the organizer-authored collection authoritative for catalog membership.
- Let merchants request participation without being able to forge acceptance.
- Resolve fixed pickup cost and provenance before direct payment.
- Let each merchant choose one handoff arrangement for an event before
  publishing products, and make every accepted event product project that
  arrangement without granting the organizer general merchant or order
  authority.
- Share only a minimal, separately encrypted fulfillment receipt when the
  organizer performs handoff.
- Keep ended event pages shareable while excluding them from selectable presets.
- Represent partial, unavailable, stale, malformed, conflicting, and deleted
  relay evidence honestly.

## Non-goals

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

## Identity and coordinates

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

The selected pickup author determines the handoff party for a product and is
the public projection of the merchant/event arrangement:

- `merchant_handoff`: the pickup author is the product merchant;
- `organizer_handoff`: the pickup author is the collection/calendar organizer,
  and the collection advertises that exact organizer pickup;
- any other pickup author is unsupported in the initial workflow.

This is derived signed evidence, not a Conduit-owned booth record. A booth is a
UI projection of the event collection, merchant identity, accepted products,
and their selected handoff mode.

### Merchant/event handoff invariant

A merchant MUST choose exactly one handoff arrangement for an event before the
first product is prepared for publication:

- `merchant_handoff`: the merchant creates or reuses one merchant-authored kind
  `30406` booth/pickup record for that merchant and event. Every event product
  from that merchant references that same pickup coordinate.
- `organizer_handoff`: every event product references one pickup coordinate
  that the organizer explicitly offers in the event collection and that the
  organizer accepts for the merchant's products.

`organizer_handoff` MUST NOT be offered when the client lacks positive,
currently verified evidence of a usable organizer-authored pickup definition
in the collection. Partial relay reads, cached offers, and previously removed
offers are not availability evidence.

Before any product exists, a client MAY persist an account-scoped local intent
keyed by the merchant and event collection coordinate. That intent is only a
drafting aid for preparing signed pickup and product events. It is not a public
protocol record, organizer acceptance, checkout authority, stock authority, or
payment authority. Once signed records exist, the exact signed product, pickup,
and collection revisions are authoritative, and the local intent MUST be
checked against them before it is reused.

The one-per-merchant/event rule applies to event-led publishing, product
template copies, ordinary product creation and editing, and organizer
acceptance. Shared workflow validation MUST prevent a new or updated product
from projecting a different pickup arrangement. A disabled form control alone
is insufficient.

External and legacy records can contain per-product pickup records or
conflicting arrangements. Clients MUST preserve those signed records and
surface an explicit `handoff_reconciliation_required` state. They MUST NOT
silently select one, rewrite signed history, accept another contradictory
product, or use local intent as authority. Reconciliation requires a deliberate
transition using the rules below.

## Wire contract

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

The coordinate kind distinguishes the NIP-52 event link from product
membership. Unknown `a` kinds remain preserved as unsupported references but do
not become products. Multiple NIP-52 event links or multiple organizer pickup
options are conflicting evidence for the initial workflow.

### Merchant product (`30402`)

A participating physical product remains merchant-authored. It emits an `a`
reference to the organizer collection as a discoverability claim/request. Its
event-fulfillment `shipping_option` projects the merchant/event arrangement by
selecting exactly one of:

- a merchant-authored pickup option for `merchant_handoff`; or
- the exact organizer pickup option, or the exact event collection that selects
  it, for `organizer_handoff`.

Every current product for the same merchant/event MUST project the same
effective pickup coordinate. A later collection or local-intent change does not
rewrite a product automatically; changing the arrangement requires new signed
product revisions.

Ordinary collection membership is not a fulfillment reference. Readers
preserve all repeated collection and shipping references, but consequential
resolution fails closed when the full set is ambiguous or has conflicting cost
evidence.

Product-to-collection reference is never proof of acceptance. Only a valid
organizer-authored collection that references the exact product coordinate
grants membership in that catalog.

### Private merchant-present sale authorization

`merchant_handoff` alone does not prove that a buyer and merchant are together
at a booth. A URL parameter, locally selected checkbox, cached listing, or
buyer-authored field is context only and MUST NOT bypass stock, price, payment,
identity, or handoff checks.

For an immediate booth sale, the merchant MUST issue a short-lived, one-use,
private `merchant_present_sale_authorization` after reviewing the exact purchase
group and positively confirming the physical units available for that sale.
This is a private kind `16` application rumor carried in a NIP-59 gift wrap,
not a public event or collection tag. The buyer authenticates the unsigned
rumor through the merchant-signed seal and verifies that the seal and rumor
authors match. A signed-in buyer receives it through the existing private
channel. A guest may import one exact wrap addressed to the guest's
order-scoped ephemeral pubkey through a direct in-person transfer. This is a
receive-only extension to the bounded guest-order exception: it permits
decryption of that exact short-lived authorization in the same tab, but no
relay inbox declaration or polling, merchant reply channel, extra guest
signing authority, durable conversation, or key lifetime beyond the existing
guest deadline. The wrap MUST NOT be published as a guest inbox message.

The buyer keeps the exact submitted booth order and reviewed commerce
fingerprint in session-only storage until payment and handoff finish. This
snapshot is required because a guest has no durable self-copy or inbox; it is
matched against the merchant authorization before payment and is removed with
the session. It MUST NOT be copied to organizer storage, durable guest order
history, telemetry, or diagnostics. Losing the session fails closed and
requires the merchant and buyer to restart the immediate sale.

The authorization contains only:

- contract version and literal `scope: physical_availability_only`;
- exact private order id, merchant pubkey, buyer pubkey, and event organizer
  pubkey;
- exact calendar, collection, merchant pickup, and product coordinates and
  signed revisions, with quantity per product;
- a domain-separated hash of the buyer's exact reviewed commerce fingerprint,
  which binds price, total, currency, payment destination, and fulfillment
  terms without copying those values into the authorization;
- a random 256-bit single-use nonce; and
- issuance time and an expiry no more than five minutes later.

It MUST NOT contain buyer contact, delivery address, free-form notes, invoice,
preimage, payment hash, wallet/provider data, or an organizer recipient. The
buyer verifies merchant authorship, seal, expiry, exact order/buyer binding,
current accepted merchant/event graph, reviewed commerce fingerprint, product
revisions and quantities, payment destination, and handler before payment. The
authorization can resolve uncertainty from cached listing stock because the
merchant explicitly confirms on-hand units; it cannot revive a deleted or
conflicting listing, contradict a newer signed revision observed after
issuance, change a product price or payment destination, prove settlement, or
grant organizer handoff authority.

After validating every field, the merchant atomically persists an account-
scoped, content-safe use reference derived from merchant, buyer, order, and
nonce before confirming the sale. A bounded relay view cannot prove that an
authorization was never presented elsewhere, so one-use enforcement also
requires the merchant's current durable consumed-state check at
settlement/handoff time.

The merchant separately confirms settlement and physical handoff through the
private order lifecycle. For a signed-in buyer those merchant-authored updates
remain recoverable through the existing private channel. An immediate guest
sale creates no reply inbox and requires no contact form: the guest tab retains
only the exact submitted order and authenticated physical-availability
authorization while the buyer and merchant finish payment and handoff together.
It MUST NOT claim a later payment or handoff state it did not receive. The
merchant retains the authoritative encrypted lifecycle record. If the buyer
leaves before completion or wants later digital recovery, the sale becomes
remote merchant pickup and uses the bounded merchant-only guest recovery
method.

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
pickup/event organizer, and every item must resolve to the same exact
organizer-handoff graph. New orders use the current graph. A verified existing
order may use only its retained original graph and durable pre-transition
checkpoint under the compatibility rule in **Publishing and updates**. The
NIP-59 rumor remains unsigned, but the reader must authenticate it through the
merchant-signed seal and verify that seal and rumor authors match. Catalog
acceptance alone, a merchant request alone, pickup authorship alone, or a local
order id alone is insufficient.

Mutual organizer-handoff authorization for a new order consists of all of these
current signed facts:

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
from the current collection revokes the offer for future checkout and new
orders. An arrangement change alone cannot rewrite a verified pre-transition
order snapshot or retract an already delivered private receipt.

Missing, stale, deleted, malformed, conflicting, unsupported, or one-sided
evidence never grants receipt or handoff authority.

Before the irreversible `handed_out` acknowledgement, the organizer must still
resolve the exact pickup revision captured by the receipt. For a new order, a
newer calendar, collection, or product revision is usable only when Core
resolves the same current coordinate graph, merchant acceptance, and
organizer-handoff authority. For a verified pre-transition order, the retained
original graph and durable checkpoint remain authoritative unless valid
same-author deletion, merchant revocation, or conflicting lifecycle evidence
blocks handoff. A replaced pickup revision cannot be substituted silently.

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

A positively observed and authenticated ready receipt, bound to the exact
authoritative graph for that order under the rules above and to exact
merchandise, is sufficient authority for the organizer to hand out the product.
Inbox pagination and coverage describe message discovery, not the authority of
positive evidence already found. A 400-event page cap,
continued scan, failed relay, stale result, or inability to prove global inbox
completeness therefore does not negate a valid receipt. The UI exposes degraded
discovery and keeps retrying so it can find additional relevant messages.

Revocation is race-sensitive. A valid matching revocation known before handoff
makes the claim revoked and blocks `handed_out`. A matching acknowledgement and
revocation are conflicting evidence and also fail closed. The possible
existence of an unseen revocation does not invalidate a valid authorization
already found: Nostr relay reads cannot prove the global absence of unseen
events. Sending or delivering a revocation is likewise not proof that the
organizer observed it before physical handoff, so merchant takeover still
requires direct coordination.

## Evidence and resolution

All consequential resolution validates event id, signature, kind, full
coordinate, required tags, and author relationships before using data.
Addressable revisions use NIP-01 ordering: greatest `created_at`, then lowest
event id for equal timestamps.

Valid same-author NIP-09 deletion evidence is monotonic. An exact `e` deletion
removes that revision. An `a` deletion removes revisions at or before the
deletion timestamp. Cross-author or malformed deletion requests have no effect.

The shared resolver exposes these states rather than collapsing them:

- `active`: all linked current records resolve and the event has not ended;
- `ended`: all linked current records resolve and the calendar end has passed;
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
Catalog browsing may render cached/partial evidence with truthful state. A
partial relay view does not veto an exact positive graph when the required
listing, collection, event, and pickup revisions were all observed live; it
does prevent an incomplete negative observation from being presented as
absence. Cached-only required evidence is stale. New direct-payment admission
requires that current positive graph plus a deterministic total. Deleted,
malformed, conflicting, unsupported, unavailable, or stale required evidence
blocks a new direct payment. A durably checkpointed pre-transition order resumes
only through its verified historical snapshot; the current arrangement cannot
replace its payment destination, amount, or fulfillment authority. Order-first
is available only when the remaining order can be represented safely.

## Publishing and updates

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

Changing a merchant/event arrangement is a deliberate batch transition. Before
signing, Merchant MUST show every known accepted or pending event listing that
will change, the verified source arrangement and revisions, the target pickup
and handler, and which organizer acceptance update is required. It persists a
local transition manifest keyed by merchant and collection with the exact
source revisions and planned product coordinates. That manifest is recovery
state, not protocol authority.

The transition then:

1. verifies that the source graph and affected set have not changed;
2. publishes and receives an intended-relay ACK for a new target pickup when
   one is required, or verifies the organizer's current offered pickup;
3. signs and persists each required product revision before relay I/O;
4. publishes those exact revisions and records ACK/reject/timeout separately
   for every listing; and
5. obtains a current organizer-authored acceptance revision where the target
   or changed product projection requires it.

Each product revision created by this deliberate transition includes the
public Conduit extension tag
`["conduit_event_handoff_change", <collection-coordinate>, <superseded-product-event-id>]`.
The tag is a re-acceptance marker, not acceptance authority. A resolver that
sees it MUST keep that product pending until the organizer collection has a
revision strictly after the changed product revision. Organizer acceptance
publication advances its replaceable-event timestamp beyond both the prior
collection and the candidate product. This makes the transition
self-describing for a fresh client that cannot retrieve the superseded
addressable product event. Ordinary same-arrangement product edits omit the
marker and retain the existing coordinate acceptance.

Retry MUST reuse each exact persisted signed event and MUST target only records
without a sufficient ACK. A partial transition reports the successful and
unsuccessful listings separately and never claims that the arrangement changed
for every listing. Until every required listing projection and organizer
acceptance resolves to the target arrangement, the merchant/event is
`handoff_transition_incomplete`: new event checkout is blocked and new or
edited event listings cannot deepen the conflict. A changed source revision or
affected set stops the batch and requires a newly reviewed plan rather than an
automatic overwrite.

Existing orders are not migrated by the batch. Their exact payment and
fulfillment snapshots remain immutable, and an arrangement change MUST NOT add
an organizer recipient or create an organizer receipt for an order that
originally selected merchant handoff. An existing organizer-handoff order may
continue only from a durable order/lifecycle checkpoint that predates the
transition and retains verifiable exact signed product, pickup, collection, and
calendar revisions plus the original handler and handoff mode. A local order id
or the new current arrangement alone is insufficient. Missing original evidence
surfaces `original_handoff_unverified` for manual recovery; clients MUST NOT
substitute the current arrangement or broaden data sharing.

Private organizer receipts, revocations, and acknowledgements require a usable
recipient kind-10050 inbox. Each signed gift wrap is persisted before its first
relay I/O; retry reuses the exact immutable wrap. Zero ACKs remain an explicit
undelivered state, partial delivery remains visible, and a merchant-delivered
order is not duplicated merely because the separate organizer leg needs retry.
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

## Product workflows

The initial product fulfillment selector has three intents: Digital, Ship, and
Local pickup. Local pickup can import a collection `naddr`, select bounded
known/followed/featured organizer evidence already discovered by the client, or
create merchant-owned event and pickup records.

When the merchant joins or configures an event, Merchant presents two explicit
handoff choices for that merchant/event rather than a choice or receipt-sharing
checkbox on every product:

- **I hand it out:** create or reuse the one merchant-owned event pickup.
  Organizer receipt sharing is off.
- **Organizer hands it out:** select the current organizer pickup advertised by
  the event and opt into the minimal receipt workflow. This choice is hidden
  when current signed evidence does not make it available.

After the first signed event product exists, product forms show the inherited
arrangement and exact pickup provenance rather than resetting to merchant
handoff. Event-led creation, template copies, ordinary product creation and
editing, and organizer acceptance all call the same arrangement validator.
Changing the arrangement starts the reviewed batch transition in **Publishing
and updates**; it is not an incidental product-form edit.

Legacy order snapshots without an explicit handoff mode grant no organizer
visibility. A merchant cannot turn organizer sharing on for an already accepted
order. Legacy products with equivalent merchant-owned per-product pickups may be
offered a deliberate consolidation into the one merchant/event pickup. Legacy
or external conflicts remain `handoff_reconciliation_required` until every
affected listing and required organizer acceptance reaches one verified
arrangement.

Participation is `pending` when the product references the collection but the
organizer collection does not reference the product. It is `accepted` only
when both sides reference the exact coordinates and organizer authorship
validates. Ended events are not offered as presets.

## Catalog and discovery

The canonical catalog URL encodes the organizer collection `naddr`. Friendly
aliases may redirect to it but are not metadata or membership authority.

The page renders organizer trust context separately from signed provenance,
calendar metadata from the linked NIP-52 record, pickup expectations from each
accepted product's exact linked `30406`, and only exact product coordinates
present in the organizer collection. Products are grouped or labeled by
merchant booth and show whether pickup is from the merchant or event organizer.
One-sided merchant claims and forged tags never add products.

Discovery is bounded to imported coordinates and organizer pubkeys already
known through an explicit user, follow, or deployment-curated decision. Core
does not globally ingest self-described events as trusted catalogs.

## Checkout and order lifecycle

Every event purchase starts from an explicit event/merchant context and uses an
isolated purchase group containing only the reviewed lines for that merchant
and handoff graph. Unrelated shopping-bag contents do not block or silently join
the sale. Multiple products with the same merchant/event arrangement may be
reviewed and purchased together. Mixed handlers or shipped lines require a
different purchase group rather than changing this order's fulfillment.

All event pickup checkout:

- uses the resolved pickup option price and selected exact revision;
- snapshots pickup coordinate/revision, price/currency, title, public location,
  organizer pubkey, merchant pubkey, event coordinate, collection coordinate,
  handoff mode, exact handler pubkey, and exact product revisions;
- verifies merchant identity, reviewed product price and quantity, payment
  destination and amount, payment result, and selected handoff authority at the
  action that consumes each fact;
- does not request or emit a buyer delivery address or show shipping/carrier
  actions;
- does not show a universal contact form for a signed-in buyer with a usable
  private reply path;
- requires a current usable organizer private-message inbox before accepting a
  new organizer-handoff order; and
- requires snapshot parity before signing, paying, or retrying.

Failures identify the fact the buyer or merchant can repair: unavailable or
conflicting listing/stock evidence, invalid merchant identity, changed price or
quantity, changed payment destination, amount mismatch, unconfirmed settlement,
expired or mismatched booth authorization, changed handoff authority, missing
organizer acceptance, or unavailable organizer inbox. A generic failure or a
buyer-controlled override is insufficient.

### Merchant-present sale

An immediate booth sale proceeds as follows:

1. The buyer enters through the explicit event/merchant booth context and
   selects physical goods from that merchant's isolated purchase group.
2. The buyer reviews the exact items, quantities, total, merchant payment
   destination, and merchant handoff.
3. The merchant confirms the exact on-hand units and issues the private
   `merchant_present_sale_authorization`.
4. The buyer verifies that authorization and pays the merchant.
5. The merchant confirms settlement and physical handoff. Only then is the
   order complete.

The merchant-signed authorization is current physical-availability evidence;
cached listing stock is discovery evidence. Once the exact authorization is
valid, the confirmed in-person journey does not show the generic
"Availability may still change" warning. It also omits delivery address,
shipping steps, and remote-pickup contact requirements. A guest can complete
the physical sale without supplying contact data; their tab retains the exact
order and merchant availability authorization but does not invent a digital
payment or handoff receipt. A buyer departure, delayed handoff, or failed
settlement exits this immediate path and uses the applicable recovery or
remote-pickup rules instead of claiming completion.

### Remote merchant pickup

Opening the same merchant event listing remotely, or continuing a purchase for
later collection, remains `merchant_handoff` but is not merchant-present. It has
no `merchant_present_sale_authorization`, may truthfully warn that availability
still needs merchant confirmation, and follows the ordinary private order
lifecycle. The merchant owns payment confirmation and sends private
`processing`, `ready_for_pickup`, and `complete` statuses. Pickup UI presents
authenticated `processing` after payment confirmation as `preparing_pickup`;
this does not introduce a second wire status. A guest who cannot receive
replies retains one bounded merchant-only email or phone recovery method; it is
not shared with an organizer.

### Organizer handoff

The buyer pays the merchant, never the organizer. The buyer and merchant see
these distinct states:

1. `awaiting_merchant_confirmation`: the order or payment report is delivered,
   but the merchant has not confirmed settlement; nothing is shared with the
   organizer.
2. `preparing_pickup`: the merchant has confirmed settlement and is preparing
   the goods. This is the pickup presentation of the merchant's authenticated
   `processing` status; the organizer still has no full order, contact data, or
   payment material.
3. `ready_for_pickup`: the merchant explicitly confirms readiness and release,
   then sends the minimal `organizer_fulfillment_receipt`. This is the first
   organizer-visible order-specific state and the only state that authorizes
   handoff.
4. `collected`: the organizer records physical collection with the exact
   `organizer_handoff_ack`. This presentation state is derived from the ack's
   existing `handed_out` wire assertion; the merchant remains the only author
   allowed to send the ordinary completion status to the buyer.

A signed-in buyer receives merchant-authored private status updates. A guest
has no reply inbox: Merchant uses the bounded recovery channel to communicate
later readiness, and the guest's local recovery view displays only states it
has actually observed. The Merchant and organizer surfaces still use the same
state names, but they MUST NOT imply that an out-of-band guest received an
update.

The organizer sees only the receipt, public product resolution, revocation,
and acknowledgement data defined in this contract. These state names do not
grant access to the full order, buyer contact or identity, invoices, proofs,
payment secrets, or unrelated merchant data. A valid acknowledgement may
enable merchant completion; it never confirms payment on the merchant's behalf.

## Required validation

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
  retry the exact signed events, expose zero/partial ACK states, and remain
  idempotent across reload.
- A found valid ready receipt remains actionable when the inbox is capped,
  partial, stale, or otherwise cannot prove completeness; no valid receipt
  means no handoff authority.
- A valid revocation known before handoff removes readiness and prevents
  handout. A hypothetical unseen revocation does not negate found authority; a
  valid organizer acknowledgement grants no merchant-only lifecycle authority.
- Signed-in pickup completes without a contact form. A guest merchant-present
  sale completed in person also needs no contact form. Guest pickup that
  continues after the booth interaction requires one merchant-only recovery
  method and never copies it to the organizer.
- Cross-app browser fixtures cover event creation, both handoff modes,
  organizer acceptance, checkout disclosure/no address, paid or zero-cost ready
  delivery, organizer handoff acknowledgement, and merchant completion.
- Ordinary shipping, digital products, legacy single-recipient orders, and
  non-event Gamma collections keep their prior behavior.
- **AC-EM-13 — Merchant/event configuration:** Before first publication, the
  merchant can choose exactly one arrangement for the event. Organizer handoff
  is hidden without a current usable organizer offer. A local pre-product intent
  cannot authorize publication, acceptance, checkout, stock, or payment.
- **AC-EM-14 — Inherited signed projection:** Event-led publishing, template
  copies, ordinary product creation/editing, and organizer acceptance all use
  the shared arrangement validator. A new product inherits the existing exact
  pickup instead of resetting to merchant handoff, and contradictory output is
  rejected before signing.
- **AC-EM-15 — Reused pickup and purchase group:** Two products for one
  merchant/event reuse one pickup, remain one arrangement, and complete one
  combined purchase. Unrelated shopping-bag contents remain outside that
  purchase and do not block it.
- **AC-EM-16 — Legacy reconciliation:** Equivalent legacy per-product merchant
  pickups can be consolidated deliberately. Conflicting legacy or external
  listings surface `handoff_reconciliation_required` and cannot be silently
  accepted, published over, or used for new checkout.
- **AC-EM-17 — Arrangement transition:** Changing arrangements previews every
  affected listing, re-signs only required records, obtains organizer acceptance
  where required, persists each signed event before relay I/O, reports
  per-record ACK/reject/timeout, and retries only the exact failed or unacknowledged
  events. Partial completion never reports the whole merchant/event changed.
- **AC-EM-18 — Historical order boundary:** Orders created before an arrangement
  transition retain their original payment and fulfillment snapshots. Continued
  fulfillment requires the durable pre-transition checkpoint and exact verified
  old graph; it never upgrades a merchant-handoff order into organizer sharing
  or substitutes the new arrangement when old evidence is missing.
- **AC-EM-19 — Booth authorization:** Only a current, merchant-authenticated,
  short-lived `merchant_present_sale_authorization` for the exact purchase group
  establishes merchant presence and physical availability. URL flags,
  checkboxes, cached stock, expired authorization, and mismatched revisions
  cannot bypass stock, price, payment-destination, settlement, or handoff checks.
- **AC-EM-20 — Merchant-present journey:** Signed-in and guest buyers can select
  booth goods, review one total, pay the merchant, and finish only after merchant
  payment and handoff confirmation. The confirmed journey omits shipping,
  remote-pickup fields, and the generic availability warning; guest completion
  retains no unobserved merchant status and the merchant keeps the authoritative
  encrypted lifecycle record.
- **AC-EM-21 — Remote merchant pickup:** Signed-in and guest remote pickup stays
  distinguishable from merchant-present sale, preserves merchant-owned payment
  confirmation, and exposes truthful `preparing_pickup`, `ready_for_pickup`, and
  completion states with bounded merchant-only guest recovery where required.
- **AC-EM-22 — Organizer-assisted lifecycle:** Signed-in and guest organizer
  handoff exercises `awaiting_merchant_confirmation`, `preparing_pickup`,
  `ready_for_pickup`, and `collected`. Composed payment confirmation, minimal
  receipt delivery, revocation, acknowledgement, and merchant completion tests
  prove that organizers receive no full order, contact, payment secret, or
  merchant-only authority.
- **AC-EM-23 — Cross-tab regression:** The existing two-tab cart persistence and
  purchase-group isolation regressions pass with the event purchase group and do
  not duplicate, lose, or combine unrelated lines.
- **AC-EM-24 — Browser and human evidence:** Desktop and mobile browser evidence
  records both publishing entry points and all three buyer journeys at the exact
  candidate head. Physical-device layout, real NIP-07/NIP-46 signing, relay
  delivery, and live Lightning settlement remain explicit human-QA gates unless
  they were actually observed.

## Privacy and diagnostics

Public events may contain only intentional public event and handoff details.
Buyer contact remains inside the encrypted buyer-to-merchant order path and is
never copied to the organizer receipt. Telemetry, logs,
diagnostics, test artifacts, screenshots, and demo evidence must exclude
pubkeys as active-user identifiers, product/order contents, messages,
addresses, contact data, ciphertext, invoices, signer secrets, and wallet
connection material.

Operational evidence may include event kind, state class, aggregate relay
counts, and content-free ACK/reject/timeout outcomes.
