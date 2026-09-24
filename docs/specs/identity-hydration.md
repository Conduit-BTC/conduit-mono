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

## Identity presentation

- When a validated profile name is available, identity presentation uses it
  without replacing signed pubkey authority.
- While hydration is unresolved, a fallback must not imply that a profile name
  was confirmed or that lookup has completed. After bounded attempts settle,
  loading presentation ends even if no name was found.
- A pubkey or npub may be available as identity metadata, but an unresolved
  profile must not be mistaken for a verified merchant or buyer name.

## Scope

This contract applies to Market merchant identity surfaces and Merchant buyer
identity surfaces such as orders and messages. Profile, trust, social, or review
features should build on these shared hooks instead of opening new relay profile
reads inside page components.
