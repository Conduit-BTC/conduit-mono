# Event Markets And Local Pickup

**Status:** experimental Event Market implementation contract. Uses kind `30409` and causal merchant authorization. Deployment and real-world fulfillment require separate validation.

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

Read the known organizer-signed market record and calendar before candidate discovery. Fast provisional discovery may paint clearly provisional product candidates before per-merchant authorization is checked. A candidate is not an admission claim and cannot authorize adding to cart, ordering, or payment. Known negative signed evidence suppresses a candidate; an unavailable optional source does not prove absence. Use the organizer's observed NIP-65 write relays with bounded hints and fallback relays; retain unioned signed observations. Derive the finite roster author set, then query kind `30402` by those authors and the exact market `#a` tag. Filters yield candidates only. Before treating a candidate as an admitted event product or allowing a consequential action, including at a direct product link, resolve the current signed product revision and applicable NIP-09 deletion evidence; verify merchant author, market tag, active grant, visibility, and valid product terms. A newer untagged or deleted revision supersedes an older tagged product. Retain stronger known signed market, authorization, and product evidence when relays return stale or partial data. Surface incomplete evidence instead of treating it as proof of admission or removal.

An unpaid cart resolves current open market, calendar, merchant row, active validated authorization tip, product, and payment terms again before payment. A series purchase requires an explicitly selected current or future occurrence with complete signed membership and occurrence evidence. Missing siblings do not invalidate a verified selected date; an unresolved master or selected date blocks its purchase. Its participation identity is market coordinate plus merchant pubkey and, for a series, selected occurrence coordinate. Compatible products from that merchant at the same date form one purchase; products selected for different dates remain separate. A roster revision or booth rename alone does not split it. A material mode, assignment, selected date or membership, product, price, or payee change requires buyer review before payment. Calendar time does not close the whole market; existing single-date open-market behavior remains. There is no separate buyer event-pickup fee; event costs belong in merchant prices, and the merchant remains payee.

Created and paid orders retain the exact market revision, merchant row, observed authorization tip and required ancestry, relevant observed deletion evidence, calendar and product revisions, payee, and accepted terms. Series orders also retain the exact signed `31924` revision and selected occurrence revision so their same-author membership can be verified later. This is a bounded observation snapshot, not proof that no unseen event existed. A later roster, schedule, or occurrence edit does not reinterpret an order. Material handoff changes to an existing order require an explicit authorized per-order update or transfer and buyer notice. Organizer handoff grants physical release duties only under the merchant's private order-specific authority. The merchant's private ready receipt carries `releaseAuthorized: true` after its paid or zero-cost check; it carries no payment confirmation or full order. Private release, delivery, and recovery remain content-minimal and encrypted, and the organizer does not gain merchant payment authority.

### Compatibility and validation

New kind `30409` records do not reinterpret old kind `30405` product collections or per-product kind `30406` event pickups. Collection-based event readers, writers, pickup checkout and handoff compatibility are removed. Organizers must repost events in the new structure; there is no automatic conversion, dual authority or old-model fallback. Ordinary product collections and standard shipping remain separate commerce concepts. Do not derive participation from previous products or republish all products for a roster edit.

Future-event validation covers unapproved product spam, automatic admission for approved merchants, product revision/untag/deletion, organizer mode and assignment edits, revocation and reapproval, stale and divergent relays, stale organizer edits, direct links, compatible cart grouping, buyer review, historical order continuity, and composed Market/Merchant browser journeys. Local tests do not establish live-relay convergence or physical handoff.

## Usable workflows and recovery

The same Event Market link identifies the host workspace and merchant participation surface. An authenticated request, invitation, decline or withdrawal is private coordination, never public admission authority. The merchant sees the current signed approval separately from private request delivery. The organizer can admit their own merchant identity without manually copying a public key. Approved merchants add existing products or create a product in the event context; product ownership, stock and prices stay with the merchant.

Authoring supports description, banner upload/preview, location, timezone and concrete single or recurring dates. Corrections are available after creation. Merchant profiles label rosters and booth signs, with public-key fallback when a profile is unavailable.

Checkout compares material accepted terms and retains the latest authenticated evidence when only an unrelated roster revision changed. Positive required facts, source freshness, observed negative evidence and coverage are distinct. Missing ancestry, known conflicts/revokes/deletions, and missing current selected facts block; a failed optional relay alone does not.

Handoff delivery retains exact encrypted operations for retry. Completed delivery leaves the bounded pending queue without erasing claim identity or stronger authenticated evidence. Merchant inbox self-copies participate in duplicate-issuance protection on a fresh device. An exact authenticated handoff acknowledgement may support completion despite an incomplete unrelated inbox read; known conflicting or revoked evidence still blocks.

Finite recurrence, event pickup versus ordinary shipping, and optional contact-free immediate guest pickup compose with these workflows. Contact-free pickup is merchant opt-in for a currently occurring merchant-present date and requires the buyer to keep their private receipt. Ordinary contact-based pickup remains available. The organizer fee and offline checkout-wallet recovery extensions require their separately reviewed payment-router contracts; basic physical handoff does not imply those capabilities.

## Validation boundary

Maintain a current evidence index in `docs/knowledge/event-market-validation-evidence.md`. Composed browser journeys must start with event creation and merchant enrollment, not only seeded approvals. Include source failure, signer interruption, reload, changed purchase terms, recurring date choice, shipping, optional contact-free receipt, duplicate delivery and stock-once cases. Local synthetic signers, relays and invoices do not establish physical-device, live payment or real pickup success.
