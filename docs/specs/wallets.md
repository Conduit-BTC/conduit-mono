# Wallets Specification

This document defines the multi-wallet model for Conduit Market and the shared
signer-backed Spark recovery contract for Market and Merchant. Conduit-operated
services never receive plaintext wallet credentials or control funds.

The target experience gives a connected identity a recoverable primary Spark
wallet while retaining device-owned imported and advanced wallets. The current
implementation supplies recovery foundations; automatic recovery/creation,
primary attachment, Merchant adoption and address registration are not enabled.
The lifecycle requirements below are release gates, not claims of shipped UI.

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

Spark must not be called "the Conduit wallet." Future providers must fit the
Portable/Connected model without changing this terminology.

## Ownership and key boundary

Nostr authentication remains external-signer-only. Market must never request,
derive, persist, or transmit an account `nsec`.

A Portable Wallet seed is a separate wallet credential. It may be created or
restored by a client-side provider adapter only when:

- seed generation and provider handling remain client-side; the explicitly
  authorized account signer receives recovery plaintext for self-encryption
  and decryption;
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

Device-owned wallets remain independent of Nostr sign-in. `/wallet` remains
available without a connected signer. Signing out must not remove, hide or
switch these wallets, and another pubkey must not implicitly claim them.
Connecting a signer must not unlock a password-protected device-owned wallet.

Signer-backed recovery belongs to the connected Nostr identity. Its target
lifecycle must close the open signer-backed wallet on lock, sign-out, account
replacement or lost authority, without deleting backups or device-owned wallets.
A new pubkey does not claim the previous identity's wallet. Market and Merchant
have separate browser storage and must recover the same validated Spark identity
before claiming a shared primary; concurrent SDK use requires separate proof.

The account signer sees recovery plaintext and can recover the wallet. An active
browser compromise can access an open wallet. Relay operators see ciphertext
and public event metadata; neither relay authentication nor encryption promises
permanent retention. These boundaries must be explained before relying on
signer-backed recovery. Never derive a seed from an account key or signature.

## Local unlock and portable recovery

Existing device-owned Spark wallets have a user-chosen local password. Market derives an
encryption key with PBKDF2-SHA-256 and stores only an AES-GCM encrypted recovery
envelope in the device-local credential store. The password is not a wallet
seed or the source wallet's password, is not stored, and is not needed to
recover the wallet in another browser or application.

The portable recovery bundle is the BIP39 mnemonic, explicit Spark account
number, and network. Market can restore the same account from that bundle
without Conduit services or a connected Nostr signer. Compatibility with
another application must be verified for that specific application before it
is advertised. Market presents all three values to the wallet owner when a
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

Market maintains a collection of wallet instances. The identity-backed primary
designation is distinct from a per-payment selection. Changing primary must not
change an in-flight attempt or a merchant's published sales destination.
Each descriptor contains:

- a locally generated opaque identifier;
- kind (`portable` or `connected`);
- provider identifier;
- user-facing device-local label, generated from `Spark wallet` when an
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
informed that a nickname is local and not backed up. For a device-owned wallet,
the local password encrypts the phrase in this browser; it is neither the source
wallet's password nor required for recovery elsewhere. The signer-backed target
lifecycle reopens through current signer authorization without a second wallet
password; it must not silently convert an existing password-protected wallet.

The route is a device-owned surface and must render while signed out. Identity
sign-in may still be required for order messaging and other Nostr workflows,
but never merely to create, restore, unlock, receive with, or remove a local
Portable Wallet.

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

## Signer-backed recovery format

NIP-78 defines application data, not a generic wallet-backup format. Conduit v1
uses signed kind `30078` events with NIP-44 v2 encryption to the owner's own
pubkey. A newer encryption version requires public specification and explicit
capability/interoperability evidence.

A wallet backup uses `d=conduit:spark:wallet:v1:<walletId>`. `walletId` is a random
UUID, never a mnemonic-derived identifier. The strict encrypted JSON contains:

| Field                      | Contract                                                           |
| -------------------------- | ------------------------------------------------------------------ |
| `format`, `version`        | `conduit.spark.recovery`, `1`                                      |
| `walletId`, `ownerPubkey`  | Opaque UUID and signed event's author                              |
| `provider`                 | `spark`                                                            |
| `network`, `accountNumber` | Actual network and integer account in `0..2147483647`              |
| `mnemonic`                 | Valid normalized English BIP39 phrase                              |
| `identityPublicKey`        | Compressed Spark identity derived by the provider from this bundle |
| `createdAt`                | Nonnegative integer Unix timestamp in seconds                      |

The separate `d=conduit:spark:primary:v1` event encrypts `format` equal to
`conduit.spark.primary`, `version=1`, `ownerPubkey`, `walletId`, `backupEventId`
and `createdAt`. Its reference binds the exact signed wallet backup. Primary
changes preserve every per-wallet backup. Public tags must not contain balances,
addresses, recovery material or mnemonic-derived identifiers.

Reject invalid signatures, authors and addresses before requesting decryption.
Require canonical NIP-44 v2 ciphertext bounded to 4096 characters, plaintext
bounded to 2048 UTF-8 bytes, strict known schemas, matching owner/d-tag, valid
BIP39 and supported provider network/account. Derive and compare the Spark
identity before attachment. Network must also be validated explicitly: matching
identity alone does not prove the intended network. Mainnet's standard account
is `1`, but backups and exports always carry the actual account and network.

The bounded Addy read adapter accepts `d=spark-wallet-backup` and
`d=spark-wallet-backup:<id>`, where the latter ID is the first 16 hexadecimal
characters of SHA-256 of the normalized mnemonic. Addy content is a self-encrypted
bare mnemonic, with no network/account metadata. Require explicit source network
and account, signature/owner/ciphertext/BIP39/address validation and provider
identity derivation. Multiple candidates never become primary automatically.
Conduit v1 is not Addy-write-compatible; dual publication is outside this contract.
Independent non-funded cross-client fixtures remain required before advertising
interoperability. Runtime-generated local fixtures are not that proof.

## Signer capability and authority

Use the existing shared AccountSigner/SessionSigner owner. Before creating a
wallet, perform a disposable self-encrypt, kind-30078 sign and self-decrypt probe
with non-secret test data; never persist or publish the probe. Advertised methods
or an optimistic encryption flag are insufficient.

NIP-07 requires public-key access, event signing and both optional NIP-44 methods.
NIP-46 pairing must request `get_public_key`, `sign_event:30078`, `nip44_encrypt`
and `nip44_decrypt`, then prove the real operations. Preserve typed unsupported,
denied, timeout and account-replacement outcomes. Fence the same account and
session revision around every asynchronous operation and immediately before
sending, retrying or attaching. Failure preserves existing wallets and backups
and offers retry, a supported signer or manual recovery.

NIP-55/Amber support requires a separately validated native Intent/Content
Resolver bridge. Never put a mnemonic in a browser `nostrsigner:` URL. Web users
require a safe NIP-07 or NIP-46 path until such a bridge is proven.

## Discovery, delivery and local evidence

The initial rendezvous set is `wss://relay.conduit.market`,
`wss://relay.damus.io` and `wss://nos.lol`, plus at most five applicable user
relays. Operator attribution is curated; unknown user relay labels cannot count
as independent backups. Apply current relay policy and account authority.
Discovery is bounded by author, kind and recognized Conduit/Addy addresses, with
a 128-record limit. Unrelated application data is not a wallet candidate.

Keep complete, partial and unavailable coverage distinct from absent within
scope, recoverable, conflicting and unresolved states. An incomplete read is
never global absence. Retain known signed candidates and unresolved-observation
evidence across later omissions. Malformed or unknown records cannot authorize
duplicate creation. Conflicting pointers or concurrent creation preserve all
candidates and require explicit selection.

The account-scoped Dexie `sparkRecoveryEvidence` journal holds signed ciphertext,
immutable relay targets, per-relay outcomes and read-back evidence. It must not
store plaintext mnemonic or decrypted envelopes. Preserve exact signed bytes
across reload and retry; repair lost copies without re-encryption or a new seed.
Historical ACK/read evidence is distinct from current presence. A definitive
current absence permits repair even after an earlier ACK.

Recovery readiness requires ACK plus exact-event read-back from at least two
known independent operators, with current read evidence no older than five
minutes, or explicit completed export of mnemonic, actual account and network.
An export flag may only follow actual user receipt, not merely opening a dialog.
Prepare a primary pointer only after the backup meets this gate. ACK is delivery
evidence, not permanent retention or payment settlement.

The recovery owner composes shared read and publication primitives; it must not
introduce a second transport or preferences engine. Production publication must
recheck authority immediately before socket send. The current foundation leaves
that composition gated pending the shared publisher's final-send fence.

## Primary lifecycle and migration gates

Before automatic creation, the later lifecycle must complete bounded discovery,
prove signer capability and check local wallets available for adoption. Partial,
unavailable, malformed, stale or conflicting evidence must instead offer retry,
import or explicit new-wallet choice with a conflict warning. Recovery must open
the same validated wallet; it must not silently generate a replacement.

Promoting an existing password-encrypted or phrase-restored wallet must reuse its
exact mnemonic, network, account and derived identity. Require explicit choice,
validate independent backups or completed export, then update the primary
pointer. Preserve the original local credentials until recovery is proven and
the owner chooses their disposition. Failed promotion must not change defaults,
delete credentials or overwrite another primary. Explain that an earlier Nostr
identity may still decrypt its historical backup.

The persistent primary is separate from the single-checkout ephemeral Spark
router. Recovery, payout order, fees, settlement, takeover and retirement rules
for that router remain unchanged. Primary recovery does not register a Lightning
address, change a merchant's destination or prove an order paid. Funding,
address registration, Merchant adoption and release validation are later work.

## Public references

- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md),
  [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) and
  [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md).
- [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md),
  [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) and
  [NIP-55](https://github.com/nostr-protocol/nips/blob/master/55.md).
- [Spark identity derivation](https://docs.spark.money/wallets/identity-key-derivation).
- [Addy backup](https://github.com/dmnyc/addy/blob/main/src/wallet/backup.ts)
  and [local storage](https://github.com/dmnyc/addy/blob/main/src/wallet/storage.ts).

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
- real signer operations and denial, timeout, unsupported capability and account
  replacement during probe, encryption, publication, decryption and attachment;
- strict signed-event, envelope, pointer and Addy validation;
- independent ACK/read-back, exact retry/repair, stale evidence and explicit export;
- partial reads, conflicts, retained observations and prevention of duplicate creation;
- non-funded backup and fresh-storage restore to the same derived Spark identity,
  including one unavailable relay and a browser persistence audit;
- recovery and reopen behavior; and
- content-free logs and telemetry.

Before merge, run formatting, typecheck, lint, unit tests, telemetry policy, and
the main build. Spark browser QA must cover create, fund, pay, close/reopen, and
restore on the configured deployment network. Mainnet QA must use a deliberately
small balance and payment amount.

The recovery foundation's synthetic signer/relay tests and offline SDK identity
equality do not establish external-signer, public-relay, physical-device or
cross-client compatibility. Record those evidence levels separately and retain
maintainer-owned wallet/auth/privacy sign-off before enabling the lifecycle.
