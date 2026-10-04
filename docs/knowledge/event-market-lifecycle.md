# Event schedule, acceptance, and history

Current Event Markets use the experimental `30409` / `3841` model described in
[the Event Market contract](../specs/event-markets.md). A same-author NIP-52
calendar or finite `31924` schedule describes dates; the organizer's signed
market record controls whether new commerce is open or closed.

## Publication and current authority

Creation signs concrete calendar records before the market. An interrupted
operation retains its original coordinate and exact signed bytes for retry.
Close/reopen edits the market state and preserves its roster and schedule.
The writer refreshes known revisions before signing and surfaces stale or
conflicting evidence. A relay acknowledgement proves delivery to that relay,
not that every client has seen the update.

A roster row and a validated active merchant grant are both required for new
commerce. Approval and revocation are paired writes; partial delivery remains
visible and retryable. A missing row, known revoke, deletion, or unresolved
conflict cannot authorize a purchase. Merchant products remain merchant-owned;
a roster edit never republishes their products.

## Dates and discovery

Single-date market closure is explicit. A recurring market requires an
explicitly selected current or future occurrence, with verified membership in
the current schedule. Unresolved sibling dates do not invalidate a verified
selected occurrence. Removed or edited dates do not rewrite an existing order.

Both apps offer current/upcoming and history views. Calendar timezone and
concrete occurrence identity govern date presentation. Retained records and
partial reads support browsing, with incomplete coverage visible. They do not
establish current checkout authority or a complete archive of Nostr.

## Orders and pickup

Before creating a new order or payment, checkout rechecks selected signed
market, grant, calendar, product and payee terms. A material change requires
buyer review. Created orders pin the accepted signed evidence; subsequent
organizer edits do not reinterpret their goods, date, assignment or payee.

Merchant-present pickup and organizer handoff remain supported. Organizer
release requires an authenticated, order-specific merchant message and exact
merchandise evidence. An organizer acknowledgement grants no merchant payment
or general lifecycle authority. Private ready/revoke/acknowledgement operations
retain exact encrypted bytes and delivery evidence for retry across reload.
Known revocations and conflicts dominate retained positive evidence.

Event and merchant QR signs remain available with preview, batch selection,
and Print / Save as PDF. Merchant signs open that merchant's event catalog;
selected recurring dates remain in generated links.

## Cutover and release checks

Collection-based event commerce is retired. Old event links show a repost
instruction; organizers create new events using the current structure. There
is no automatic migration, legacy checkout, or legacy handoff reader. Ordinary
product collections and standard shipping are separate and remain supported.

Market and Merchant must be validated as one candidate before release. Check
creation, approval, association, shopping, payment and pickup across independent
sessions; then check real external signers, live relay delivery, devices and
physical handoff. Synthetic browser tests cannot establish those results.

A rollback requires maintainer review of the supported signed model and pending
deliveries. Do not clear persisted signed evidence or retry queues as recovery.
Do not silently re-enable the retired collection model. Release, deployment and
any production data changes require separate authorization.
