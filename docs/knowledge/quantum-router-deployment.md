# Quantum Router deployment capability

The code-owned mainnet Pages preview and production profiles enable Quantum
Router through the shared `isQuantumRouterEnabled()` capability. Market checkout,
saved buyer continuation, Merchant Orders and Merchant Home use the same
resolved setting. A production deployment of the merged implementation does not
need a localhost host or local rehearsal flags. Signet staging remains disabled:
the current settled Spark plan supports mainnet and regtest, not Signet.

## Scope and prerequisites

Hosted activation is not a promise that every historical checkout or product
shape is routable. Current admission covers one merchant's SAT-priced simple
products with supported digital, fixed-shipping or merchant-operated pickup
fulfillment. Fiat-priced products, variations, organizer handoff and unresolved
shipping continue to use their existing paths. Existing supported listings do
not need republication merely to activate routing; supplier allocations require
an explicitly published signed product revision.

New routed checkout still requires exact signed commerce and recipient
authority, reachable recipient payment metadata, a valid declared Merchant
inbox, and relay acknowledgement of the private recovery package before
disclosing funding. Failure of these prerequisites cannot downgrade an admitted
router checkout into another buyer payment.

Buyer foreground routing does not require an online Merchant client. After
abandonment, eligible recovery runs when the Merchant opens its client after
the frozen handoff. This capability does not add an always-on executor.
Funding is not commerce settlement, and commerce settlement is separate from
the platform fee. Missing receiving-origin evidence and uncertain attempts
retain an attention state without replay.

## Local exceptions remain separate

Local rehearsal fee destinations, unquoted SDK receive compatibility,
accelerated timing and the experimental Coinos attribution adapter still
require the local deployment profile, development mode and their explicit
loopback opt-ins. A public-profile bundle cannot acquire those exceptions from
dashboard flags or an imported plan. Public dispatch requires the canonical
mainnet production fee recipient; historical local-canary records remain
readable but are not silently rewritten or dispatched.

Public builds retain the normal fifteen-minute requested funding lifetime and
forty-five-minute handoff. Saved deadlines stay immutable. See
[invoice lifetimes](checkout-spark-invoice-lifetimes.md) and
[recipient verification compatibility](checkout-spark-recipient-verification-compat.md)
for the distinct expiry, renewal and attribution boundaries.

## Verification

Build manifests expose `quantumRouterEnabled` alongside the resolved profile,
network and configuration digest. Managed-profile parsing, artifact verification
and preview CI assert that value for every app. Pure capability tests cover
hosted admission without local flags, production-host/profile mismatches,
unsupported networks and isolation of local exceptions. App tests retain
current-session guards and public dispatch policy checks.

Automated capability and synthetic payment fixtures do not establish live
provider settlement, signer/device behavior or recovery liveness. Those remain
maintainer-owned funded validation before release sign-off.
