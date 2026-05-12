# Identity Hydration Contract

Conduit identity rendering must use the shared profile hydration path in
`@conduit/core`. App routes and leaf components should not create page-local
profile caches, ad hoc profile query keys, or merge logic that can disagree with
other surfaces.

## Required APIs

- Use `useProfiles(pubkeys, options)` for batched merchant, buyer, or user
  decoration.
- Use `useProfile(pubkey, options)` for one-off profile decoration.
- Use source relay hints when the parent commerce read exposes them, for example
  product source relays from `useProgressiveProducts`.

## Cache And Merge Rules

- A bare `{ pubkey }` result is only a temporary unresolved render state.
- Do not persist bare profile misses as successful profile cache entries.
- Richer profile data wins over bare data.
- Empty incoming fields must not erase an already loaded name, image, or other
  useful profile field.
- New valid kind-0 profile fields may enrich or update cached profile data.

## UI Rules

- Primary identity labels should show a loaded profile name when available.
- Commerce list fallbacks should show a shimmering `Store npub...` label while
  hydration continues.
- Detail surfaces may show a pubkey or npub as explicit metadata, but not as the
  primary merchant or buyer name when a profile lookup is still unresolved.

## Scope

This contract applies to Market merchant identity surfaces and Merchant buyer
identity surfaces such as orders and messages. Future profile, trust, social, or
review features should build on these shared hooks instead of opening new relay
profile reads inside page components.
