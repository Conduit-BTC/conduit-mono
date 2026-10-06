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
products with supported digital or fixed-shipping fulfillment.
Historical event-pickup plans remain recoverable, but retired pickup snapshots
are not admitted as new checkouts after the Event Market model cutover.
Fiat-priced products, variations, current Event Market pickup and unresolved
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
dashboard flags or an imported plan. Legacy Lightning dispatch requires the
canonical mainnet production fee recipient; native final collection additionally
requires its frozen Spark destination to remain explicitly approved.
Historical local-canary records remain
readable but are not silently rewritten or dispatched.

## Native final fee collection

Managed mainnet preview and production builds use the single public static
treasury receive address in `deploy/pages-profiles.json` under
`quantumRouterTreasury.mainnetAddress`. The shared build contract compiles the
same policy into both Market and Merchant; dashboard treasury overrides cannot
redirect either app. Signet staging compiles empty treasury settings.

Local builds retain explicit `VITE_CONDUIT_SPARK_TREASURY_ADDRESS` (mainnet) or
`VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS` (isolated regtest), including Vite
dotenv configuration. The managed destination is not an implicit local default.
Never put treasury signing material in a client build.
An explicitly absent destination retains the Lightning fee rail for new plans.
With a valid configured address, new plans freeze a native final allocation;
invalid, invoice-bearing or wrong-network addresses fail before wallet creation.
This configuration does not rewrite historical funded orders.

A receiving Spark address is reusable for its wallet identity and network.
The adapter derives a separate canonical sender-restricted request for each
checkout, freezes it before funding and saves the exact final amount after
commerce settlement. One native transfer collects the settled Conduit
allocation plus unused authorized commerce reserves. This is not a wallet
balance sweep, a Lightning invoice, or a treasury signing capability.

During managed rotation, retain approved old destinations in
`quantumRouterTreasury.retiredMainnetAddresses` in the same shared configuration.
Local builds use the comma-separated
`VITE_CONDUIT_SPARK_RETIRED_TREASURY_ADDRESSES` for explicit prior approvals.
Recovery checks the saved address against that explicit set; it does not
redirect existing plans. Native final collection requires fresh exact history,
zero provider fee and claimed-transfer evidence. Uncertain transfers remain
query-only and cannot be retried by removing a pause flag.

The fixed funding total remains the buyer's authorized maximum.
The Conduit fee estimate is best-effort, while recorded payment data retains
the actual native collection and unused reserves separately. Any proposed Terms wording
requires a maintainer-owned new legal release with an effective date; this
feature does not modify released archived prose. See the [native final
collection note](checkout-spark-native-treasury.md) for accounting, safety
boundaries and proposed legal wording.

The isolated router browser lane uses the application `mock` network, mapped to
regtest by its hermetic Spark adapter. This lane additionally requires validated
loopback relay isolation and both explicit rehearsal flags. Ordinary mock builds
and hosted profiles do not acquire router activation from this test exception.

Public builds retain the normal fifteen-minute requested funding lifetime and
two-minute handoff from preparation. Saved deadlines stay immutable. See
[invoice lifetimes](checkout-spark-invoice-lifetimes.md) and
[recipient verification compatibility](checkout-spark-recipient-verification-compat.md)
for the distinct expiry, renewal and attribution boundaries.

## Verification

Build manifests expose `quantumRouterEnabled` alongside the resolved profile
and public configuration digest, which covers the selected network and resolved
current/retired treasury policy. Raw treasury destinations are not included in
manifests or diagnostics. Build parsing bounds static-address syntax; offline
tests and pre-wallet preparation use the pinned SDK to validate checksum,
identity, canonical encoding and network. Artifact verification checks the
compiled destination policy in both apps and excludes mainnet policy on staging.
Managed-profile parsing, artifact verification
and preview CI assert that value for every app. Pure capability tests cover
hosted admission without local flags, production-host/profile mismatches,
unsupported networks and isolation of local exceptions. App tests retain
current-session guards and public dispatch policy checks.

Automated capability and synthetic payment fixtures do not establish live
provider settlement, signer/device behavior or recovery liveness. Those remain
maintainer-owned funded validation before release sign-off.
