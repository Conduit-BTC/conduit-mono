# Event-Market Collection Compatibility Exception

## Header

- **Name:** event-market collection extension
- **Status:** active
- **Canonical target:** Open Markets formally defines NIP-52-backed and empty
  upcoming kind-`30405` collections with two-sided membership semantics.
- **Owner:** Commerce/Core maintainers
- **Started:** 2026-08-11
- **Next review:** 2026-09-15
- **Rollout control:** only the reviewed event-market builders and the explicit
  Merchant Events / Local pickup workflows may emit this shape; generic product
  and collection writers cannot enter the lane.
- **Activation state:** preview

## Ecosystem Divergence

The current Open Markets collection text defines product `a` references and
`shipping_option` references, but does not yet define a NIP-52 event coordinate,
an upcoming collection with zero products, or the distinction between a
merchant inclusion request and organizer-authored membership. NIP-52 already
defines the calendar record, and all emitted references use existing generic
addressable-event tags and kinds.

This divergence was checked against the public Gamma/Open Markets specification
and NIP-52 on 2026-08-11. Strictly refusing the extension prevents an organizer
from publishing a shareable event before merchant enrollment and prevents
clients from proving which products the organizer accepted. The upstream-ready
clarification is recorded in
`docs/knowledge/open-markets-event-commerce-proposal.md`; it is not presented as
accepted upstream behavior.

## Requirement Classification

Signature validity, exact author/coordinate binding, organizer authority,
merchant authorship, deletion evidence, pickup price, recipient identity,
private-message encryption, and payment amount remain hard gates. Calendar
display fields, bounded discovery, relay hints, and temporary source coverage
may degrade honestly. A merchant's product-to-collection reference is never
sufficient for official membership.

## Behavior Matrix

| Observed state                          | Reads                                                | Writes                                                        | User-visible state        |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- | ------------------------- |
| Current exact event graph               | Resolve exact signed frontiers                       | Explicit event workflow may emit the bounded extension        | Active or ended catalog   |
| Previously valid graph, lookup degraded | Retain cached signed evidence and mark stale/partial | No semantic replacement from uncertain evidence               | Degraded, retryable       |
| Absent within a complete bounded plan   | Report missing                                       | New organizer flow may create; updates require known identity | Missing / create action   |
| Partial or unavailable lookup           | Do not infer absence or deletion                     | Block consequential updates that require unresolved evidence  | Partial / unavailable     |
| Malformed or conflicting signed state   | Preserve for diagnostics, exclude from authority     | Block                                                         | Unsupported / conflicting |

## Bounds And Prohibitions

- Allowed public kinds are `31922`/`31923`, `30405`, `30406`, and participating
  merchant `30402` records. No Conduit-only event kind, registry, location tag,
  delegation tag, or destination predicate is emitted.
- Only the organizer authors the calendar, collection, and optional organizer
  pickup. A merchant authors its product and optional booth pickup.
- Reads use at most eight relay hints and bounded planner sources. Participation
  is capped at 64 product/pickup targets, four product revisions per target, and
  exact author-scoped NIP-09 queries.
- The extension writer is unavailable to unrelated generic collection routes.
  Widening kinds, actors, routes, or fanout requires a reviewed code and contract
  change.
- Signed public drafts and encrypted private wraps persist before relay I/O;
  zero/partial acknowledgements retry the exact immutable event.
- Private contact, addresses, notes, invoices, payment secrets, and handoff
  instructions are prohibited from public event records.

## Repair And Migration

The Events surface owns organizer graph repair and exact delivery retry. Product
Local pickup explains whether import, membership, pickup, or inbox evidence is
missing without asking the user to edit protocol tags. Once the upstream target
is normative, the same signed graph is read through the canonical path and the
compatibility label can be removed without rewriting user records.

## Rollout And Rollback

The lane is preview-only and reachable through the explicit event-market UI and
typed Core builders. Synthetic cross-client fixtures and the organizer,
merchant, and shopper browser flows are required before release. Production
activation requires maintainer review of this exception and the upstream status.

Rollback uses the prior application release or a reviewed change that removes
the Events / event-Local-pickup entrypoints while retaining cached signed
records and exact pending deliveries for recovery. There is no environment-only
toggle that can widen the writer or silently discard pending work.

## Privacy-Safe Measurement

No user, organizer, merchant, product, event, order, relay, or message identifier
is collected for this exception. Preview readiness is measured by the CI event
fixture matrix: its denominator is every event-market protocol, degradation,
privacy, checkout, and browser-flow case selected by the CND-203 test manifest;
the numerator is the passing cases for the reviewed commit. The upstream
specification state is reviewed manually on the date above. Runtime adoption is
not measured, and production activation may not add such measurement without a
separate privacy-reviewed allowlist.

## Removal Gate

Remove this exception only after the six clarifications in the upstream proposal
are accepted (or an equivalent normative contract exists), the canonical graph
passes the maintained cross-client fixtures, and two supported Conduit releases
can read the canonical records without this named writer boundary. Removal,
renewal, widening, or a review-date change requires an explicit maintainer PR.

## Regression Matrix

The maintained tests cover current and empty graphs, pending versus accepted
membership, organizer and merchant pickup, ended/deleted/stale/partial evidence,
malformed and conflicting references, strict price and author checks, zero and
partial relay acknowledgements, restart retry, private payload rejection, and
the artifact-safe organizer/merchant/shopper browser flows. The generic product
and collection paths remain negative controls for writer eligibility.

## Public References

- [NIP-52 calendar events](https://github.com/nostr-protocol/nips/blob/master/52.md)
- [NIP-19 shareable identifiers](https://github.com/nostr-protocol/nips/blob/master/19.md)
- [NIP-99 product listings](https://github.com/nostr-protocol/nips/blob/master/99.md)
- [Open Markets / Gamma specification](https://github.com/GammaMarkets/market-spec/blob/main/spec.md)
- `docs/knowledge/open-markets-event-commerce-proposal.md`
- `docs/specs/event-markets.md`
