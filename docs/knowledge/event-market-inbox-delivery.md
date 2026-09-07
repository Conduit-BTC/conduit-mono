# Event pickup inbox delivery

Organizer pickup receipts, revocations, and acknowledgements use the shared
NIP-17 private-message transport. Delivery destinations must come from the
recipient's signed kind-10050 declaration, not general kind-10002 relay
preferences or arbitrary relay fallbacks.

The declaration resolver keeps the strongest known signed replaceable event.
A partial or unavailable discovery read does not revoke a previously observed
usable declaration. Its `stale` field describes freshness or coverage; it is
not a signed withdrawal and must not independently block event handoff sends
or retries. The ordinary DM transport follows the same rule.

Known newer signed-empty or malformed declarations still block delivery.
Locally staged declarations awaiting distribution are also not write authority.
Discovery failure without any usable signed evidence remains retryable, not a
claim that the recipient has no inbox anywhere.

Exact retry records preserve the already signed recipient and sender gift
wraps. Retries resolve the current declared destinations, retain per-target
acknowledgements, and avoid resending to already acknowledged targets. A
recipient relay acknowledgement does not prove that the organizer read the
receipt, physically handed over the product, or acknowledged completion.
Sender self-copy failure remains distinct from recipient delivery.

This behavior does not change payment confirmation, merchant release consent,
receipt contents, known revocation handling, or NIP-44/NIP-59 encryption.

References: [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md),
[NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md), and
[decentralized network product posture](decentralized-network-product-posture.md).
