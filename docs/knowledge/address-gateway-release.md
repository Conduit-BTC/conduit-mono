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

Request progress uses a separate encrypted kind-30078 record at
`conduit:address-requests:v1:mainnet`, keyed within its ciphertext by the
existing wallet ID. It does not add fields to the wallet-membership registry.
Each entry retains exact canonical request bytes, the original account proof,
the wallet proof inside those bytes, and a monotonic phase. The account journal
retains exact signed local intent before HTTP submission or activation. The
selected wallet must have current signer ownership, verified local encrypted
recovery, matching native Spark identity, and no retained removal or conflicting
backup. Account-wide discovery completeness is not that wallet's authority.

Optional relay publication runs independently through the existing request
service. Its immutable staged event and destinations remain separate from the
latest encrypted local progress; new progress cannot rewrite an in-flight event.
Incomplete membership or optional readback leaves synchronization pending without
vetoing gateway submission, status or approved activation. Local retention is
shown separately from confirmed publication; another device cannot restore a
local-only checkpoint. Reload or another wallet action resumes bounded repair.

Normal wallet loading reads this optional record independently of membership.
Automatic checks are bounded to three
requests per signer session, once per request; signer refusal pauses automatic
checks. Explicit checks use foreground consent. Receipt/uncertainty continue to
show the existing receiving address. Once approval or decline is recorded,
pending checks stop. Activation is an explicit action and independently checks
current gateway approval and authenticated provider registration. A saved phase
is a resume hint, never approval or proof of current registration.

`Activate and use address` first retains activation intent, registers only after
an authenticated absence, verifies the exact name and public lookup, saves
registration progress, then uses the existing field-preserving kind-0 address
publisher. A profile failure leaves `registered` progress with `Finish profile
update`; the retry verifies the existing registration without registering again.
Completion includes the profile event ID and requires fresh profile observation.
A failure to sync completion offers a separate sync retry. A generic routing
error or unavailable relay never erases request evidence.

Before retrying a retained request, query authenticated status. An unknown or
lost response stays uncertain; only explicit authenticated `not_received` permits
resubmission of the same identity and bytes. A failed local receipt write cannot
cause a new request. Gateway receipt/approval and optional relay sync render as
independent states.

Durable HTTP submissions retain the original body and send its original NIP-98
proof in `X-Address-Request-Proof`, together with a fresh NIP-98 Authorization
header bound to the exact current endpoint/body. The gateway verifies both
layers and the Spark signature. D1 stores durable original account proofs as
`{version: 2, event: <original event>}` in the existing immutable column; legacy
plain-event records and legacy clients remain readable. Existing rows are never
rewritten by retries. No database migration is needed for the wrapper.

Conflicting immutable evidence fails closed. Confirmed membership removal
always wins; retained stronger phases survive stale optional heads. Optional
read failure never changes wallet membership or grants approval. Display names
use their own `conduit:wallet-names:v1:<network>` record.

### Reader compatibility and limits

New ordinary membership successors contain only the deployed strict v1 fields.
An older client can continue to read and write wallet membership while a newer
client writes the separate request record. Older clients do not show that
optional progress. The workflow is enabled by default; setting
`VITE_ADDRESS_REQUEST_RECORD_WRITES_ENABLED=false` is an emergency disable,
not a staged-reader requirement.

Some earlier preview clients wrote `addressNameRequests` inside the registry.
New readers still accept that legacy extension. Before an ordinary successor
drops it, the writer must publish and read back the exact legacy progress in
the separate record. If migration cannot be confirmed, the membership change
stops rather than erasing the only relay copy. Rollback must preserve encrypted
request history and D1 evidence; a fresh old client cannot display optional
progress. The 16 KiB plaintext bound still applies. Controlled encrypted tests
prove bounded reconciliation, not arbitrary relay retention or physical-device
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
Preview should show the finished form; real preview submissions are not a release
gate. An explicitly authorized release preview can use its exact origin and
hostname with the trusted gateway and a public site key. Never allow all Pages
previews, give the preview provider credentials, or run candidate code in the
qualification runner. Remove the temporary preview origin after qualification.
Production submit and status require actual deployed observations.

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

## Optional request synchronization repair

Selected-wallet authorization completes before the wallet request timestamp is
set and before a fresh NIP-98 HTTP proof is signed. Within one action, unchanged
encrypted recovery and signed journal IDs reuse their validated identity and
removal evidence. Each boundary still checks the current signer, wallet,
native identity, recovery binding and journal; changed evidence is revalidated.
No decrypted recovery material or authorization survives into the next action.
A final current-authority check still precedes delivery. Local request
progress is relay-confirmed only when that exact selected record is covered by
the confirmed snapshot. An empty or unrelated membership snapshot is insufficient.

When all relevant relay heads agree on compatible cross-device progress, optional
synchronization can reconcile a staged operation over that head. A new signed
successor contains the merged progress, preserves exact request payloads and proofs,
and inherits the staged delivery plan. The existing journal atomically replaces the
superseded optional operation; no permanent history store is added. Reconciliation confirms consensus at the frozen
destinations, and interrupted successor delivery retries its exact bytes. Divergent,
unavailable, or incompatible observations retain the pending operation for repair.
This device-local journal addition changes no public event format or version.

Validated legacy registry requests for the selected wallet remain resume evidence
even when an unrelated wallet backup is missing. Discovery uncertainty never
authorizes replacing that immutable request. Newly staged local aggregates omit
requests only for positively signed mainnet removals; omission from a partial
read does not prune them. Frozen delivery events remain separately retained, so
removed-wallet history cannot exhaust the active snapshot's size budget.
