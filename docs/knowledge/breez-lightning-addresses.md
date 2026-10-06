# Breez-hosted Lightning addresses

Market's optional `conduit.cash` address management uses Breez's hosted service.
The first-party Spark provider remains the sole wallet and session owner. It
passes its own `DefaultSparkSigner` to the existing Spark wallet, then exposes a
bounded address-management signing seam. The address client never receives a
mnemonic, generates a seed, opens another SDK wallet, changes a merchant's
`lud16`, or participates in checkout-router recovery or settlement.

The current UI is an explicit receive-panel opt-in for an already open wallet.
It does not implement the later signer-backed primary lifecycle or automatically
promote device-owned wallets. The same shared address service can be composed by
that lifecycle once its recovery and authority gates are established.

## Configuration

Set both variables in the Market build environment only after approving the
Breez configuration:

- `VITE_BREEZ_LNURL_DOMAIN=conduit.cash`
- `VITE_BREEZ_SPARK_API_KEY`: the Breez-approved public client API key associated
  with this domain. Never put an administrative/private API key in a `VITE_*`
  variable; these values ship in the browser bundle.

Missing configuration leaves address setup unavailable. Mainnet is the only
network enabled for this hosted domain. Provider configuration is distinct from
the repository-managed public feature flags; no dashboard feature flag is added.
Other apps can consume the core client when their Spark session seam is ready.

Breez must allow the domain for that key. The dedicated apex uses a CNAME/ALIAS
or provider flattening to `breez.tips`. Cloudflare must use DNS only. No Conduit
LNURL server, credential proxy, DNS change, or domain launch is part of this
implementation. Admin enablement should verify TLS and browser CORS for the
actual preview and production origins before enabling the configuration.

## Identity, recovery and retry

Address requests use Breez's source-defined v2, timestamped, domain-bound
messages and DER ECDSA signatures over SHA-256. The client verifies each signature
against the current first-party Spark identity before sending it. Native wallet
initialization also checks the identity against offline derivation from the same
mnemonic, actual account number and network. Locking/closing the native session
revokes the signing seam, and stale session results are ignored by the manager.

Lookup is read-only. Every registration attempt first recovers the current
address for the existing Spark identity. A domain failure, invalid key, malformed
response, or incomplete request is never treated as address absence. Breez's
explicit authenticated `user not found` response is the only absence response
accepted. A generic 404 from an unenabled domain cannot trigger registration.

Generated names use the public Spark identity/domain scope and a bounded attempt
number to produce the same collision-resistant candidate on another device.
They never derive from a Nostr name or display name. Names use the conservative
intersection of Breez's grammar and LUD-16 (`a-z0-9_-` with non-leading,
non-trailing, non-consecutive dots), 3–64 characters, excluding protected names.
Availability/collision responses trigger another ownership lookup before moving
to the next name; at most five candidates are attempted. Web Locks serialize
clients for the same identity/domain on one browser profile. Local checkpoints
contain only the candidate, attempt count and uncertainty phase, scoped by a
hash of the public identity/domain. They preserve an ambiguous candidate across
reload. A lost registration response is reconciled by lookup, never by changing
wallets or blindly renaming. Cross-device consistency still needs live provider
validation; browser locks do not coordinate different devices.

Address registration, public LNURL lookup, advertised zap capability and payment
settlement remain distinct. Public lookup validates the same-domain callback,
amount bounds and address metadata. The UI exposes the address and reusable
LNURL QR only after that lookup succeeds. `receiveEvidence` remains `unverified`;
neither registration nor an advertised NIP-57 key establishes real or offline
receive. Failure leaves one-off Lightning invoice receive on the existing wallet
available. The checkout-scoped ephemeral router remains independent.

## Reproducible evidence

`tests/breez-lightning-address.test.ts` exercises actual first-party identity
signatures against a controlled provider, source-defined message fixtures,
recovery-before-registration, lost responses, bounded collisions, invalid
configuration, domain failure and public LNURL substitutions. The composed
first-party adapter regression also proves that missing address configuration
keeps one wallet open and allows a one-off Lightning invoice.

`e2e/breez-lightning-address.playwright.ts` exercises the receive control and
real browser storage/Web Locks/signatures with controlled provider responses,
including a committed registration whose response is lost and a reload restore.
It does not open a network wallet or move funds.

The offline SDK comparison was executed with first-party Spark SDK 0.12.1 and
Breez SDK 0.26.1 using the public BIP39 test mnemonic, for mainnet account 1,
mainnet account 7 and regtest account 0. All three identities match; signatures
from both SDKs verify under that same identity. No network wallets are opened.
The fixture identities are retained in the unit test. To repeat the independent
comparison, install `@breeztech/breez-sdk-spark@0.26.1` in a temporary directory
and run:

```bash
bun scripts/smoke/breez_spark_identity.ts /absolute/path/to/temporary/node_modules/@breeztech/breez-sdk-spark/nodejs/breez_sdk_spark_wasm.js
```

Breez is deliberately not added as a second runtime wallet dependency.

## Live enablement evidence still required

Use only team-controlled wallets and approved small-value payments. Keep payment
and recovery material out of logs, traces, screenshots and tracker attachments.

1. Confirm the public-client key, allowed domain, deployed v2 address-management
   interface and CORS from the actual Market/preview origins.
2. Verify DNS/TLS, signed recovery/availability/registration, authenticated
   read-back, and public `/.well-known/lnurlp/<username>` lookup. Retry after a
   lost response and restore on a second device; preserve the same account.
3. Request a callback invoice through the existing Lightning helpers. Verify
   network, amount, expiry and description-hash binding before paying. Prove
   exact incoming settlement and spendability on the existing first-party Spark
   wallet; a changed balance alone is insufficient.
4. Close the receiving browser, pay the address, reopen the same first-party
   wallet and reconcile the exact receive. Validate simultaneous Market/Merchant
   sessions only once Merchant has the provider seam; do not assume it today.
5. Use the existing NIP-57 zap-request validation and verify a real matching
   provider-signed receipt. Advertised `allowsNostr`/`nostrPubkey` alone is not
   zap or interoperability proof.
6. Confirm restore preserves the address and that an address-service outage
   still permits one-off receive invoices. Keep mnemonic/account/network export
   and signer-backed recovery independent of the hosted address.

## Sources

- [Breez hosted custom domains](https://sdk-doc-spark.breez.technology/guide/custom_domain.html)
- [Breez address lifecycle](https://sdk-doc-spark.breez.technology/guide/receive_lnurl_pay.html)
- [Canonical third-party client messages](https://github.com/breez/spark-sdk/blob/eb8be531d1bdb9e9d08cdf39e7800fbbded67397/crates/breez-sdk/lnurl-models/src/signed_message.rs)
- [SDK HTTP implementation](https://github.com/breez/spark-sdk/blob/eb8be531d1bdb9e9d08cdf39e7800fbbded67397/crates/breez-sdk/core/src/lnurl.rs)
- [Breez account/identity derivation](https://github.com/breez/spark-sdk/blob/eb8be531d1bdb9e9d08cdf39e7800fbbded67397/crates/spark/src/signer/default_signer.rs)
- [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md)
- [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md)
