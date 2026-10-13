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

The optional `addressNameRequests` map belongs to the existing encrypted
`conduit:spark:registry:v1:<network>` record, keyed by the existing wallet ID.
There is no additional event kind, settings record, relay query or plaintext
request cache. Each entry retains exact canonical request bytes, the original
account proof, the wallet proof inside those bytes, and a monotonic phase.
The normal encrypted recovery journal retains and reads back signed registry
successors before submission. Local retention is shown separately from confirmed
relay publication; another device cannot restore a local-only checkpoint.

Normal wallet loading restores this map. Automatic checks are bounded to three
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

Durable HTTP submissions retain the original body and send its original NIP-98
proof in `X-Address-Request-Proof`, together with a fresh NIP-98 Authorization
header bound to the exact current endpoint/body. The gateway verifies both
layers and the Spark signature. D1 stores durable original account proofs as
`{version: 2, event: <original event>}` in the existing immutable column; legacy
plain-event records and legacy clients remain readable. Existing rows are never
rewritten by retries. No database migration is needed for the wrapper.

Conflicting immutable evidence fails closed. Observed removal always wins;
retained stronger phases survive stale successors, and a repair successor must
actually republish omitted metadata before claiming cross-device restoration.
Display-name metadata uses the compatible `walletNames` contract; this release
preserves it and drops it with removed wallets, without changing rename UI.

### Reader rollout and limits

The record retains version 1 and the existing coordinate. New readers accept old
records and preserve opaque encrypted extensions when creating successors.
Pre-extension strict readers reject added fields.
`VITE_ADDRESS_REQUEST_RECORD_WRITES_ENABLED` defaults to false; the finished
inline form remains visible while submission/activation writes are disabled.
Deploy compatible readers to both applications and refresh participating devices
before setting that public build flag to `true` for the reviewed release.
An isolated preview may enable it only after that rollout or with a dedicated
test account that has never been used in older clients. Before real requests,
maintainer sign-off must cover this rollout. A still-running old writer can omit
metadata. A device that retained the earlier signed record can repair it, but a
fresh device cannot reconstruct history that every replaceable relay has already
discarded. Do not claim compatibility with unupgraded writers or global consensus.
Rollback must retain compatible readers, ciphertext history and D1 evidence; do
not downgrade the wallet reader after extended records have been published.
The existing 16 KiB plaintext bound still applies; exceeding it fails before
network submission. Controlled encrypted tests prove bounded reconciliation,
not arbitrary relay retention or physical-device recovery.

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

- [Breez reverse proxy](https://sdk-doc-spark.breez.technology/guide/custom_domain.html)
- [Breez signed lifecycle messages](https://github.com/breez/spark-sdk/blob/5ea587cd84f0757a40998d58b46342abde79ce54/crates/breez-sdk/lnurl-models/src/signed_message.rs)
- [NIP-98 HTTP authentication](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [Turnstile hostname rules](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)
