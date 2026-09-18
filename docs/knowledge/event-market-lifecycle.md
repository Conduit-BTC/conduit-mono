# Event schedule, acceptance, and history

NIP-52 describes the advertised schedule. An explicit event-market acceptance
declaration determines whether new event orders are allowed. Neither passing a
scheduled end nor closing new orders deletes the event or cancels existing
orders.

## Signed representation and scope

Only the organizer-authored event collection (`30405`) carries:

```text
["conduit_event_market", "1", "open"]
["conduit_event_market", "1", "closed"]
```

Exactly one declaration is permitted. This namespaced, versioned declaration is
a Conduit extension to the existing event-market compatibility lane. It is not
defined by current NIP-52 or Open Markets. No new event kind, registry, service,
account key, or private order information is introduced. Generic collections do
not acquire event authority from this tag.

- New event creation declares `open` and explains that closure is manual.
- `open` survives the advertised end, including all-day events.
- `closed` blocks new event orders and pickup enrollment even before the end.
- Missing metadata preserves legacy schedule-based behavior. Only an explicit
  organizer action opts an existing event into manual closure.
- Duplicate, malformed, or unsupported declarations cannot authorize checkout.
- A newer untagged revision cannot silently downgrade a lifecycle-aware event
  when the previous signed declaration is known. The organizer must repair it
  with an explicit supported declaration.

The full collection coordinate identifies the event catalog. Close/reopen
updates only that collection and preserves its calendar, pickup, products and
public metadata. Calendar edits and product acceptance/removal preserve the
acceptance declaration. Signed revision ordering remains NIP-01 ordering.

The resolver's existing `ended` state includes explicit closure and legacy
scheduled expiry. The collection declaration distinguishes them for display.
Relay quality remains separate: cached open evidence is not current checkout
authorization, and an unavailable read does not erase a known signed closure.

## Organizer publication

The organizer workflow resolves the current collection and reconciles retained
signed delivery evidence before preparing a change. It uses the existing
external signer and signed-event outbox. Persist before relay I/O and retry the
identical signed revision after failed delivery. Display pending and partial
acknowledgements honestly. One relay ACK does not prove every shopper observed
the new state.

Concurrent devices remain subject to addressable-event replacement. Refresh
before signing and retain stronger observed revisions; do not claim global
locking or instantaneous network-wide closure.

## Browsing and history

Market and Merchant offer Open & upcoming and History views. History includes
explicitly closed events and legacy events past their scheduled end. Date
filters remain schedule-based, so an explicitly open event may appear under
Past events without becoming closed. Older open events sort after events whose
scheduled time has not passed and never continue to claim Happening now.

Retained signed calendar, collection and organizer pickup frontiers survive the
transient participation-cache budget. Lifecycle declarations and known deletion
evidence survive it as well. This keeps known event pages discoverable across
refresh/restart and prevents ordinary cache churn from erasing their records.
Discovery remains scoped and bounded; this is not a complete archive of Nostr.
Historical product availability may be incomplete and is labeled accordingly.
Cached history never grants purchase authority. Explicit NIP-09 deletion remains
separate from closure and continues to dominate affected records.

## Existing orders

New submission and fresh payment attempts still require current acceptance.
Creating a local order record or adding an item to a cart does not reserve the
right to buy after closure.

Existing merchant-issued invoice authority, settlement inspection, proof
recovery and ambiguous-payment reconciliation keep their current safeguards.
Closure does not authorize a replacement invoice, duplicate charge, different
wallet, or weaker cancellation checks.

Ready-receipt continuation across a lifecycle-only collection revision requires
both original and current signed collection evidence. Their author, coordinate,
content and all non-lifecycle tags must agree, and the current revision must be
newer. The original order/receipt snapshot remains unchanged. Missing original
evidence blocks this exception. Current membership, merchant consent, exact
pickup terms, handler, merchandise, deletion and private revocation checks still
apply. A lifecycle change must not conceal another authority change.

## Validation and release

The regression suite must cover overtime open events, early closure, legacy
opt-in, ordinary edits preserving state, stale/out-of-order reads, malformed
metadata, exact publication retry, history retention, and qualified order
continuation. Browser fixtures exercise organizer, merchant and shopper flows
with synthetic external signers and controlled relays. They do not establish
real-signer delivery or physical pickup correctness.

Before production activation, maintainers must review the extension and deploy
compatible Market and Merchant readers before relying on lifecycle writers.
Validate close/reopen across real independent sessions and configured relays,
including refresh/restart and pending existing orders. Check both handoff modes.
No data migration or mass republication of legacy events is required.

Older clients may ignore this declaration, omit it during edits, or still treat
the scheduled end as a cutoff. A new client with no retained history cannot
infer a declaration that another client removed. Do not promise network-wide
cancellation or automatic interoperability. The merchant remains responsible
for accepting and fulfilling orders.

If the writer needs rollback, disable or revert its UI entrypoints while keeping
lifecycle-aware readers, retained declarations, deletion evidence and pending
signed deliveries. Do not roll back to a reader that treats a known closed
collection as legacy-open. Do not clear historical records as recovery.

No runtime telemetry is added. Readiness is measured using the deterministic
regression matrix and maintainer-owned validation. Commerce/Core maintainers
own this extension under the existing compatibility exception. Recheck upstream
status by 2026-10-16. Replace the tag only through a reviewed migration after an
upstream equivalent exists and supported readers can preserve existing signed
authority; do not silently reinterpret or drop existing declarations.

## Sources

- [NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md)
- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)
- [Open Markets working specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md)
- [Event-market compatibility exception](./event-market-collection-extension.md)
