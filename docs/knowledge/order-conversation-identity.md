# Order conversation identity

An order ID identifies the signed commerce reference within a buyer/merchant
conversation. It does not globally identify a conversation across independent
participants. Market and Merchant derive a local identity from the tuple
`[orderId, buyerPubkey, merchantPubkey]` before calculating previews, status,
counts, filters, selection, or action targets.

`ConversationSummary.id` is this opaque local identity. Display and publish
`orderId`; never put the composite identity into a signed order tag or payload.
Escape this identity when using it in a CSS selector and capture it separately
from the wire order ID when checking completion of an asynchronous UI action.
The wire format, signed messages, encrypted inbox records and existing database
keys are unchanged. Cached and live projections use the same grouping helper,
so this correction requires no persisted-data migration.

Authenticated endpoints and message type establish direction. An original order
anchors its direction. Conflicting partial history for the same pair remains
hidden until direction can be established; separate counterparties no longer
invalidate each other's partial histories. Plain replies do not establish roles.
When both directions use the same order ID, an unqualified reply remains in the
raw encrypted inbox but is not guessed into either order conversation. Network
coverage and missing-order status retain their existing meanings.

Order links retain `order` and add `counterparty` when the participant is known.
An old order-only link selects a conversation only when it is unique in the full
observed list. Filtering the visible queue cannot make an ambiguous old link
select an unrelated participant. A qualified target hidden by a filter stays
unselected rather than falling back to another row. Users can select the intended order to obtain
a qualified link. This is a local data-integrity boundary, not a claim that
unobserved conversations do not exist elsewhere on the network.

Market joins local lifecycle/payment evidence only to matching participants.
Merchant settlement witnesses and repeated-invoice detection likewise distinguish
participant pairs before attaching payment evidence. Existing cryptographic,
wallet, signer, delivery and settlement verification remains required.

Regression coverage includes real NIP-44 v2/NIP-59 wraps through the protected
inbox, encrypted storage reload, both app selectors, and recipient-specific
replies against a local relay. This does not qualify external signers, public
relay delivery or funded payment behavior. NIP-44 v3 readiness remains a separate
capability-gated effort; no capability negotiation changes here.

Numeric order notes remain ordinary encrypted direct messages as well as order
transcript entries. Their association is a derived view anchored by an
authenticated original order or the buyer's exact saved order binding. A note
may name the raw order in an `order` tag (or the historical exact `subject`),
and a reply may inherit that context through its authenticated `e` parent.
Association follows the exact participant pair, never the latest room topic or
another message merely sharing an order ID. Conflicting references, ambiguous
buyer/merchant direction, groups, files, advisory companions and cyclic ancestry
do not produce order notes. Missing parents can be resolved when history arrives.
This association grants no payment, acceptance, inventory or fulfillment authority.

Both direct-message composers make order context visible and carry it into the
reply. Same-account signer recovery retries the prepared rumor with its original
references and ID; it does not rebuild a reply against a later message. The
retained encrypted inbox reconstructs the association after reload. Decode rule
v9 reads explicit order references while preserving older subject-only histories.
