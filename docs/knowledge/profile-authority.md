# Selected profile authority

Profile display enrichment and permission to act use different projections.
Use `ProfileBatchResult.profileContexts` or `fetchProfileContext` for a
consequential profile read. React callers receive `useProfile.profileContext`
or `useProfiles.profileContexts`; `.data` remains a richer display projection.
Raw event content belongs in the selected context, never in query diagnostics.

`protocol/profile-cache.ts` owns selection across durable rows and signed
frontiers retained after failed writes. All selection uses the existing NIP-01
ordering and atomic durable retention. `loadSelectedProfileContext` reads that
same selection without a network refresh. A session-only frontier cannot
survive restart if persistence never succeeds.

- Publishing builds partial edits and the replacement timestamp from one
  selected context. It preserves unknown raw fields. Unconfirmed reads cannot
  authorize overwriting profile state; a fully observed malformed frontier
  may be repaired using its readable projection.
- `getProfilePaymentAddress` extracts a valid destination from the exact
  selected event. `hasFreshProfilePaymentAddress` additionally requires a
  current observation. Partial relay coverage can still contain positive
  signed evidence.
- Retained removal, malformed content, or a conflicting destination can veto
  a saved-address retry. Retained evidence cannot authorize replacement.
  Genuine lack of observation is separate from a known contradiction.
- Merchant invoice creation and automated payment verification consult the
  shared owner at the action point. Profile setup, cart preflight, checkout,
  and profile-edit forms use the selected context rather than display history.
- Query-cache publication updates keep context and projection together.
  Failed refetches preserve retained evidence without claiming fresh authority.

Do not independently read `db.profiles` or reconstruct raw profile authority
outside this owner. Durable storage is an adapter, not a second authority.
Saved order destinations and already bound invoices remain separate payment
contracts; profile selection does not replace their claim or invoice checks.

Regression coverage includes refresh plus failed persistence plus publication,
merchant invoice creation through the default adapter, retained-invoice retry,
newer correction, and React query-cache transitions.
