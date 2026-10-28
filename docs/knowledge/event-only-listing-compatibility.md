# Explicit event-only listings

Open Markets `visibility=hidden` keeps a publicly signed listing out of normal
market discovery; it does not itself authorize Event purchasing. Conduit pairs
that standard tag with its opt-in extension `conduit_event_only=1` for physical
products. It is not an upstream Open Markets tag or a privacy guarantee.

The extension is a listing eligibility signal only. New Event purchases still
require the exact current signed occurrence assignment, organizer admission,
date and product evidence, stock and handout authority. Legacy hidden products,
ordinary assigned products and frozen orders keep their existing meaning.

Conduit emits one exact marker paired with one `visibility=hidden` and a
physical product type. Unknown, duplicate or contradictory marker terms are
unavailable rather than interpreted as ordinary-public or Event authority.
JSON compatibility content cannot opt a listing in. Other clients can honor
standard hidden visibility without implementing the Conduit extension.

References: [Open Markets working specification](https://github.com/OpenMarketsFoundation/specification),
[NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md), and
[Event Markets contract](../specs/event-markets.md).
