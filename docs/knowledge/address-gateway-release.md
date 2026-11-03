# Address gateway approval and release gates

The address gateway implements PR-based approval for requested `conduit.cash`
names. Request receipt is neither a reservation nor approval. The gateway never
registers a wallet merely because a request was submitted. Ordinary Breez
addresses and checkout paths that do not use the custom domain remain independent.

## Original request review

`apps/address-gateway/approved-names.json` is the deployment input. The private
D1 row is evidence, not the approval list. An authorized operator privately
exports exactly one complete `name_requests` row as a JSON object. Do not put the
export, original signatures, note, request identifier or raw HTTP body in a PR,
log or artifact. Production access belongs to the trusted operator environment;
the repository utility is offline and receives no production credentials.

Run `scripts/deploy/review_address_request.ts` with the private evidence path and
a new proposal output path. It verifies both original signatures, including the exact HTTP bytes, endpoint
and method. Legacy evidence uses the recorded receipt time. Durable retry
evidence retains the original signing time and verifies fresh transport
authority separately. It checks
that every denormalized column agrees with the original signed request. Existing
v1 requests, including their note field, remain valid without rewriting evidence.
Migration `0002_immutable_request_evidence.sql` prevents later edits to those
columns while still allowing a reviewed decline status.

The utility proposes only the exact name, account public key, Spark identity
public key and `registration: true`. It preserves other manifest entries and
refuses conflicting names or multiple active names for one wallet. It does not
invent replacement, transfer or deletion permissions. It does not deploy or
write the source manifest. A maintainer reviews the proposed public binding and
applies it through a normal PR. Approval deliberately makes that binding public;
verify the requester's intended disclosure before publishing it. Only deploy
approved bindings after code review and release authorization.

A status check reports `approved` only when the deployed manifest matches the
request's account, wallet and name. Activation still requires current provider
recovery, fresh Spark authority and fresh NIP-98 account authority. An unknown
route or generic 404 is not `not_received`; only the explicit authenticated
record-absence response offers a retry of the same immutable request. It never
authorizes changing the saved name or request ID.

## Encrypted wallet progress

Request progress is a field of the complete encrypted Portable Wallet record,
`conduit:portable-wallet:v1:<walletId>`. It travels with the original recovery
tuple, name, receiving address and preferences. The clean-start wallet runtime
ignores previous separate request records and registry extensions.

The record retains canonical request bytes, the original account proof, the
wallet proof and progress. Exact signed wallet bytes are saved locally before
HTTP submission or activation. Current signer ownership, active lifecycle and
matching native identity authorize the selected wallet. Unrelated discovery
or relay-delivery uncertainty does not grant or veto that authority.

The shared wallet coordinator handles relay delivery automatically. A saved
request phase is a resume hint, never gateway approval or current registration
proof. Status checks and activation use fresh foreground authority. Before
resubmitting retained intent, query authenticated status: only explicit
`not_received` permits retrying the same immutable request. Unknown responses
and failed receipt writes cannot create a replacement request.

`Activate and use address` verifies current gateway approval, checks provider
state, retains activation intent before registering an absent address, verifies
the exact name and public lookup, then uses the field-preserving kind-0 address
publisher. A profile failure leaves `registered` progress with `Finish profile
update`; retry verifies registration before resuming publication. Completion
includes the freshly observed profile event ID. Wallet synchronization resumes
automatically and has no separate address-sync action.

Durable HTTP submissions retain the original body and send its original NIP-98
proof in `X-Address-Request-Proof`, together with a fresh NIP-98 Authorization
header bound to the exact current endpoint/body. The gateway verifies both
layers and the Spark signature. D1 stores durable original account proofs as
`{version: 2, event: <original event>}` in the existing immutable column; legacy
plain-event records and legacy clients remain readable. Existing rows are never
rewritten by retries. No database migration is needed for the wrapper.

Conflicting immutable request evidence fails closed. Saved names and address
progress use the same newest-valid-wallet rule as recovery; partial reads do
not erase stronger retained records. See [the complete wallet lifecycle](wallet-registry-lifecycle.md).

### Cutover and limits

The wallet event format deliberately has no old-format compatibility reader,
fallback, dual writes or automatic migration. Initial seed import establishes
fresh wallet metadata; existing gateway/D1 evidence is not deleted or rewritten.
The workflow is enabled by default. Setting
`VITE_ADDRESS_REQUEST_RECORD_WRITES_ENABLED=false` disables new request writes
in an emergency. The complete wallet plaintext has a 16 KiB bound. Controlled
encrypted tests do not establish public-relay retention or physical-device
recovery.

## Qualification boundary

The repository admission command has no live adapter and remains inconclusive.
Controlled tests exercise verdict classification without provider credentials.
A release owner separately reviews and installs a standalone one-shot operator
script outside every candidate checkout. It must have fixed upstream and domain,
no candidate imports, no runtime package downloads, bounded transport, and fixed
content-free verdict output. It is not an always-running service.

The operator obtains credentials from the approved secret store directly into
the reviewed process, without terminal output, command-line credential arguments
or repository storage. Only the authorized release maintainer runs it. Temporary
unfunded identities and random names are used; existing registrations are never
selected as controls. Retain private cleanup state until exact readback completes.

For registration, rename, transfer and deletion, qualification requires all of:

- Correct signed control accepted using valid provider admission.
- Same valid signed mutation rejected directly upstream with missing admission
  and with deliberately wrong admission.
- Exact authenticated identity readback after each rejected attempt and accepted
  control. An HTTP status alone is insufficient.
- Cleanup of only the generated bindings, followed by authenticated absence for
  both identities and public non-resolution for both temporary names.

Blanket denial, timeout, redirects, unexpected data or failed cleanup is
inconclusive. Accepted bypasses remain failures even if cleanup succeeds.
`PROVIDER_PROXY_QUALIFIED` stays `false` until the reviewed live evidence passes.
The public gateway also requires its own deployed rejection/authority checks;
upstream qualification alone does not prove gateway deployment correctness.

## Deployment and rollback contract

The gateway runs as a Cloudflare **Route** over the cash-domain DNS record,
whose origin remains Breez. Its provider fetch uses `https://conduit.cash`,
keeping TLS SNI and Host aligned. Cloudflare routes same-zone subrequests to
the DNS origin rather than recursively invoking the Route. Do not replace this
with a Worker Custom Domain or rely on overriding Host on a `breez.tips` URL.
Validate the origin, TLS and receiving path before activating the Route.
Receiving checks must cover metadata, the invoice callback and
`/lnurlp/verify/<64-hex-payment-hash>` at the custom domain. The verifier GET
and OPTIONS path needs public CORS and no-store behavior; an unknown hash must
reach the provider's error response rather than the gateway's missing-route
response. This path check does not establish invoice settlement.

Production needs a dedicated D1 binding with real database ID and both migrations,
exact application origins, Turnstile server validation for the request action,
and the server-only Breez domain/proxy credentials. The deployment configuration
must reject placeholders before upload. Browser bundles contain only the public
Turnstile site key and ordinary public Breez client configuration.

Turnstile permits subdomains of a configured parent hostname. A dedicated widget
can narrow scope and separate lifecycle ownership, but lack of an explicit
subdomain entry is not proof that a parent-domain widget cannot serve it.
Trusted repository previews can use the production gateway through
[provider-verified preview admission](./trusted-name-request-previews.md).
The gateway checks native Git deployment provenance and expiry independently of
Turnstile's project-host coverage. No client workflow receives provider credentials.
Cloudflare changes and a deployed real submit/status/activation check remain
separate approval gates; local tests do not establish deployed admission.

Stage the reviewed Worker with mutations disabled, verify D1 and secrets by
presence only, then coordinate provider admission and cash-domain routing so
existing public receiving never loses its supported path. Do not switch DNS
before the provider boundary and gateway receiving path have been qualified.
Record the exact Worker version, manifest digest, migrations and application
builds in private release evidence. Check TLS, no-cache behavior, CORS, signed
production submit/status, private proof readback, approved-manifest deployment,
same-wallet activation and recovery.

On a regression, disable management mutations independently and restore the last
known-good Worker version while preserving D1 evidence and approved bindings.
Do not revert to a direct-provider path that permits unapproved registration.
Do not delete request rows or registrations as a deployment rollback. Exceptional
rename, deletion and transfer approvals require separate explicit review;
destructive approval deadlines must be no more than 24 hours ahead, while every
mutation still needs fresh account and wallet proofs.

A complete receive claim additionally requires invoice-to-recipient binding,
a separately authorized small payment, browser-closed receiving, and recovery on
the intended signer/device. Local signatures, SQLite tests and controlled provider
responses do not replace those observations. No funds are sent by admission
qualification.

## Sources

- [Cloudflare Route origin subrequests](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Breez reverse proxy](https://sdk-doc-spark.breez.technology/guide/custom_domain.html)
- [Breez signed lifecycle messages](https://github.com/breez/spark-sdk/blob/5ea587cd84f0757a40998d58b46342abde79ce54/crates/breez-sdk/lnurl-models/src/signed_message.rs)
- [NIP-98 HTTP authentication](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [Turnstile hostname rules](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)

## Selected-wallet authorization

Authorization checks the current complete record and native identity before
request signing. A final fence after signing rejects changed signer or wallet
authority. Decrypted records are session-scoped and cleared when authority is
retired. Synchronization uses the shared wallet coordinator and exact-event
readback; there is no separate request journal, membership gate or repair flow.

## Deployments after approved merges

The address gateway is a Worker, independent of the Market and Merchant Pages
builds. A name approval becomes effective only after the gateway receives the
updated manifest; merging an approval does not activate or register the name.

`Address Gateway Deployment` runs after successful **push-to-main** `CI`. Its
credential-free authorization job verifies the actual CI run, exact current
main revision, repository, and associated PR merged into main by a human
maintainer. PR/fork runs, direct pushes, failed CI, bot-only merges and stale
revisions cannot release. The maintainer's merge is release approval for this
workflow, subject to any production environment protection rules.

The deployment job uses the `address-gateway-production` environment. It installs
locked application dependencies and a pinned Wrangler CLI, runs gateway and
release-policy tests, and compiles before any production credential is provided.
The release step rechecks merge/CI authority, reads current Worker **metadata**,
and builds a temporary no-bundle configuration from the live variables. It
preserves qualification, trusted-preview admission, secret bindings, D1,
rate limits and runtime. Unknown binding types, changed database/limits/runtime,
missing required secret bindings and mixed-version traffic stop the release.
No provider credentials are read; secret names are presence checks only.

Upload and activation use Worker **versions**, leaving routes and DNS alone.
The uploaded version must retain the exact live binding/runtime metadata before
traffic changes. Main and the live baseline are rechecked immediately before
activation. Successful releases identify their exact source with a `main-<SHA>`
version tag. Subsequent runs compare gateway/shared-core/dependency changes
against that last actual release, so an unrelated newer merge can carry forward
an approval whose earlier CI run became stale. Unchanged gateway inputs skip
upload. Production readiness and untrusted private preflight are checked after
deployment. Failures report a stopped release; they do not automatically roll
back approvals, mutate D1 or register an address.

### One-time operator setup

Before enabling unattended releases, an authorized operator configures the
production environment to permit only main and provides:

- Secret `ADDRESS_GATEWAY_CLOUDFLARE_API_TOKEN`: a dedicated token with
  `Individual Workers Editor` permission scoped only to
  `conduit-address-gateway` in the owning account. It needs no account-wide
  Worker access, D1 query, Pages administration, DNS or provider-secret read
  authority.
- Variable `ADDRESS_GATEWAY_CLOUDFLARE_ACCOUNT_ID`: the owning account ID.
- Variable `ADDRESS_GATEWAY_BOOTSTRAP_VERSION`: the exact reviewed active Worker
  version ID for the first automated release. This explicit bootstrap accepts
  the existing manual release once; tagged automated releases supersede it.

Creating or expanding credentials, changing environment access and enabling the
first production run remain operator-owned. No credential or environment
setting is created by this PR. A later manual dashboard change produces an
unrecognized baseline and requires fresh review/bootstrap before automation can
resume. Never use bootstrap to bypass an unresolved code or configuration drift.

The live trusted-preview admission implementation is included in the gateway
source. Checked-in qualification and preview variables remain disabled staging
defaults; the release controller preserves the reviewed effective live values.
A raw deployment of those defaults is not the automated release path. Name
activation, public profile publication and funded receiving tests remain
separate owner actions.

Sources: [GitHub workflow_run security](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[Worker versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/),
and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
