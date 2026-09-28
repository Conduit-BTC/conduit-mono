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
