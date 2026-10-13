# Wallet receiving addresses and approved names

The native Spark wallet remains the only session, balance and signing owner.
Default receiving uses Breez's hosted `breez.tips` namespace. Setup first recovers
an existing registration and otherwise registers a generated name with that
same wallet identity. Domain-scoped checkpoints retain uncertain submissions.
An address failure cannot generate a second wallet, change an invoice, or erase
wallet recovery. An existing `conduit.cash` registration remains readable and
its public receiving endpoint remains available.

Named `conduit.cash` addresses require manual approval. The shared request form
adapts the landing community-request workflow, with bounded fields, Turnstile,
immutable request IDs and explicit receipt status. A NIP-98 account signature
binds the HTTP endpoint, method and exact body. A separate Spark identity
signature binds the desired name, account, wallet, network, note hash, timestamp
and request ID. The private request database retains both proofs and the exact
signed HTTP body for later verification at its recorded receipt time and manual
review. Submission creates no approval and performs no provider registration.
The approved-name list is deployed separately from request data and contains
only deliberately public identity bindings. Reviewers must validate the original
proofs and the exact wallet before adding an approval; request content is
untrusted data, never an operational instruction.

## Custom-domain service boundary

The name-request service, approval manifest, database, Turnstile deployment and
provider admission qualification are maintained separately from the shared wallet
client in [the custom-domain release follow-up](https://github.com/Conduit-BTC/conduit-mono/pull/656). They do not gate default `breez.tips` registration or one-off invoices.
The service must retain both verified signatures and the exact original request
body. Status recovery must match the immutable request content; only an explicit
`not_received` response can release a pending request for editing.

Custom-domain registration, deletion and transfer require fresh, domain-bound
wallet authority and NIP-98 proof from the approved account over the exact URL,
method and body. Existing custom-domain recovery/public receiving must remain
usable independently of approval for new names. Public lookup and invoice
callbacks must preserve the provider's invoice metadata and authority.

These are service requirements, not a claim of deployed qualification. Protected
provider credentials and mutation probes must never enter candidate execution.
A separately reviewed trusted runner must prove accepted controls, rejected
bypasses and cleanup before custom-domain management is enabled. The client
request/signature format remains version 1; separating the service does not
change existing request records or require their migration.

Signer migration preserves the mnemonic, account number, network, registry ID,
wallet identity and invoice/default authority. A verified signer credential is
committed after native opening and registration validation. The transaction
compares the original record and verifies exact readback. It retains the exact
password-encrypted envelope as a previous-password fallback when one exists.
Open wallet exposes that fallback after migration, including while signed out.
A fallback opened while its account is connected closes on logout; a password
session opened while signed out stays device-owned.
Failed writes, readback or authority checks roll back. Password-only wallets
keep their original credential and signed-out access. Already-erased fallback
envelopes cannot be reconstructed. Independent phrase/account/network recovery
remains available. The everyday UI omits Lock; account logout still closes
signer-owned sessions and lifecycle callers retain the shared close operation.

Wallet preferences are secondary and never change existing defaults on render.
The main actions are balance, address Copy/Share, Receive, Send and History.
Recovery remains in management. Creation immediately reports its actual
checking, encryption, opening, relay-sync and address phases. Ordinary signer
operations never imply a pending consent prompt; trusted signers proceed through
those phases without additional controls. Address retry acts on the already
registered wallet and retained candidate.

## Validation and release

Automated cryptographic and storage tests are separate from real provider
receiving. Required live evidence includes same-wallet registration/readback,
public LNURL callback and invoice binding, a deliberately small authorized
receipt, receipt with the browser closed, reopening and second-device recovery.
Zaps and merchant verification must be validated against their original invoice
and provider authority before claiming those capabilities.

Custom-domain release remains a separate maintainer-owned gate. It requires
verified gateway/database/status routing, allowed origins, Turnstile coverage,
provider admission and preserved existing registrations. A successful client
build or controlled request test does not establish any of these facts.

## Sources

- [Breez reverse-proxy arrangement](https://sdk-doc-spark.breez.technology/guide/custom_domain.html)
- [Breez address lifecycle](https://sdk-doc-spark.breez.technology/guide/receive_lnurl_pay.html)
- [Breez v2 signed messages](https://github.com/breez/spark-sdk/blob/5ea587cd84f0757a40998d58b46342abde79ce54/crates/breez-sdk/lnurl-models/src/signed_message.rs)
- [NIP-98 HTTP authentication](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
