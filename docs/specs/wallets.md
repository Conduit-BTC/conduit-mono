# Wallets Specification

This document defines the wallet model used by Conduit Market. Wallet ownership
is independent from a user's Nostr identity, and Conduit-operated services never
receive or control wallet credentials or funds.

## Terminology

- **Portable Wallet**: a self-custodial wallet whose documented recovery
  material can recreate the wallet in a compatible application. Spark is the
  first Portable Wallet provider.
- **Connected Wallet**: an external wallet authorized through a connection
  protocol. Nostr Wallet Connect (NWC) is the first Connected Wallet protocol.
- **Provider**: the implementation behind a wallet, such as Spark or NWC.
- **Wallet instance**: one user-labelled wallet registered on the device. A
  provider may have multiple instances.

Spark must not be called "the Conduit wallet." Future providers must fit the
Portable/Connected model without changing this terminology.

## Ownership and key boundary

Nostr authentication remains external-signer-only. Market must never request,
derive, persist, or transmit an account `nsec`.

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

Wallet ownership is device-local and independent of Nostr sign-in state.
`/wallet` remains available without a connected signer. Signing out must not
remove, hide, or switch wallets, and signing in as a different pubkey must not
implicitly reassign them. The UI must make this shared-browser-profile boundary
clear anywhere account ownership could otherwise be inferred. Connecting or
disconnecting a signer must never unlock or remove a wallet.

## Local unlock and portable recovery

Each Spark wallet has a user-chosen local password. Market derives an
encryption key with PBKDF2-SHA-256 and stores only an AES-GCM encrypted recovery
envelope in the device-local credential store. The password is not a wallet
seed, is not stored, and cannot recover the wallet on another device.

The portable recovery bundle is the BIP39 mnemonic, explicit Spark account
number, and network. Market can restore the same account from that bundle
without Conduit services or a connected Nostr signer. Compatibility with
another application must be verified for that specific application before it
is advertised. Market must show all three values when a wallet is created and
when an authenticated local user requests its recovery details.

## Multi-wallet registry

Market maintains a collection of wallet instances. Each descriptor contains:

- a locally generated opaque identifier;
- kind (`portable` or `connected`);
- provider identifier;
- user-facing label;
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
account number. Recovery material must include or deterministically fix the
account number. Claimed cross-application recovery requires a real fixture or
manual test against the named compatible application.

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
Before the irreversible send call, Market shows the selected wallet, amount,
provider fee, and total and requires explicit approval. Cancel, Escape, close,
or any other dismissal performs no send. If re-preparing changes the fee or
total, the user must approve the new values. A missing approval callback fails
closed.

An ambiguous result remains attached to the original wallet instance and
attempt. The UI directs the user to inspect that wallet's payment history and
must not expose an automatic retry until the result can be classified safely.
For direct Spark transfers, a content-free, device-local safety marker survives
dialog dismissal and page reload. The marker is cleared automatically only
when Spark reports a terminal success or failure; otherwise, the user must
explicitly acknowledge that they inspected wallet history before a new direct
transfer can be prepared.

## Wallets UX

The `/wallet` route is titled **Wallets** and groups every instance under:

- **Portable**
- **Connected**

Rows identify the provider and the user's label. Actions use ownership-aware
language:

- `Add portable wallet`
- `Connect wallet`
- `Disconnect` for Connected Wallets
- `Remove from this device` for Portable Wallets

Removing a Portable Wallet requires recovery acknowledgement. A default marker
belongs to an instance, not to a provider. Removal acknowledgement is scoped to
the selected wallet instance and never carries over to another row.

The route is a device-owned surface and must render while signed out. Identity
sign-in may still be required for order messaging and other Nostr workflows,
but never merely to create, restore, unlock, receive with, or remove a local
Portable Wallet.

Sensitive and destructive dialog state resets on every close path, including
Cancel, the close button, Escape, and outside dismissal. Reopening a dialog must
not retain unlock passwords, recovery text, generated invoices/addresses, fee
approval, or removal acknowledgement from the previous session.

While a provider operation is in flight, dismissal requests must be ignored
rather than implying cancellation. Once a direct transfer settles as
ambiguous, the dialog may be dismissed so the user can inspect wallet history,
but dismissal must retain the device-local safety marker. Reopening the send
flow restores the unresolved state; only explicit acknowledgement may clear it.

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
- recovery and reopen behavior; and
- content-free logs and telemetry.

Before merge, run formatting, typecheck, lint, unit tests, telemetry policy, and
the main build. Spark browser QA must cover create, fund, pay, close/reopen, and
restore on the configured deployment network. Mainnet QA must use a deliberately
small balance and payment amount.
