# Merchant completion without tracking

A merchant may confirm that a paid order was fulfilled even when its tracking
number is unavailable. Unknown legacy fulfillment may instead be confirmed as a
past handoff. These are merchant statements. They are not carrier delivery,
organizer acknowledgement, or new payment evidence.

The existing named `kind:16` `status_update` grammar carries `status:complete`.
An optional JSON `completionBasis` extension records `delivered_without_tracking`
or `historical_handoff`; an optional `note` remains bounded to 2000 characters.
Other clients can still consume the ordinary completion status. This extension
is Conduit application metadata, not an upstream Open Markets requirement.

Manual completion does not alter the signed buyer order, its fulfillment
snapshot, shipment data, payment proof, or pickup receipt. A known shipping
snapshot allows only delivery without tracking. A historical handoff is available
only for unknown legacy fulfillment. Recognized Event Market pickup orders keep
their existing authorization and exact organizer acknowledgement requirements.
Digital and tracked shipment completion retain their existing paths.

The action requires merchant-confirmed payment and a current merchant signer.
Buyer payment reports alone do not satisfy that gate. It rechecks retained
account-local order history before signing. The selected participants, order, and
delivery mode are frozen when confirmation opens; a changed account invalidates
the action. It does not depend on a past event still being discoverable or active.

Before transport, the shared private delivery owner commits the encrypted local
completion and exact signed delivery bytes in one IndexedDB transaction. A hashed,
account-scoped order key rejects duplicate completions. Storage failure aborts
publication; transport failure leaves the completion recorded and the saved
message retryable. Explicit retry reuses signed bytes and their saved targets.
Completion does not wait for relay ACK or a relay self-copy to become visible
locally. Self-only order history remains explicit and does not notify the buyer.
A relay ACK proves relay acceptance, not buyer receipt or settlement.

No new account-key custody, encryption version, delivery service, or diagnostic
payload is introduced. NIP-44 v2 remains the public implementation; existing v3
planning and capability gates are unchanged.
