# Event Market checkout choices

Future Event Market commerce uses the experimental Open Markets Event Market
proposal. It is separate from the historical 30405/30406 pickup contract.

## Pickup and ordinary shipping

A physical signed product may reference a 30409 market and retain ordinary
merchant shipping terms. Market lets the buyer choose event handoff or shipment.
The two lanes have separate cart lines and checkout purchases. Event handoff
retains exact signed market, selected occurrence, admission and product evidence.
Shipment uses ordinary shipping options, destination checks and fees. Both pay
the merchant. A cart-only market/date reference permits returning to the event
choice and is excluded from shipment order payloads.

Changing a choice reads current positive product evidence and checks the cart
revision in the canonical transaction. It preserves quantity and creates a new
line incarnation; a previously captured purchase cannot consume that changed
line. Stock checks count the same product across lanes and dates. These checks
are local cart bounds, not relay-wide reservations or separate event inventory.

Exact live product evidence may be usable with partial relay coverage. Cache-only
or filtered product results cannot authorize a lane change. Pickup still requires
its full actionable signed evidence. An unrelated unavailable source cannot erase
stronger positive evidence or an observed revocation/deletion.

The reference implementation does not modify the signed product to record a
buyer choice and introduces no new public event kind. The shared control lives
in `@conduit/ui`; cart transactions and choice preparation live in Market.

## Contact-free immediate guest handoff

The signed physical product extension `conduit_event_guest` with the value
`contact_optional` is an experimental Conduit convention. It is not part of the
merged Open Markets specification. Absent, duplicate or malformed policy tags
require contact details; an unsigned content field cannot grant permission.
Merchant authoring defaults this setting off.

Only an ongoing selected occurrence with `merchant_present` fulfillment and
opt-in on every exact signed product can use this guest choice. The full signed
market, occurrence, grant and product snapshot checks still apply. Shipping,
organizer handoff, future dates and signed-in orders retain their existing
contact and delivery contracts. Ordinary guest pickup requires at least one
contact method; shipping requires both email and phone.

The guest downloads and acknowledges a private JSON receipt before checkout.
A random 32-byte bearer secret binds that receipt to the order UUID and merchant
through a domain-separated SHA-256 commitment. Only the name or pseudonym and
commitment are sent in the encrypted private order. The secret is not a Nostr
identity key, payment credential or proof of payment. It is not persisted in
application storage, published in public events or included in diagnostics.
Changing the cart line incarnation, quantities, merchant or signed commerce
fingerprint requires a new receipt acknowledgment.

Merchant Orders verifies a presented receipt against the original private order
and merchant. Verification does not send funds or establish payment settlement.
Support, refunds and rebates are arranged manually with the customer in person;
no guest reply inbox or automatic payout is introduced. Anyone holding the
receipt file can present it, and the guest is shown that trade-off before buying.
Protocol-bearing browser tests disable traces, video and screenshots.
