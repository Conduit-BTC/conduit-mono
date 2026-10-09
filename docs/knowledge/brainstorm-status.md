# Brainstorm badge enhancement

Market adds a subtle static purple glow to its existing NIP-05 shield only
when the NIP-05 address matches the account and Brainstorm positively verifies
that same account. The existing tooltip and screen-reader description explain
the two signals separately. Brainstorm does not validate the NIP-05 mapping.

There is no separate Brainstorm badge or score. Negative or missing Brainstorm
verification, pending requests, malformed data, and unavailable responses add
no visible treatment. The provider's flagged verdict is deliberately ignored.
Accounts without a valid NIP-05 badge gain no new indicator. Existing NIP-05
verification and its failure handling remain independent. This advisory
signal does not gate checkout, exclude products, or change catalog ordering.

## Provider contract

The anonymous `POST https://api.brainstorm.world/user/trustSignals` request
contains only `{"pubkeys":["<viewed hex pubkey>"]}`. Market omits credentials
and referrers and only enables the lookup after NIP-05 verification succeeds.
The response has `code: 200` and `data.results`, containing one matching
identity with a boolean `verified` verdict. Market validates that identity and
verdict. It does not infer thresholds from a score or use report counts.

Requests are cancellable and bounded to 30 seconds; the advisory result is
cached for one hour. There is no documented HTTP 202 retry contract for
`trustSignals`; failed lookups leave the ordinary NIP-05 badge unchanged.

## Public references

Checked on 2026-10-07:

- [Brainstorm's categorical API](https://github.com/NosFabrica/brainstorm_server/blob/dc8c4f34bd617bdf226956173a36ecc5a07399fc/app/routers/user/router.py)
- [TrustSignal response schema](https://github.com/NosFabrica/brainstorm_server/blob/dc8c4f34bd617bdf226956173a36ecc5a07399fc/app/schemas/request_response_schemas.py)
- [ORE raw-count boundary](https://github.com/NosFabrica/brainstorm_server/blob/dc8c4f34bd617bdf226956173a36ecc5a07399fc/app/routers/open_ranking/stats.py)
- [NIP-05 address mapping](https://github.com/nostr-protocol/nips/blob/master/05.md)

An anonymous live request to the provider's public house account returned a
matching identity and boolean verdicts. The API also allowed a browser CORS
preflight from `https://shop.conduit.market`. These checks establish API
availability and shape, not the accuracy of its network classifications.
