# Public feed read scope

Public product feeds and Event Market discovery use the shared read owners with
`readScope: "public_feed"`. The scope selects `config.commerceDiscoveryRelayUrls`
(Conduit and Ditto in the managed configuration), intersected with the configured
commerce app-read grants. It does not use author NIP-65 lists, portable reference
hints, historical delivery sources, user-selected relays, or expanded fallback
registries. Relay-list discovery is not required in this lane.

The scope is a purpose, not a caller-selected URL list or a global connection cap.
Final account exclusions, app-layer disablement, cancellation, verification and
retention still apply. An empty admitted set remains empty. Failure, refresh,
pagination and retry never expand the configured destination set.

## Owners and supporting reads

- Marketplace browse and progressive discovery always select feed scope.
- Public storefront, product detail, related products, seller suggestions and
  Event Market display callers explicitly select it on shared exact readers.
- Family, deletion, roster, calendar, occurrence, assignment, authorization,
  profile and follow-list support inherit the scope.
- Ranked product search uses the first configured feed peer for one relevance
  ordering. Exact hydration and deletion checks use the configured set. Lack of
  search support or an outage does not select another relay registry.
- Network query/continuation identities include scope and configured policy
  identity. Retained signed evidence remains shared across scopes: previously
  observed newer revisions, tombstones and revocations are never hidden because
  their original relay is outside the current feed set.

## Display and action authority

Completion describes the configured feed observation; it is not global absence
or permission to purchase or mutate. Failed or denied configured reads remain
partial/unavailable, and retained-only data remains stale.

Feed transport opts into coverage of every requested configured peer. A peer
suppressed by health or account policy contributes an unsuccessful coverage row,
with `attempted: false`; actual attempted/admitted destination sets remain factual.
This requires no additional connection or retry and leaves ordinary read coverage
unchanged.

Event feed results carry provenance and are nonactionable. Write-readiness,
first-grant and pickup snapshot gates reject them, including mixed-provenance
inputs. Product pages render a noncommittable Event preview and perform their
existing fresh authority reads when adding an item.

Feed profiles cannot be requested as payment/profile-edit evidence. Their display
contexts cannot become freshly observed payment authority. Ordinary payment and
profile-edit reads retain their existing routing and validation.

Generic exact reader calls with no scope retain their existing behavior. Checkout,
organizer actions, signed order pickup evidence, publication, private messaging,
recovery and account relay preferences are outside this feed policy. The browsing
cart HUD initially uses saved cart state. Explicit expansion starts a separate
preparation lifecycle for fresh stock, wallet and LNURL checks and the existing
Zap Out control. Collapsing or changing route/account revokes queued preparation;
cart and checkout retain their existing read lifecycle.

Own-account identity reads retain account routing. Merchant owner-management
discovery uses `discoverOwnedEventMarkets`, requiring matching owner, account and
authenticated identities; its query and continuation identities are distinct from
public discovery. Finding an owned market must not depend on publication to the
public feed peers.

## Verification boundary

Offline tests exercise shared read owners with signed fixtures, 100+ advertised
destinations, retained negative evidence, outages and unchanged authority controls.
The disposable browser harness records actual attempted WebSocket destinations
and blocks external HTTP. The exact Vite loopback socket is counted separately
from relay traffic. It exercises shared APIs/hooks rather than claiming
complete production-route or live-relay/payment qualification.

CI runs both public-feed browser files in a separate job. The build gate requires
both that job and the existing payment/recovery tests to succeed.
