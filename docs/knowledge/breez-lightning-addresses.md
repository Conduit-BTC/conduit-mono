# Breez-hosted Lightning addresses

Market and Merchant's optional `conduit.cash` address management uses Breez's hosted service.
The first-party Spark provider remains the sole wallet and session owner. It
passes its own `DefaultSparkSigner` to the existing Spark wallet, then exposes a
bounded address-management signing seam. The address client never receives a
mnemonic, generates a seed, opens another SDK wallet, changes a merchant's
`lud16`, or participates in checkout-router recovery or settlement.

On **Wallets**, **My wallets** offers **Create wallet** and a separate
**Import wallet** flow. Creation generates a random Spark recovery phrase,
actual account number and default name. Import uses the saved phrase and account
number, recovering the same Spark identity. The configured Mainnet real-bitcoin
notice appears before the primary creation action; clicking that disclosed
action starts setup. Setup requests a `conduit.cash`
address by default in an enabled build. Signed address recovery always precedes
registration, including for imports. An existing address remains attached to
that recovered wallet; changing the public profile address is optional.

Wallet cards show the name, balance and receiving address with **Receive** and
**Send**. Rename, recovery, spending default, history, lock and removal are in
the overflow menu. Address failure leaves invoice receive and the wallet usable,
with a retry on the same wallet when registration is retryable. Disabled,
unsupported-network and invalid-configuration states have distinct explanations
and do not offer registration retry. Receive cannot be dismissed during address
registration; address/invoice controls and card actions cannot conflict with
that pending operation. **External wallets** keeps NWC connections
separate.

## Sign-in and recovery

New wallets require a connected NIP-44-capable account signer. The existing
AccountSigner/SessionSigner encrypts a bounded, account/wallet/network/account-
number-bound recovery record to itself and proves a decrypt round trip before
committing ciphertext to the existing device-local credential store. This
follows [Addy's encrypt-to-self storage pattern](https://github.com/dmnyc/addy/blob/8b793241c4f9916b350aefc1ba393de8c9a90c85/src/wallet/storage.ts),
with explicit binding, capability checks and authority fencing. Conduit has no
plaintext-storage fallback, never requests the Nostr nsec, and never derives a
Spark seed from a Nostr key or signature. The account signer can see wallet
recovery plaintext when encrypting/decrypting it.

The default wallet opens through the same signer after sign-in; a deliberate
lock requires an explicit open for that session. Revocation closes signer-owned
sessions even after leaving Wallets. Signing-only or denied encryption cannot
create a wallet; the UI explains the required capability. Existing password
wallets remain readable. An explicit one-time migration verifies signer
round-trip and transactional read-back, retaining the old encrypted recovery
copy and a previous-password fallback for the same account.

Recovery details include the phrase, actual Spark account number and network,
and setup requires acknowledgement that they were saved. Both apps use the same
`@conduit/ui` Wallets component and core lifecycle. New setup also encrypts a
versioned recovery record to the same Nostr identity and publishes signed NIP-78
`kind:30078` records through the existing authenticated executor and exact
publisher. Signing in on another origin discovers and restores the same wallet
UUID and Spark identity before registration or a new-wallet attempt. Recovery
never chooses spending/merchant receiving defaults or edits the public profile.

Reads are owner-scoped and authenticate through the active account signer.
The curated rendezvous is relay.conduit.market, relay.damus.io and nos.lol;
relay exclusions remain effective. Two independent operators must ACK and read
back the exact encrypted record and primary pointer before sync is ready.
Discovery queries the exact primary address and then its referenced backup
by event ID, so unrelated NIP-78 records cannot crowd out the usual wallet.
The capped broad scan remains necessary for additional wallets and conflicts.
Partial/unavailable discovery preserves positive evidence but blocks new
creation; an unresolved primary reference remains a repair state.
Malformed/conflicting evidence remains a repair state. An encrypted
root reference distinguishes deliberate additional wallets from simultaneous
first setups on different origins. Browser locks serialize one origin only;
conflicting roots are retained and block another creation. Nostr has no global
compare-and-swap.

Sign-in only reads/restores. Existing device-only recovery is published only by
**Sync wallet recovery**, which discloses encrypt-to-self and relay storage.
The shared surface confirms relay recovery only when backup and primary
readiness is observed; failed or incomplete delivery remains unconfirmed.
Password-encrypted recovery keeps its migration/fallback path. Save the phrase,
network and actual account number even when sync is ready: relay availability
and external signer support are independent recovery dependencies. NWC
credentials, names and spending/receiving preferences remain device-local.

## One public profile address

A wallet's receiving address and the single public Lightning address on a Nostr
profile are separate. After recovery acknowledgement, the first newly created
wallet supplies the disclosed default only when a complete latest profile has
no receiving address. Imports, additional wallets, and spending-default changes
leave it unchanged. An existing profile address requires **Use the Conduit
address** or **Keep the current address**. The existing address can already
receive into the recovered wallet; the UI makes no contrary assumption.

Wallets owns public address editing. Market and Merchant profile pages display
**Manage in Wallets** and exclude `lud16` from their details-save payloads. The
shared profile publisher merges a narrow address patch into confirmed complete
raw profile content, preserving unknown metadata and `lud06`. All profile writes
share a local/cross-tab lock. Address updates check the address reviewed by the
user and recheck the frontier after signing, rebasing competing ordinary edits while
refreshing the choice if the address changed, or refusing account replacement. An exact complete address patch can update a sparse or
confirmed empty profile without disabling the generic sparse-profile guard.
Nostr has no global compare-and-swap: an independent client can still publish a
later replacement, which requires reviewing the current profile and retrying.

## Configuration

Deployed enablement is the explicit `breezLightningAddressEnabled` flag in
`deploy/pages-profiles.json`. It defaults to false for preview, production and
staging. Enable an approved profile through a reviewed repository change;
preview can be used for controlled provider validation without enabling
production. The generated build value, public manifest/config digest and local
artifact/deployed-preview checks include this flag. Dashboard variables cannot
override it. Local development can opt in with
`VITE_BREEZ_LIGHTNING_ADDRESS_ENABLED=true`.

An enabled mainnet build also requires both provider variables:

- `VITE_BREEZ_LNURL_DOMAIN=conduit.cash`
- `VITE_BREEZ_SPARK_API_KEY`: the Breez-approved public client API key associated
  with this domain. This is intentionally a browser-visible public-client
  integration credential, not a secret or wallet credential. It ships in the
  bundle and is sent as bearer authorization, matching Breez's browser SDK
  design. Administrative/private credentials must not use this variable.

Wallet ownership and registration authority come from the signed Spark identity
request. The public-client key admits the integration to the provider service;
it does not replace the identity signature. Storing the build value as a
Cloudflare Secret does not make the emitted browser value secret.

Namespace reservations, name abuse/squatting and service quota controls are
separate provider-policy questions under discussion with Breez. Conduit's local
new-name policy does not enforce provider-wide namespace controls.

A disabled profile or missing configuration leaves address setup unavailable.
Mainnet is the only network enabled for this hosted domain. Provider
configuration and repository-managed rollout enablement are separate conditions.
Market and Merchant consume the same single Spark session seam.

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
Existing-address recovery and public lookup validate syntax and exact ownership
fields separately from this new-name policy. Valid existing short or protected
names, such as `ab` or `support`, remain recoverable without registration.
Availability/collision responses trigger another ownership lookup before moving
to the next name; at most five candidates are attempted. Web Locks serialize
clients for the same identity/domain on one browser profile. Local checkpoints
contain only the candidate, attempt count and uncertainty phase, scoped by a
hash of the public identity/domain. They preserve an ambiguous candidate across
reload. A fresh attempt rejected by admission/validation, or one that fails
before submission, returns to the selected phase even if follow-up recovery
fails. Transport failures, server errors, malformed success and unknown
conflicts remain ambiguous. A later definite rejection cannot clear uncertainty
from an earlier submission that may have committed. A lost registration response
is reconciled by lookup, never by changing wallets or blindly renaming.
Cross-device consistency still needs live provider validation; browser locks do not coordinate different devices.

Address registration, public LNURL lookup, advertised zap capability and payment
settlement remain distinct. Public lookup validates the same-domain callback,
amount bounds and address metadata. The UI exposes the address and reusable
LNURL QR only after that lookup succeeds. `receiveEvidence` remains `unverified`;
neither registration nor an advertised NIP-57 key establishes real or offline
receive. Failure leaves one-off Lightning invoice receive on the existing wallet
available. The checkout-scoped ephemeral router remains independent.

## Merchant payment confirmation

Merchant Payments redirects to Wallets; profiles only display **Manage in
Wallets**. There is no separate verification or advertised-zap setup. **Use for
new invoices** deliberately selects a receiving wallet independently of spending
defaults and the profile address. Signed payment requests and pending-invoice
journals retain the original wallet ID/provider/network and Spark request ID.
Address changes and delivery retries cannot replace that invoice or destination.
Older LNURL/NWC invoices require exact incoming evidence in a known wallet.

Open Spark sessions use the first-party native invoice lookup. Settlement needs
the exact invoice, payment hash, amount, completed transfer and matching payment
preimage. External wallets need `lookup_invoice`; `make_invoice` is needed only
for creation, without spending permission. Balance changes, address availability
and advertised zap keys never confirm an order. Keep Merchant open and the
original wallet open/reconnected for checks. Account switches fence lookup,
signing, durable publication and results.

## Reproducible evidence

`tests/signer-wallet-unlock.test.ts` uses real NIP-44 cryptography through
NIP-07/NIP-46 account boundaries, fresh-session reopen, owner/binding checks,
denied/unsupported capability and revocation during initialization.
`tests/profile-publish-workflow.test.ts` covers complete metadata preservation,
explicit replacement preconditions, competing edits, empty-profile defaults and
malformed-profile rejection. `e2e/wallet-sign-in.playwright.ts` exercises the
production page/hooks/store and real NIP-07 encryption with controlled network
initialization and address results. It covers desktop/mobile creation, saved
recovery, protected-name import, duplicate import, explicit profile replacement
and usable address failure. A composed Receive case prevents dismissal and
conflicting controls during address registration. A legacy migration case retains the old encrypted
copy and reopens through a fresh Nostr sign-in without a wallet password.
Recovery traces, screenshots and video are disabled; retained visual artifacts
show only empty/finished states.
`e2e/wallet-cross-app.playwright.ts` exercises both origins with real
NIP-44/signatures and an isolated NIP-42 relay, including concurrent setup.
`tests/signer-spark-relay-recovery.test.ts` uses real cryptography and first-party
identity derivation for fresh-store restore, partial discovery, immutable
retries, revocation and conflicts. Exact Merchant settlement and immutable
invoice bindings have focused workflow/adapter regressions. Merchant-authored
requests own invoice selection and receiving bindings; a buyer proof cannot
substitute a different same-value invoice. Confirmation always checks the
payment hash encoded in the invoice, including when no buyer proof is present.
These are local
controlled tests, not live external-signer, public-relay or funded settlement
proof.

`tests/breez-lightning-address.test.ts` exercises actual first-party identity
signatures against a controlled provider, source-defined message fixtures,
recovery-before-registration, lost responses, bounded collisions, invalid
configuration, domain failure and public LNURL substitutions. Regressions cover
short/protected existing names, definite rejection with unavailable recovery,
non-submission, and preservation of earlier or newly uncertain submissions. The
composed first-party adapter regression also proves that missing address configuration
keeps one wallet open and allows a one-off Lightning invoice.

`e2e/breez-lightning-address.playwright.ts` exercises the receive control and
real browser storage/Web Locks/signatures with controlled provider responses,
including a committed registration whose response is lost and a reload restore.
Its fresh first-party Spark signer stays in the Playwright process; the page
receives only public identity and signatures through a bounded digest-signing
binding. `tests/spark-address-session.test.ts` composes the production native
initialization/identity/signing/cleanup seam with controlled network-wallet
initialization and actual first-party derivation/signatures. It rejects an
initialized identity mismatch and refuses address operations after cleanup.
Neither test opens a network wallet or moves funds.

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
   interface and CORS from the actual Market/Merchant/preview origins.
2. Verify DNS/TLS, signed recovery/availability/registration, authenticated
   read-back, and public `/.well-known/lnurlp/<username>` lookup. Retry after a
   lost response and restore on a second device; preserve the same account.
3. Request a callback invoice through the existing Lightning helpers. Verify
   network, amount, expiry and description-hash binding before paying. Prove
   exact incoming settlement and spendability on the existing first-party Spark
   wallet; a changed balance alone is insufficient.
4. Close the receiving browser, pay the address, reopen the same first-party
   wallet and reconcile the exact receive. Validate simultaneous Market/Merchant
   sessions with the shared provider seam on actual deployed origins. Verify
   NIP-07/NIP-46 permissions, encrypted recovery read-back on two independent
   public relays, logout and fresh-device restore.
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
- [Glow browser public-client configuration](https://github.com/breez/glow-web/blob/a131450bd4ea3a7a78b8baccbda09b7e05887c43/src/services/sdkConnect.ts)
- [SDK HTTP implementation](https://github.com/breez/spark-sdk/blob/eb8be531d1bdb9e9d08cdf39e7800fbbded67397/crates/breez-sdk/core/src/lnurl.rs)
- [Breez account/identity derivation](https://github.com/breez/spark-sdk/blob/eb8be531d1bdb9e9d08cdf39e7800fbbded67397/crates/spark/src/signer/default_signer.rs)
- [LUD-16](https://github.com/lnurl/luds/blob/luds/16.md)
- [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md)

- [Addy encrypted wallet recovery](https://github.com/dmnyc/addy/blob/8b793241c4f9916b350aefc1ba393de8c9a90c85/src/wallet/storage.ts)
- [NIP-78 application data](https://github.com/nostr-protocol/nips/blob/master/78.md)
- [NIP-44 encryption](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [NIP-47 invoice capabilities](https://github.com/nostr-protocol/nips/blob/master/47.md)
