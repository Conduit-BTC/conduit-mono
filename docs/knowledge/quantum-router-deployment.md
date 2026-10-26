# Quantum Router deployment capability

The code-owned mainnet Pages preview and production profiles enable Quantum
Router using independently approved ordinary-private Breez and Conduit
custom-domain receiver descriptors. Each profile selects its own pricing
service and public verification key ring; preview trust does not authorize
production. These are build inputs, not evidence of the currently deployed
version or completed release acceptance. A production build/deployment applies
the production settings; release approval remains a separate maintainer decision.
New preparation uses the shared
`isQuantumRouterEnabled()` admission capability and requires execution to be
enabled as well. Existing bound-plan actions use the separate compiled
`isQuantumRouterExecutionEnabled()` capability. Disabling new admission need
not stop recovery of an already approved plan; explicitly disabling execution
pauses funding disclosure/payment, wallet claims, payout preparation/sending
for that plan. Neither capability replaces its exact evidence,
approval, current-session or frozen timing requirements. Both mainnet profiles
enable both settings; Signet staging keeps both false. The
capabilities do not themselves establish successful funded or device acceptance.

Authenticated existing-order settlement projections and pinned query-only
observation remain available independently of both settings. They retain paid
commerce and fulfillment evidence without claim-capable wallet initialization,
invoice preparation or payout sending, including after takeover. Account/order changes
discard late read results. An activated production deployment needs no
localhost host or local rehearsal flags.
Signet staging remains disabled:
the current settled Spark plan supports mainnet and regtest, not Signet.

## Scope and prerequisites

Hosted activation is not a promise that every historical checkout or product
shape is routable. Current admission covers one merchant's final-quoted digital
or physical products with supported fixed or shipping-table fulfillment,
including supported fiat prices and selected variation children. The frozen
quote preserves exact signed source revisions, source amounts/currencies,
conversion snapshots, selected child facts and whole-line shipping allocations.
Fiat admission additionally requires a dedicated signed live-rate snapshot,
trusted public verification keys and independently confirmed native funding
creation time. Merchant recovery verifies that original historical rate, not a
current conversion or buyer timestamp. This supports instant checkout without
per-order Merchant approval once the separate rate service is activated. See
[signed live pricing](../specs/universal-checkout-router.md#signed-live-fiat-pricing).
The shared `SUPPORTED_PRODUCT_PRICE_CURRENCIES` list gates new commerce and
Worker requests; broader generic FX coverage is not product support. Retired BGN
prices and older common snapshots containing BGN remain readable and verifiable
for historical orders, but cannot authorize a new purchase or shipping quote.
Historical event-pickup plans remain recoverable, but retired pickup snapshots
are not admitted as new checkouts after the Event Market model cutover.
Current Event Market pickup requires a separate signed admission extension.
The shared admission and execution switches cover both ordinary checkout and
supported Event Market checkout; they are not independent rollout controls.
Unsupported or unresolved upfront evidence blocks payment rather than selecting
a direct-payment fallback. Positively resolved coordinate-after-order shipping
retains its negotiated order-first flow, and verified free orders remain free.
Existing supported listings do not need republication merely to activate
routing; supplier allocations require an explicitly published signed product
revision.

New routed checkout still requires exact signed commerce and recipient
authority, accepted mode-qualified recipient capabilities, a valid declared Merchant
inbox, and relay acknowledgement of the private recovery package before
disclosing funding. Failure of these prerequisites cannot downgrade an admitted
router checkout into another buyer payment.

Buyer foreground routing does not require an online Merchant client. At or
after the frozen handoff, eligible recovery runs when the Merchant opens its
client; this does not require inferred abandonment or add an always-on executor.
Funding is not commerce settlement, and commerce settlement is separate from
the platform fee. Missing receiving-origin evidence and uncertain attempts
retain an attention state without replay.

Merchant recovery normally continues eligible loaded orders automatically while
the current session is active. A paused order also offers an explicit
`Continue this order` action that authorizes only that selected order through
the existing recovery worker. Changing the selection, pausing, or replacing
the session revokes that scoped authority; it does not authorize other loaded
orders. Once exact commerce and fee payments are verified and saved, processing
is complete. The checkout-scoped wallet and encrypted recovery remain attached
to the order; current clients do not request automatic retirement or delete
those credentials. Historical retired records remain readable, and a retired
marker alone is never evidence that recipients were paid.
Buyer and Merchant use the same randomized, reduced-motion-aware
loading presentation, without treating animation as payment evidence.

## Local exceptions remain separate

Local rehearsal fee destinations, unquoted SDK receive compatibility,
accelerated timing still
require the local deployment profile, development mode and their explicit
loopback opt-ins. A public-profile bundle cannot acquire those exceptions from
dashboard flags or an imported plan. Legacy Lightning dispatch requires the
canonical mainnet production fee recipient; native final collection additionally
requires its frozen Spark destination to remain explicitly approved.
Historical local-canary records remain
readable but are not silently rewritten or dispatched.
An unset local execution setting inherits the resolved local admission for
compatibility. An explicit execution-off setting overrides every rehearsal
opt-in; local flags cannot activate a hosted execution profile.

## Pricing and receiver deployment trust

Receiver qualification and pricing verification are code-owned managed policy,
not claims supplied by metadata, recovery or a wallet brand. The
`quantumRouterTrust.preview` and `quantumRouterTrust.production` policies are
explicit and independent. Market and Merchant must compile the same receiver
descriptors, pricing URL and public key ring for their selected profile; the
public configuration digest and artifact verification cover that selection.
Configuring a preview endpoint, key or receiver does not configure production.
Managed profiles cannot acquire different trust from dashboard Vite overrides.
Signet staging clears these settings. Local explicit Vite configuration remains
separate and does not qualify a live deployment.

Receiver descriptors default empty. An `accepted` descriptor requires deployed
ordinary private receiving, exact issuance/account retention and verifier
behavior to be independently qualified; a `pending` descriptor or LUD-21 advertisement is
insufficient. Every required Merchant/supplier address is checked before
funding. See [receiver qualification](checkout-spark-recipient-verification-compat.md).

Preview and production contain distinct, separately provisioned public pricing
URLs and verification key rings. Production uses its dedicated pricing service
and signing authority, not the preview endpoint or key. Pricing trust alone does
not activate routing or qualify a receiver. The standalone
`apps/anon-zap-signer/wrangler.checkout-pricing.jsonc` uses a distinct rate-only
runtime-secret key, approved HTTPS origin list and mandatory native limiter.
Its source configuration does not create an active route or deployment. Provisioning
the key, enabling the service and publishing its public trust policy require
explicit maintainer authorization; merging source does none of those actions.
Retain prior public verification keys for historical frozen quotes even when
new quote issuance is disabled. Never reuse the anonymous-zap or account key.

Use a distinct preview Worker and pricing secret during qualification. Provision
the private key directly into that environment's runtime secret storage; it must
not enter a client bundle, command-line argument, local file or diagnostic. Only
the public verification key belongs in reviewed profile policy. Production
activation requires its own explicit service, origin and trust configuration.
An app source merge does not provision a Worker or signing secret, but a resulting
production app build/deployment does apply the checked-in activation settings.
Retaining a historical public key is deliberate policy, not an automatic
cross-profile copy. Production starts with its approved production key; the
preview key remains in the independent preview ring. Later key rotation must
retain the public keys needed by existing frozen quotes in that release boundary.

The mandatory native limiter uses one shared service key without tracking users.
Its counters are approximate and local to each Cloudflare location, not a strict
worldwide request quota. Do not treat its configured rate as a billing ceiling.
See the [Cloudflare rate-limit semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

Deterministic SAT, MSAT and BTC quotes do not need the pricing service, but still
require qualified receiving endpoints. Unconfigured trust fails before funding;
no localhost flag or direct-pay fallback should bypass that result. Synthetic
qualification alone cannot accept a receiving endpoint.

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
zero provider fee, a finalized exact invoice and non-cancellable sender
commitment to the frozen recipient and amount, with a recognized non-cancelled
receiver claim state. An offline receiver need not claim before routing
completes. Submission or a zero sender balance alone is not proof; receiver
claim and safe retirement remain separate evidence gates. Uncertain transfers
remain query-only and cannot be retried by removing a pause flag.

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

Build manifests expose `quantumRouterEnabled` and
`quantumRouterExecutionEnabled` alongside the resolved profile
and public configuration digest, which covers the selected network and resolved
current/retired treasury policy and shared receiver/pricing trust. Raw treasury
destinations, receiver descriptors and rate keys/URLs are not included in
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
maintainer-owned funded validation before release sign-off. The approved preview
pricing trust and ordinary-private Breez and Conduit receiver descriptors are configured.
The production profile selects its separately approved trust for the same two
receiving contracts. Both profiles compile enabled routing and execution. Exact-head
readback, real recipient settlement, native collection and independent-browser
recovery remain separate acceptance evidence. Guest checkout acceptance proves
exact router funding and acknowledged encrypted Merchant handoff. Continued
payout visibility is available while that guest session remains active; recovery
after exit uses the submitted private contact or the applicable handout flow,
without requiring an asynchronous receipt or a persistent guest identity.
Production rollout requires explicit acceptance for the combined ordinary/Event
scope, integrated recovery fixes and the remaining funded, concurrency and
physical-device checks. Neither preview evidence nor the activation configuration
waives those checks. Signet staging remains disabled.
