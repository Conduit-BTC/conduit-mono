# Wallets Specification

This document defines the shared wallet model used by Market and Merchant. New
self-custodial wallets belong to the signed-in Nostr account. Conduit-operated
services never receive plaintext wallet credentials or control funds.

## Terminology

- **Portable Wallet**: a self-custodial wallet whose documented recovery
  material can recreate the wallet in a compatible application. Spark is the
  first Portable Wallet provider.
- **Connected Wallet**: an external wallet authorized through a connection
  protocol. Nostr Wallet Connect (NWC) is the first Connected Wallet protocol.
- **Provider**: the implementation behind a wallet, such as Spark or NWC.
- **Wallet instance**: one wallet registered on the device. A user may assign
  an optional device-local nickname, and a provider may have multiple
  instances.

The shared Wallets surface calls these sections **My wallets** and **External
wallets**. Default names use **Conduit Wallet**, numbered when needed. This is
product branding, not a custody or provider claim: Spark remains the single wallet
provider and signer runtime. Recovery details identify the actual Spark account
number and network; custom names remain device-local.

## Ownership and key boundary

Nostr authentication follows the signer boundary in `protocol.md`: NIP-07 and
NIP-46 remain available, and the optional installed-PWA existing-NSEC path keeps
the account key exclusively in the separate signer origin. Market must never
receive, derive, persist, or transmit the raw account `nsec`. The wallet provider
boundary does not authorize account-key import or generation.

A Portable Wallet seed is a separate wallet credential. It may be created or
restored by a client-side provider adapter only when:

- seed handling remains on the user's device;
- no seed, mnemonic, derived key, NWC URI, invoice, address, balance, or payment
  content enters logs or telemetry;
- the user receives a documented portable recovery path that does not depend on
  Conduit services;
- removing the wallet from a device does not claim that network funds were
  deleted; and
- Conduit-operated services cannot spend funds or recover the wallet.

Portable Wallet seed material must not be stored in localStorage. Provider
storage must be isolated per wallet instance. The shared local Dexie database
stores non-secret descriptors in `wallets` and provider-owned local credential
records in `walletCredentials`. Spark recovery records are encrypted envelopes;
NWC connection URIs remain confined to the Connected Wallet provider record.
Neither table is relay-synced.

New wallets require a connected account signer with verified NIP-44 encryption.
Signing out or switching accounts closes and hides that account's signer-backed
sessions without deleting recovery or funds. Sign-in restores account recovery and
opens discovered signer-owned wallets on the configured network through the signer
on Wallets without a Conduit unlock dialog. External signer consent may still be
required; deliberate lock or denied opening retains a direct Open action.
Legacy password-encrypted device wallets retain their existing signed-out
unlock and recovery path and are never silently reassigned to an account.

## Local unlock and portable recovery

New wallets use signer-backed encryption without a separate wallet password.
Legacy PBKDF2/AES-GCM password envelopes remain readable. Explicit migration
verifies a signer encrypt/decrypt round trip and transactional read-back, retaining
the old encrypted envelope and its password fallback. Unsupported or denied
encryption never falls back to plaintext. The Spark seed remains independent of
the Nostr key, which never enters app code.

The portable recovery bundle is the BIP39 mnemonic, explicit Spark account
number, and network. The bundle can restore the same Spark account independently
of Conduit in a compatible client. Importing into Market or Merchant uses the
connected signer to protect the local credential and encrypted relay backup.
Compatibility with another application must be verified before it is advertised. Market presents all three values to the wallet owner when a
wallet is created and on an authenticated local recovery request, before the
owner relies on that recovery path.

The standard production restore flow accepts the phrase and assumes Spark
account number `1` on Mainnet. The owner can override the account number when
the source wallet used a non-standard account. Network is fixed while the Spark
runtime is configured as one manager for the deployment network. These defaults
do not remove account number or network from the recovery bundle available to
the owner. The owner must know the network and any non-standard account number
needed to restore the intended wallet.

## Multi-wallet registry

Market maintains a collection of wallet instances. Each descriptor contains:

- a locally generated opaque identifier;
- kind (`portable` or `connected`);
- provider identifier;
- user-facing device-local label, generated from `Conduit Wallet` when an
  optional nickname is omitted;
- network;
- declared capabilities;
- lifecycle status;
- creation/update timestamps; and
- default roles.

Addresses, wallet pubkeys, signer pubkeys, and hashes derived from secret
material are not valid registry identifiers.

The registry supports multiple Portable Wallets and multiple Connected Wallets.
Defaults are selected by network and intent. The initial intent is
`pay_invoice`; callers may override the default with an explicit eligible wallet
for one transaction.

The selected wallet instance ID is a local-only target. It may be persisted in
the buyer's local order lifecycle for deterministic retry, but must not be
included in Nostr order messages, merchant payloads, payment proofs, logs, or
analytics.

Providers expose capabilities rather than implementing unsupported placeholder
operations. Initial capabilities are:

- `pay_invoice`
- `receive`
- `balance`
- `history`
- `spark_transfer`

## Connected Wallet migration

The existing single NWC connection is migrated into one Connected Wallet
instance. Migration must:

1. parse the legacy connection with the shared NWC parser;
2. create one registry descriptor and provider credential record in one Dexie
   transaction;
3. read the new records back successfully; and
4. only then remove the legacy storage keys.

An invalid legacy value is left untouched and must not create a partial wallet.
Any descriptor, credential, or default write failure must roll back the complete
new representation before the legacy value is touched.

Existing users must not need to pair their wallet again after a successful
migration.

## Spark Portable Wallet

Spark is implemented behind the same provider seam as Connected Wallets. The
initial browser adapter uses the pinned first-party
`@buildonspark/spark-sdk` release.

The initial Spark experience supports:

- creating more than one wallet;
- restoring a wallet from documented recovery material;
- opening and closing an instance without affecting other instances;
- reading balance and payment history;
- preparing and paying BOLT11 invoices;
- receiving through Lightning; and
- advanced direct Spark address send/receive for ecosystem interoperability.

Identity derivation must use Spark's documented standard path and an explicit
account number. Mainnet standard recovery deterministically uses account number
`1`; account `0` remains an explicit negative-control derivation for a Mainnet
compatibility fixture. Recovery material must include the actual account
number. Claimed cross-application recovery requires a fixed independently
sourced fixture or manual test against the named compatible application.

For BOLT11 checkout, the adapter must not prefer a direct Spark transfer when
that would remove the Lightning preimage or invoice association expected by the
order payment-proof flow.

## Payment selection and safety

Before payment, Market filters wallet instances by network and `pay_invoice`
capability, then surfaces each instance's readiness. A locked Portable Wallet
remains selectable so the buyer can unlock the intended instance, but payment
cannot start until it is ready. Market preselects the eligible default and lets
the buyer choose another eligible instance.

The selected wallet instance is fixed when a payment attempt starts. If it is
unavailable before publication, the user may select another wallet or an
explicit fallback. After publication or any ambiguous result, Market must not
silently retry through another wallet or rail.

Every provider payment receives the durable payment-attempt identifier as its
idempotency key when the provider supports idempotency. Provider selection is
local state and must not be sent to merchants or analytics.

WebLN and manual invoice payment remain explicit fallbacks.

Spark invoice and direct-transfer sends use a prepare/review/send boundary.
Before the irreversible send call, Market presents the selected wallet, amount,
provider fee, and total and requires explicit approval of those values. Dismissal
without approval performs no send. If re-preparing changes the fee or
total, the user must approve the new values. A missing approval callback fails
closed.

An ambiguous result remains attached to the original wallet instance and
attempt. The owner is directed to inspect that wallet's payment history, and
no automatic retry is available until the result can be classified safely.
For direct Spark transfers, a content-free, device-local safety marker survives
dialog dismissal and page reload. The marker is cleared automatically only
when Spark reports a terminal success or failure; otherwise, the user must
explicitly acknowledge that they inspected wallet history before a new direct
transfer can be prepared.

## Wallet owner experience

The `/wallet` route lets the owner distinguish Portable and Connected Wallet
instances by provider and device-local label. Actions must make clear whether
they create, connect, disconnect, or remove a wallet from this device. Removal
must not imply that network funds were deleted.

Removing a Portable Wallet requires recovery acknowledgement. A default marker
belongs to an instance, not to a provider. Removal acknowledgement is scoped to
the selected wallet instance and never carries over to another row.

Spark setup and restore identify the actual network. Before a Mainnet wallet is
created or restored, the owner is informed that it uses real bitcoin and
supports Lightning and Spark payments. Restore accepts the recovery phrase and
any non-standard account number needed for the intended wallet. The owner is
informed that a nickname is local and not backed up. New wallet recovery uses the
account signer; older password wallets keep their migration and recovery path.

The route renders while signed out, with sign-in required for new account-backed
creation/import and signer-backed access. Legacy device-wallet access remains
available through its existing password. Logout never deletes network funds or
the independent phrase/account/network recovery bundle.

Sensitive and destructive flow state resets whenever the flow is dismissed or
closed, including Cancel, close, Escape, and outside dismissal where supported.
Reopening it must not retain unlock passwords, recovery text, generated
invoices/addresses, fee approval, or removal acknowledgement from the previous
session.

While a provider operation is in flight, dismissal must not imply cancellation
or clear its state. Once a direct transfer settles as ambiguous, the owner may
leave the flow to inspect wallet history, but the device-local safety marker
remains. Returning to the send flow restores the unresolved state; only the
specified terminal provider result or explicit acknowledgement may clear it.

## Nostr backup interoperability

NIP-78 is an application-data envelope, not a general wallet-backup standard.
Relay backup is optional and must never be the only recovery path.

Any future Wisp/addys compatibility must live behind an explicit versioned
adapter, use capability-gated NIP-44 encryption, validate the author/signature
and recovery payload, and ship with cross-application fixtures. Market must not
derive a Spark seed from a raw Nostr private key.

## Validation

Required coverage includes:

- registry behavior with multiple instances of the same provider;
- default selection and explicit per-payment override;
- exact-wallet retry with no default or rail substitution;
- legacy NWC migration and rollback behavior;
- wrong-network and missing-capability filtering;
- payment idempotency and ambiguous-result handling;
- no Spark send before explicit fee approval;
- isolated Portable Wallet provider storage;
- signed-out `/wallet`, dialog-state reset, and in-flight dismissal behavior;
- password-encrypted device storage plus phrase/account/network recovery;
- phrase-first Mainnet/account-`1` restore with an account-`0` negative control;
- recovery and reopen behavior; and
- content-free logs and telemetry.

Before merge, run formatting, typecheck, lint, unit tests, telemetry policy, and
the main build. Spark browser QA must cover create, fund, pay, close/reopen, and
restore on the configured deployment network. Mainnet QA must use a deliberately
small balance and payment amount.
