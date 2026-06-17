# Client Hydration And Relay Hints

This is a compact implementation note for CND-133-style work. It summarizes the Nostr surfaces that matter for Conduit client hydration without restating full NIPs.

## Relevant NIPs

| Surface               | Why it matters                                                                    |
| --------------------- | --------------------------------------------------------------------------------- |
| NIP-01                | Event shape, filters, tags, replaceable kinds, and kind `0` profile metadata      |
| NIP-09                | Kind `5` deletion events can remove product listings or shipping options          |
| NIP-19                | `nprofile`, `nevent`, and `naddr` can carry relay hints for targeted reads        |
| NIP-57                | Zap requests/receipts depend on profile/payment metadata in trust and checkout UX |
| NIP-65                | Kind `10002` relay lists provide author read/write preferences for planner inputs |
| NIP-99 + GammaMarkets | Kind `30402` product listings and de-commerce interop                             |
| NIP-17/NIP-44         | Order/message surfaces hydrate profile context around private conversations       |

## Conduit Rules

- Treat source relays as hints, not authority.
- Preserve full product coordinates: `30402:<merchant_pubkey>:<d_tag>`.
- Keep route-aware read and publish planning in `@conduit/core`.
- Keep page-level hydration policy in the app layer when it affects visible UX.
- Do not block product rendering on profile, social, zap, or deletion metadata unless the product itself is not yet known.
- Do not add relay planner or default relay changes inside client hydration PRs unless the accepted ticket explicitly asks for that.

## Source Relay Hints

Conduit already attaches source relay URLs to fetched NDK events and stores them on cached products/profiles.

Use these hints to improve related reads:

- product source relays can hint merchant profile hydration
- profile source relays can hint later profile refreshes
- NIP-19 relay hints can hint explicit detail lookups
- NIP-65 relay lists remain the planner-owned source for author read/write preferences

Cap and normalize hint lists before passing them into fetches. Unbounded hint fanout causes the same UX problem as broad relay fanout.

## Page Ownership

Market browse:

- owns visible merchant profile hydration for product cards and store filters
- hydrates visible merchants before background merchants
- should keep product grid dimensions stable while names and avatars hydrate

Storefront:

- can force a bounded merchant profile retry because the user explicitly opened the store
- should show products from cache/progressive reads while profile metadata settles

Product detail:

- can use product source relays as profile hints for the merchant block
- should stay in loading/not-found only for the product lookup, not for merchant profile hydration

Orders and messages:

- should batch merchant/buyer profile lookups
- should avoid per-row retry loops
- should show final fallback identity after bounded lookup settles empty

## UX States

Use three identity states:

- `resolved`: profile content was found
- `pending`: lookup is still active; skeleton/pending styling is appropriate
- `fallback`: bounded lookup settled empty; show `Store npub...` or equivalent without pending animation

This prevents premature fallback while also avoiding infinite loading for profiles that do not resolve.
