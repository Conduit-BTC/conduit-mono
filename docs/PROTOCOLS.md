# Open protocols in Conduit

Conduit Shop (Market) and Conduit Sell (Merchant Portal) are open-source Nostr
clients for commerce. This page describes behavior in this repository, not a
claim that every relay, signer, wallet, or other client supports every feature.
"Both" means the shared implementation is used by both apps; some actions
still require a connected account, a compatible counterparty, or a wallet.

The [Nostr Implementation Possibilities](https://github.com/nostr-protocol/nips)
are the authority for NIPs. Product listings use [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md)
plus the [Open Markets working specification](https://github.com/OpenMarketsFoundation/specification)
for `kind:30402` commerce events. The working specification is distinct from
an accepted NIP and evolved from the earlier GammaMarkets `market-spec` work.

## Identity, discovery, and relays

| Standard                                                                                                                                  | Conduit use                                                    | App and direction                                               | Implementation                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md)                                                                        | Signed events, profiles, and replaceable-event ordering        | Both, read and publish                                          | [`kinds.ts`](../packages/core/src/protocol/kinds.ts), [`profile-search.ts`](../packages/core/src/protocol/profile-search.ts) |
| [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md)                                                                        | Contact lists and follow graph                                 | Both, read and publish                                          | [`follows.ts`](../packages/core/src/protocol/follows.ts)                                                                     |
| [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md)                                                                        | Resolve and verify optional profile identifiers                | Both, read; identifier publishing is hosted separately          | [`nip05.ts`](../packages/core/src/protocol/nip05.ts)                                                                         |
| [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) and [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) | External browser and remote account signers                    | Both, signer connection and signing                             | [`remote-signer.ts`](../packages/core/src/protocol/remote-signer.ts)                                                         |
| [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md)                                                                        | Relay information as optional capability and display evidence  | Both, read                                                      | [`useAccountNetworkSettings.ts`](../packages/core/src/hooks/useAccountNetworkSettings.ts)                                    |
| [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md)                                                                        | Human-readable keys, profiles, and event references            | Both, encode and decode                                         | [`product-reference.ts`](../packages/core/src/protocol/product-reference.ts)                                                 |
| [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md)                                                                        | Sign relay AUTH challenges for protected reads where required  | Both, conditional                                               | [`protected-read-authorization.ts`](../packages/core/src/protocol/protected-read-authorization.ts)                           |
| [NIP-50](https://github.com/nostr-protocol/nips/blob/master/50.md)                                                                        | Bounded relay search for public account profiles               | Shop, read-only suggestions                                     | [`profile-search.ts`](../packages/core/src/protocol/profile-search.ts)                                                       |
| [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md)                                                                        | Signed general read/write relay preferences                    | Both, read and publish                                          | [`relay-list.ts`](../packages/core/src/protocol/relay-list.ts)                                                               |
| [NIP-89](https://github.com/nostr-protocol/nips/blob/master/89.md)                                                                        | App handler discovery metadata and outbound client attribution | Both, publish/attach; descriptor publishing is an operator step | [`nip89.ts`](../packages/core/src/protocol/nip89.ts)                                                                         |

NIP-42 authenticates a relay session; it is not Conduit account login. Account
keys remain in external signers. A guest order may use a temporary,
order-scoped browser key, and NIP-46 may use an encrypted browser-local client
connection key; neither is durable account-key custody. NIP-11 documents and
relay hints are useful evidence, not guarantees of a relay's behavior.

## Commerce, private messages, and payments

| Standard                                                                                                                                                                                                   | Conduit use                                                             | App and direction                                     | Implementation                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| [NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)                                                                                                                                         | Signed deletion requests and deletion-aware reads                       | Both, read; Sell publishes for merchant-owned content | [`products.ts`](../packages/core/src/protocol/products.ts)           |
| [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md), [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md), [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) | Private messages and order traffic using encrypted seals and gift wraps | Both, read and publish                                | [`commerce.ts`](../packages/core/src/protocol/commerce.ts)           |
| [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md)                                                                                                                                         | Optional Nostr Wallet Connect invoice and payment actions               | Both, wallet-dependent                                | [`nwc.ts`](../packages/core/src/protocol/nwc.ts)                     |
| [NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md)                                                                                                                                         | Calendar events associated with event-market listings                   | Both, read; Sell authors event data                   | [`kinds.ts`](../packages/core/src/protocol/kinds.ts)                 |
| [NIP-56](https://github.com/nostr-protocol/nips/blob/master/56.md)                                                                                                                                         | Public report events as limited, advisory trust evidence                | Shop, read only                                       | [`shopper-trust.ts`](../packages/core/src/protocol/shopper-trust.ts) |
| [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md)                                                                                                                                         | Zap requests and receipt verification on supported payment paths        | Both, conditional                                     | [`nwc.ts`](../packages/core/src/protocol/nwc.ts)                     |
| [NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md) and [Open Markets](https://github.com/OpenMarketsFoundation/specification)                                                              | Signed product listings (`kind:30402`) and commerce extensions          | Shop reads; Sell reads and publishes                  | [`products.ts`](../packages/core/src/protocol/products.ts)           |

NIP-44 version 2 is the current public encryption version used for NIP-17;
version 3 is a planning track, not advertised as implemented. NIP-17 private
messages use recipient inbox relay declarations (`kind:10050`) where available.
NIP-47 and NIP-57 apply only to compatible wallet and payment paths; Conduit
also supports other non-custodial Lightning paths. Open Markets is a working
specification, so event-market features may have narrower support across
other clients than ordinary NIP-99 product listings.

## Other interoperability and limits

- [Blossom](https://github.com/hzrd149/blossom) is used for product media.
  BUD-03 signed media-server preferences (`kind:10063`) are read and published
  by both apps. Blossom is a separate protocol, not a NIP. See
  [`product-image-upload.ts`](../packages/core/src/protocol/product-image-upload.ts)
  and [`media-server-preferences.ts`](../packages/core/src/protocol/media-server-preferences.ts).
- Legacy [NIP-04](https://github.com/nostr-protocol/nips/blob/master/04.md)
  messages have a narrow read-only recovery path. Conduit does not send new
  NIP-04 messages.
- NIP-50 currently supports Shop's public account and seller suggestions, not
  product search. Suggestions are display-only; opening one uses the normal
  signed profile read. NIP-96 is only mentioned as an external host capability,
  not implemented as a client upload path.
- `kind:30078` is named as NIP-78 in the shared kinds table, but no app feature
  currently uses it. The presence of a constant is not implementation.
- NIP-18 is mentioned to keep generic reposts out of a legacy order parser.
  NIP-25 reaction counts appear in an unused social-hydration scaffold.
  Neither is advertised as a shopper or merchant feature. NIP-33's addressable
  event rules now live in NIP-01.
- NIP-89 `kind:31990` handler metadata identifies event types an app handles.
  Its `k` tags are not a complete list of the NIPs used by the app. The About
  pages show handler metadata separately from this inventory.

This inventory describes the current public client code. It does not certify
production deployment, relay availability, wallet compatibility, or support by
other Nostr clients. For implementation rules and source precedence, see
[`docs/knowledge/external-nostr-references.md`](knowledge/external-nostr-references.md).
