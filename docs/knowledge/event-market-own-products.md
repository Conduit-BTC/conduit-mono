# Organizer-owned event products

An organizer may also be a merchant at their own event. The same signed
product, collection membership, and pickup evidence still apply; ownership is
not a substitute for a valid product or pickup reference.

- A pickup authored by the product's merchant is merchant handoff, including
  when that merchant also organizes the event. Do not require a third-party
  handoff receipt to the same account.
- Resolve the merchant's direct booth reference even when its author matches
  the organizer. A different merchant still needs an organizer-offered pickup
  to request organizer handoff.
- Publishing an own-event product signs a separate collection acceptance after
  the current product preview and pickup evidence resolve. Other merchants'
  products remain requests until the organizer accepts them.
- Preserve every existing offered pickup and product membership when updating
  the collection. The dedicated product stays hidden from ordinary catalogs.
- Product publication and collection acceptance are not atomic. A failed
  acceptance must say the product already exists and offer acceptance retry,
  not create another product. Persist a signed collection before delivery;
  retry that exact record and do not overwrite a known newer collection choice.
- A relay acknowledgement is delivery evidence, not proof every shopper has
  discovered the new collection.

Cart and order parsing must accept new same-account merchant-handoff snapshots.
Previously valid same-account organizer-handoff snapshots remain readable;
this does not grant a new third-party receipt authorization. New fulfillment
resolution consistently chooses merchant handoff for these products.

Coverage: `tests/event-market-product-frontier.test.ts`,
`tests/merchant-event-product-acceptance.test.ts`,
`tests/order-pickup-fulfillment.test.ts`, and the own-product publication/rejected
acceptance retry flow in `e2e/event-market.playwright.ts`. The browser fixture
uses synthetic identities and a local relay; external-signer and public-relay
validation remain separate.
