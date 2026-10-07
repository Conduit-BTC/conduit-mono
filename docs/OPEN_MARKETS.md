# Open Markets in Conduit

This is the implementation map for peers and contributors integrating with
Conduit Shop (Market) and Conduit Sell (Merchant Portal). It describes the
client repository, including deliberate limits and extensions. It does not
certify a deployment or another client's compatibility.

**Last checked:** 2026-09-27. **Owner:** Commerce/Core maintainers.
Client baseline: [`d6aa7863`](https://github.com/Conduit-BTC/conduit-mono/tree/d6aa786301cf8adcfcf834435c2ca7301cef4d30),
including the merged experimental Event Market foundation. The Event Market
sections below describe the current client cutover; this is not deployment evidence.

## Sources and scope

- [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md) defines the
  classified-listing foundation. Conduit uses the commerce extensions in the
  [Open Markets working specification](https://github.com/OpenMarketsFoundation/specification).
- Reviewed Open Markets baseline:
  [`24313d75`, README.md](https://github.com/OpenMarketsFoundation/specification/blob/24313d75bb6ebf3ba37266a504980340308b4dc8/README.md).
  That source is itself a draft; it is the active working reference, not an
  accepted commerce NIP or a claim of complete Conduit conformance.
- [GammaMarkets `market-spec`](https://github.com/GammaMarkets/market-spec/blob/main/spec.md)
  is the historical source of this commerce model. Its wire behavior remains
  relevant to older records and deployed clients, but new behavior follows the
  current Open Markets venue and relevant NIPs.
- Public sources define wire meaning. The support and exceptions below describe
  Conduit. Unmerged proposals and other clients' behavior do not redefine the
  working specification.

For all NIPs, use [PROTOCOLS.md](PROTOCOLS.md). Detailed client contracts remain
in [protocol.md](specs/protocol.md), [fixed product shipping](specs/fixed-product-shipping.md),
and [event markets](specs/event-markets.md). Read those for implementation work;
this guide does not duplicate or replace their safety and recovery rules.

## Current implementation

“Reads” means a reachable client path, not merely a constant or parser export.
“Publishes” means a client workflow or the explicitly named operator script.
Local tests below establish bounded behavior, not cross-client certification.

| Surface                                      | Shop / Sell behavior on the client baseline                                                                                                | Limits and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product listings, `30402`                    | Shop reads; Sell reads and publishes Markdown descriptions and structured tags, including explicit product format and variation references | [Builder/parser](../packages/core/src/protocol/products.ts), [publication tests](../tests/merchant-product-publishing.test.ts). Product identity is the full `30402:author:d` coordinate.                                                                                                                                                                                                                                                                                                                  |
| Retired collection-based event commerce      | Old event links request reposting; no legacy reader, writer, checkout or handoff path                                                      | Ordinary collections and standard shipping remain separate. [Cutover contract](specs/event-markets.md#compatibility-and-validation).                                                                                                                                                                                                                                                                                                                                                                       |
| Experimental Event Markets, `30409` / `3841` | Market supports current checkout; Merchant manages admission, association and private handoff                                              | Finite recurrence, fulfillment choices and optional immediate contact-free pickup compose with the current model. [Contract](specs/event-markets.md), [validation](knowledge/event-market-validation-evidence.md).                                                                                                                                                                                                                                                                                         |
| Shipping options, `30406`                    | Shop resolves; Sell publishes product-scoped fixed standard shipping and one reusable destination/weight policy                            | Fixed shipping retains country-level rules. Conduit table extensions support state/postal overrides, combined weight, independent currencies, and product packing adjustments; they are not upstream destination-schema adoption. Carrier APIs, packaging optimization, and selectable methods remain outside this slice. [Shipping helpers](../packages/core/src/protocol/shipping.ts), [table interoperability](knowledge/merchant-shipping-tables.md), [table tests](../tests/shipping-policy.test.ts). |
| Profiles and payment discovery, `0`          | Both use profile metadata; Shop reads current Lightning-address evidence for supported payment paths                                       | This is not a general implementation of Open Markets `payment_preference` values or eCash settlement. [Profile reads](../packages/core/src/protocol/commerce.ts), [payment-readiness tests](../tests/market-merchant-payment-readiness.test.ts).                                                                                                                                                                                                                                                           |
| Application handlers, `31990`                | Operator script publishes Shop/Sell descriptors; clients attach NIP-89 attribution                                                         | A descriptor or kind constant does not establish merchant `31989` recommendation handling or service-assisted checkout. [Descriptors](../packages/core/src/protocol/nip89.ts), [publisher](../scripts/publish_nip89_handlers.ts), [tests](../tests/nip89.test.ts).                                                                                                                                                                                                                                         |
| Private conversation and orders              | Both exchange NIP-17/44/59 encrypted messages; commerce uses kind-16 rumors                                                                | **Conduit order payloads differ from the working specification.** See the private-order boundary below. [Parser](../packages/core/src/protocol/orders.ts), [messaging](../packages/core/src/protocol/messaging.ts), [order tests](../tests/order-publish.test.ts).                                                                                                                                                                                                                                         |
| Deletion and revision handling               | Both read signed revisions/deletions; Sell publishes deletion requests for owned listings and shipping options                             | Relay hints and search results do not override signed authority. [Product deletion](../packages/core/src/protocol/product-deletion.ts), [tests](../tests/product-deletion-resolver.test.ts).                                                                                                                                                                                                                                                                                                               |

There is no current client workflow for public product reviews (`31555`),
relay-published draft listings (`30403` or NIP-37), generic merchant application
recommendations (`31989`), generic eCash order settlement, escrow, or automatic
refunds. Local Merchant drafts are not protocol draft publication. Optional
Lightning wallet paths are described in [PROTOCOLS.md](PROTOCOLS.md).

## Current extensions and compatibility

### Private-order boundary

The Open Markets working source uses numeric kind-16 `type` tags, structured
commerce tags, human-readable content, and kind-17 payment receipts. Conduit
currently uses textual message types such as `order`, `payment_request`,
and `payment_proof` in kind-16 `type` tags, with Conduit JSON payloads in encrypted
content. The envelope uses NIP-17/44/59; the inner commerce grammar is not a
complete implementation of the working source.

The [Shop checkout](../apps/market/src/routes/checkout.tsx) emits product and
shipping references in tags as well as its JSON payload. The
[Sell publisher](../packages/core/src/protocol/merchant-order-publish.ts) and
[order parser](../packages/core/src/protocol/orders.ts) use the Conduit schemas.
A peer must implement that grammar or a reviewed adapter for order exchange;
shared kind numbers, listing compatibility, or successful decryption alone do
not prove order compatibility. Conduit payment proofs are kind-16 messages,
not a claim of generic Open Markets kind-17 receipt support.

Organizer handoff receipts, revocations, and acknowledgements are also Conduit
private-commerce messages. They do not grant an organizer merchant authority
or expose a full buyer order. Their contract remains in
[event markets](specs/event-markets.md).

### Experimental Event Markets

The current client uses dedicated kind `30409` markets linked to same-author
NIP-52 calendars or finite schedules and immutable kind `3841` merchant grants.
Merchant manages occurrence-scoped kind `30410` assignments for ordinary products. Market displays fast
provisional catalog candidates and rechecks exact signed authority before adding
or purchasing a selected product. Created orders retain accepted signed terms.
The existing historical private organizer handoff conveys physical release
authority. New organizer acceptance requires the separate advance delegation
and reconciliation integration described below.

This remains an experimental implementation of upstream PR #15, not accepted
Open Markets default-branch behavior. The proposal head was rechecked on
2026-10-05 at `8aa6d83331c750be22bf01413a1f932778e64568`. See the
[contract](specs/event-markets.md) and [current evidence index](knowledge/event-market-validation-evidence.md).

Collection-based Event Market readers, writers, pickup checkout and private
handoff compatibility are removed. Old links request reposting; there is no
automatic conversion or fallback. Ordinary product collections and standard
shipping are independent. Both event and merchant QR signs, including Print /
Save as PDF and selected occurrence links, remain supported.

### Other differences worth knowing

| Behavior                                             | Compatibility consequence                                                                                                                                                                                                                               | Implementation / evidence                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy JSON listing content                          | Full legacy Conduit records remain readable; partial external JSON projects safe display fields. New listings emit human-readable content and structured tags.                                                                                          | [Product parser](../packages/core/src/protocol/products.ts), [summary tests](../tests/product-display-summary.test.ts)                        |
| Generated price/category/merchant lines in summaries | Repeated card metadata is removed for display. Markdown cannot establish price, shipping, payment, stock, or identity authority.                                                                                                                        | [Display normalization](../packages/core/src/protocol/products.ts), [Markdown tests](../tests/product-description-markdown.test.tsx)          |
| Omitted product format                               | Compatibility reads default to `physical`, unlike the historical commerce default of `digital`. New Sell listings emit explicit format.                                                                                                                 | [Product parser/builder](../packages/core/src/protocol/products.ts)                                                                           |
| Legacy inline shipping tags                          | `shipping_cost`, `shipping_country`, `shipping_restrict`, and `shipping_exclude` have a display/republishing adapter. They do not authorize direct payment; the current fixed writer emits a referenced `30406`.                                        | [Adapter](../packages/core/src/protocol/compat/conduit-inline-shipping.ts), [publication tests](../tests/merchant-product-publishing.test.ts) |
| Listing checkout policy                              | `checkout_public_zaps` and `checkout_zap_message_policy` are Conduit policy tags. `visibility=hidden` means market-hidden public data, not encrypted/private publication. Peers must not infer generic Open Markets payment permission from these tags. | [Product builder](../packages/core/src/protocol/products.ts), [hidden-listing tests](../tests/cart-readiness-hidden-products.test.ts)         |

## Upstream proposals and client implementation status

This is the single proposal-status inventory for these documents. Status was
checked on the date above; links and exact revisions make later comparison
possible. None of these upstream PRs is accepted default-branch text.

| Upstream proposal                                                                              | Checked revision / status                                                                                                                     | Conduit relationship                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1: specification navigation](https://github.com/OpenMarketsFoundation/specification/pull/1)  | [`40a8d22d`](https://github.com/OpenMarketsFoundation/specification/tree/40a8d22d9bce1f8740d60bbf0dc4e25f6b7ef192), open, not draft           | Proposes `SPEC.md` and pillar navigation without changing the compatibility snapshot. Keep canonical links on default-branch `README.md` until accepted.                                                                                                                                  |
| [#13: destination constraints](https://github.com/OpenMarketsFoundation/specification/pull/13) | [`dba6ad71`](https://github.com/OpenMarketsFoundation/specification/tree/dba6ad71889d6da56938887599ad6c597ad6badd), open draft, stacked on #1 | Proposal only. The current fixed writer does not emit `destination_schema`/`destination`; event pickup explicitly rejects those tags. Country-level shipping is not adoption of this grammar.                                                                                             |
| [#14: offer-code commitments](https://github.com/OpenMarketsFoundation/specification/pull/14)  | [`427b1eea`](https://github.com/OpenMarketsFoundation/specification/tree/427b1eea6eab39ff1e65b996b685b11e8d2daa40), open, stacked on #1       | Proposal only. No current client offer-code commitment or redemption workflow.                                                                                                                                                                                                            |
| [#15: Event Markets](https://github.com/OpenMarketsFoundation/specification/pull/15)           | [`b2c20adc`](https://github.com/OpenMarketsFoundation/specification/tree/b2c20adce43598a17d67ea450d137f820fb08570), open, stacked on #1       | Proposes dedicated `30409` markets, causal `3841` merchant authorization, and finite schedule linkage. The client implements current checkout and handoff on this foundation. Collection-based event commerce is retired; old events must be reposted. The proposal remains experimental. |

Client implementation checked separately:

- [#550: causal merchant authorization](https://github.com/Conduit-BTC/conduit-mono/pull/550),
  merged at [`d6aa7863`](https://github.com/Conduit-BTC/conduit-mono/commit/d6aa786301cf8adcfcf834435c2ca7301cef4d30).
  That foundation originally left current-model checkout disabled; the current
  implementation connects checkout and private handoff.
- [#554: future checkout and handoff](https://github.com/Conduit-BTC/conduit-mono/pull/554),
  head [`09750c1a`](https://github.com/Conduit-BTC/conduit-mono/tree/09750c1a4abf143766bb75fa1cced06c1c83ddb1),
  open and unmerged, based on merged #550. The current implementation integrates
  its checkout and handoff behavior with recurrence, fulfillment choices and
  optional contact-free pickup, and removes collection-event compatibility.
- Those PRs identify upstream PR #15 revision
  [`d5601ce`](https://github.com/OpenMarketsFoundation/specification/tree/d5601ce00103fe0dc1f8874ed84d47622ac74c9c)
  as their source baseline. That is distinct from the upstream head checked
  above. Compare revisions before claiming alignment; this guide does not
  certify proposal conformance, checkout activation, or production behavior.

## Examples and peer verification

These are synthetic, unsigned excerpts, not signed events or payment authority.
The public listing/shipping pair illustrates the current fixed writer:

```text
30406:<merchant>:field-notes-shipping-standard
  content: ""
  ["d", "field-notes-shipping-standard"]
  ["title", "Standard Shipping"]
  ["price", "5", "USD"]
  ["country", "US", "CA"]
  ["service", "standard"]

30402:<merchant>:field-notes
  content: "A notebook for field notes."
  ["d", "field-notes"]
  ["title", "Field Notes"]
  ["price", "12", "USD"]
  ["type", "simple", "physical"]
  ["shipping_option", "30406:<merchant>:field-notes-shipping-standard"]
  ["checkout_public_zaps", "true"]
  ["checkout_zap_message_policy", "generic_only"]
```

A Conduit order rumor has the following shape before encryption:

```text
kind: 16
["p", "<merchant>"]
["type", "order"]
["order", "<order-id>"]
["amount", "<total-sats>"]
["currency", "SATS"]
["item", "30402:<merchant>:field-notes", "1"]
["shipping", "30406:<merchant>:field-notes-shipping-standard"]
content: JSON conforming to orderSchema, not plain-text order notes
```

Use the [schemas](../packages/core/src/schemas/index.ts) and
[checkout emitter](../apps/market/src/routes/checkout.tsx) for the full payload.
Never publish that private payload as a public listing or use real contact or
payment data in shared fixtures.

Run the existing bounded fixtures from the repository root:

```bash
bun test tests/product-display-summary.test.ts tests/fixed-product-shipping.test.ts tests/event-market-protocol.test.ts tests/order-publish.test.ts
```

These cover local parsing, builders, and delivery boundaries, including mocked
transport. They do not prove another client renders or processes an order.
For an interoperability check with [Plebeian](https://github.com/PlebeianApp/market)
or another peer, record the client versions, signed public fixture, and result:

1. **Discovery:** verify both clients display each other's core listing fields.
2. **External discovery to Conduit checkout:** verify product identity and
   fulfillment survive handoff. Private orders still require compatible
   Conduit grammar; record unsupported paths instead of declaring success.
3. **Reverse checkout:** verify a compatible handoff or clear link-out. This
   optional direction must not prevent discovery or the prior checkout path.

## Maintaining this guide

Update the affected row with changes to a reachable reader/writer, proposal
revision, compatibility adapter, or merged experimental branch. Record source,
date, code/test evidence, reader versus writer, and activation limits. Keep
proposal status here; link from general reference docs instead of copying it.

Use [network product posture](knowledge/decentralized-network-product-posture.md)
for shared safety/discovery rules and the [exception template](knowledge/compatibility-exception-template.md)
for a bounded migration. Keep quirks in Core adapters, preserve strict payment,
author, signature, and privacy invariants, and do not silently copy a peer's
non-spec behavior. When discovery or external-to-Conduit checkout breaks,
report a minimal public-safe reproduction, source expectation, observed peer
behavior, Conduit behavior, compatibility consequence, and proposed repair.

## Occurrence-scoped inventory and acceptance

The current experimental merchant-owned assignment and durable acceptance path,
its frozen proposal revision, and remaining integration limits are documented in
[Signed event publication](knowledge/signed-event-publication.md#occurrence-scoped-inventory-and-acceptance).
