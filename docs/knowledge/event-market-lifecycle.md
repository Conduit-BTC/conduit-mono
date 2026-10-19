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

Market closure is explicit and separate from occurrence expiry. A new
assignment purchase requires an unended concrete occurrence for both single-date
and recurring markets. A recurring market additionally requires an explicitly
selected occurrence with verified membership in the current schedule. Unresolved sibling dates do not invalidate a verified
selected occurrence. Removed or edited dates do not rewrite an existing order.

Both apps offer current/upcoming and history views. Calendar timezone and
concrete occurrence identity govern date presentation. Retained records and
partial reads support browsing, with incomplete coverage visible. They do not
establish current checkout authority or a complete archive of Nostr.

Merchant authoring starts with one date. Weekly and monthly repeat choices
expand to a finite preview of at most 32 concrete dates; custom dates use the
same editable rows. Monthly dates keep their day of the month and skip months
without that day. Timed repeats keep local wall-clock hours in the selected
timezone and reject nonexistent or ambiguous daylight-saving times.

All-day forms show an inclusive last day. A one-day event displays the same
start and end date. The shared form helpers convert that end to the following
calendar day for NIP-52's exclusive `end` tag, and convert signed ends back for
editing. An omitted signed end displays as a one-day event. Existing v1 saved
publishing plans retain exclusive dates; resume uses those stored values and
exact signed bytes. Never apply the form conversion again to a saved plan.

Private inbox configuration remains in Network settings. Creating a public
event does not require an inbox setup step. Participation actions still use
the shared NIP-17 delivery checks and offer a Network repair link only when
the action discovers an actionable local configuration problem.

## Orders and pickup

Before creating a new order or payment, checkout rechecks selected signed
market, grant, calendar, product and payee terms. A material change requires
buyer review. Created orders pin the accepted signed evidence; subsequent
organizer edits do not reinterpret their goods, date, assignment or payee.
Rescheduling may update the same calendar coordinate. Known current signed dates
govern unused allocations; merchants may explicitly accept or confirm payment
for the original order without rewriting it. Merchants coordinate fulfillment
changes and any refunds with buyers.

Explicit payment confirmation of a merchant-present assignment order may occur
past the original or rescheduled end. The order must predate its original
signed end and retain its exact identity and complete terms. Ordinary new
acceptance still requires an unended occurrence. Expired allocations do not
reserve merchant-present goods: confirmation uses the currently unallocated stock in the same
atomic acceptance transaction, preserving other active allocations, unreconciled organizer holds and credit
for that order's earlier stock decision. It reduces any remaining allocation
without making it negative. Retry after signing/delivery failure or reload uses
the saved acceptance and does not consume stock again. Stock shortages,
conflicting terms, known withdrawal/cancellation/deletion and delegated-writer
restrictions still require reconciliation; expiry alone is not a rejection.
This is manual settlement recording, not a new payment execution path.

Merchant-present assignment pickup is supported. Current organizer handout uses
the separate Conduit finite-stock delegation, exclusive writer and once-only
reconciliation extension. Required commerce settlement and the bound unique
claim authorize handout; checkout recovery reuses the shared router without a
new live merchant signature for each order. See the
[Event Market contract](../specs/event-markets.md#conduit-organizer-stock-handover-extension)
and [router acceptance checklist](event-market-router-acceptance.md).

Historical authenticated organizer handoff remains inspectable with its original
order-specific merchant release message and exact merchandise evidence. Its
acknowledgement grants no merchant payment or general lifecycle authority.
Private ready/revoke/acknowledgement operations retain exact encrypted bytes and
delivery evidence for retry across reload. Known revocations and conflicts
dominate retained positive evidence.

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
