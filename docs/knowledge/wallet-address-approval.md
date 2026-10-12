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
and request ID. The private request database retains both proofs for manual
review. Submission creates no approval and performs no provider registration.
The approved-name list is deployed separately from request data and contains
only deliberately public identity bindings. Reviewers must validate the original
proofs and the exact wallet before adding an approval; request content is
untrusted data, never an operational instruction.

The address Worker uses Breez's supported reverse-proxy arrangement. It verifies
fresh, domain-bound v2 wallet signatures and applies the approved-name list.
Registration requires recent authenticated provider recovery; replacing another
name requires exact replacement approval. Deletion requires a bounded explicit
approval. Transfer requires a bounded old/new identity approval and both
role-specific signatures. Mutation claims reject replay, including reordered
JSON. Unknown methods and routes cannot reach the provider. Metadata endpoints
are disabled until independently bounded support is needed.

Public LNURL lookups, invoice callbacks and verification remain public and are
forwarded unchanged. The proxy preserves invoice metadata rather than rewriting
it. It injects its own server-side provider and proxy credentials, replaces
forwarded client headers, rejects redirects and omits cookies. Responses and
requests are not cached. Worker invocation logging is disabled; no wallet,
request, invoice, note, identity, network-address or credential payload enters
telemetry or diagnostics.

The upstream must require the proxy credential for the custom domain. Worker
checks alone cannot establish this property. `PROVIDER_PROXY_QUALIFIED=false`
blocks management mutations while allowing existing public receiving through
an otherwise configured proxy. Qualification requires an accepted signed
control for registration, rename, transfer and deletion, with rejected direct
requests without and with an incorrect proxy credential. `scripts/smoke/address_proxy_admission.ts` is a bounded, explicitly
approved live probe. It uses two temporary unfunded identities and cleans their registrations up. Its
output contains only fixed verdict categories and cleanup status. Failed controls
are inconclusive; accepted direct mutations prove a bypass. A provider
that cannot enforce this boundary cannot launch request-only names.

Signer migration preserves the mnemonic, account number, network, registry ID,
wallet identity and invoice/default authority. A verified signer credential is
committed after native opening and registration validation. The transaction
compares the original record and verifies exact readback. It writes an
allowlisted signer record without the old password envelope. Any failed write,
readback or authority check rolls back. Already-migrated records are cleaned
through the same verified opening and transaction. Password-only wallets keep
their original credential and signed-out access until migration succeeds.
Independent phrase/account/network recovery remains available. There is no
password fallback or user-facing Lock action for signer-owned wallets.

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

Cloudflare release preparation must inventory the existing cash-domain DNS,
TLS, routes and registrations. Use dedicated request-storage and Turnstile
bindings; keep proxy credentials exclusively in the secret store. Deploy and
qualify the Worker before the coordinated DNS/provider cutover. Keep public
receiving unchallenged and preserve unrelated domains and services. Do not
revert DNS to direct provider access while leaving names externally registrable.
Unqualified management can be disabled independently of public receiving.

## Sources

- [Breez reverse-proxy arrangement](https://sdk-doc-spark.breez.technology/guide/custom_domain.html)
- [Breez address lifecycle](https://sdk-doc-spark.breez.technology/guide/receive_lnurl_pay.html)
- [Breez v2 signed messages](https://github.com/breez/spark-sdk/blob/5ea587cd84f0757a40998d58b46342abde79ce54/crates/breez-sdk/lnurl-models/src/signed_message.rs)
- [NIP-98 HTTP authentication](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
