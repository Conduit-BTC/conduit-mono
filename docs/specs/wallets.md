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
- **Wallet instance**: one wallet registered on the device. A user may assign
  an optional device-local nickname, and a provider may have multiple
  instances.

Spark must not be called "the Conduit wallet." Future providers must fit the
Portable/Connected model without changing this terminology.

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

Market maintains a collection of wallet instances. Each descriptor contains:

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

An explicitly approved, immutable checkout-scoped router plan may authorize
automatic outgoing payments to its frozen recipients. New V1 payouts are
ordinary private payments; identified and anonymous public routed zaps are not
offered. Each invoice and outgoing fee must remain within that recipient's
settled allocation. Separate
per-leg fee approval is not required within this authorization. Approval must
explain the funding total, allocation policy, fee deductions, and Conduit-last
ordering; recipient net amounts are determined after exact inbound settlement
and payout fee fitting. A changed plan, destination, allocation policy, or
spending limit requires renewed approval. Ordinary wallet sends and the wallet
payment funding the router retain their existing fee-approval boundary.

Buyer-side automatic routing is foreground-only and requires a current order and buyer
session. Pausing, hiding the page, changing identity, or leaving the order
revokes automatic dispatch before the next irreversible operation; an already
submitted operation must settle or be reconciled before another can start.
Reload does not restore automatic authorization. Resume requires approval of
the same saved plan and reconciliation of its existing attempts. Unknown
outcomes never authorize a replacement invoice, new transfer identifier, or
blind retry. Router completion requires every planned payout, including the
Conduit leg; wallet retirement remains a separate evidence-gated action.

Within that same approved foreground activation, the client may automatically
check delayed funding and reconcile the exact saved outgoing attempt for up to
five minutes, with bounded backoff. These checks do not re-enter a funding
payer, replace an invoice, create a new transfer identity or restore withdrawn
authorization. Positive exact completion may advance the frozen plan; missing
or unavailable history never authorizes replay. Conflicting evidence, terminal
failure and fee-policy failures pause new dispatch. Invoice expiry and the
saved objective shopper-to-Merchant takeover boundary remain separate limits;
polling cannot extend either or infer abandonment from a missing heartbeat.

Normal new plans freeze Merchant takeover two minutes after preparation while
requesting a fifteen-minute funding invoice. Existing plans keep their original
deadlines. New buyer outgoing admission ends at that boundary; already admitted
operations remain queryable and must drain or reconcile under their exact saved identifiers.
Merchant eligibility is not proof of an unattempted payment and must not bypass
those records, recipient attribution, or provider idempotency. The five-minute
checking budget does not extend buyer dispatch beyond the frozen handoff.

The same exact funding invoice may first be presented, paid, or reopened until
its own signed expiry, including after Merchant takeover. This requires the
original buyer, order, checkout, immutable plan, active approval and acknowledged
recovery handoff. A durable possible-funding marker must precede exposure or
payment; an uncertain automatic attempt remains check-only unless that exact
invoice was already reserved for external disclosure. Changing the account,
order or approval revokes the controls. Handoff never creates a replacement
funding invoice, another funding attempt, or renewed buyer payout authority.
Merchant recovery independently inspects and routes exact late funding.
The invoice lifetime is not a promise that a reload can recreate a lost
in-memory checkout wallet. If exact credit inspection is unavailable, new
funding admission stays paused rather than inferring an unpaid receive.
Retained ciphertext and the original order remain usable for Merchant recovery;
they do not supply the buyer with a plaintext credential or waive funding guards.

### Checkout preparation and credential trust

A failed preparation must distinguish recoverable state from proven absence.
Persist the original order draft and exact checkout binding before publishing
its encrypted recovery wrap. If the exact wrap survives an interrupted write,
readback, or callback, retain its wallet and invoice, repair only an unambiguous
matching binding, and retry that same ciphertext. A reload continues the
original order, not a newer cart. Funding exposure still requires recipient
relay acknowledgement; acknowledgement is not payment or recipient receipt.
First publication of that original order remains bounded by the saved funding
invoice expiry. Retention after expiry supports Merchant/manual recovery, not
a replacement invoice or an automatic cart unlock.
Unreadable or conflicting local state remains recoverable and must not be
discarded. Only positively verified pristine state with no saved wrap, exposure,
funding or payment attempt permits revision-checked local abandonment and a
fresh preparation. A failed callback alone cannot establish that state.
Verify the exact pristine revision before closing its RAM wallet, and serialize
closure with removal of that claim. A failed or timed-out close retains the claim
for manual recovery; a local transaction cannot roll back or cancel an external
wallet close, so it must not promise an immediately reusable RAM credential. Session
revocation before closure blocks cleanup; revocation during an already admitted,
definitely unexposed close must not leave a claim whose sole credential was
discarded. Completing that exact cleanup grants no new payment authority.

The encrypted Merchant recovery envelope intentionally grants the Merchant the
raw credential for this isolated checkout wallet. It grants no access to the
buyer's funding wallet or Nostr account. The handoff timer, recipient allocations
and Conduit-last policy constrain conforming clients, not the extractable wallet
credential: a holder of that credential can spend outside those client rules.
Preventing deliberate fee evasion by such a holder is not this router's trust
model. Accidental replay, wrong-recipient payments, premature dispatch and
loss of recoverable credentials remain correctness defects. Recovery guidance
must state this bounded trust assumption without suggesting guaranteed recovery
or cryptographic enforcement of the client timer.

### Pricing and receiving authority

Fiat-priced products, variations and shipping use an authenticated bounded
snapshot of the existing live price feeds, without requiring a Merchant online
for each quote. Preserve the exact pricing attestation with the frozen commerce
terms. Fresh provider request creation time anchors funding admission; Merchant
financial recovery independently authenticates the historical quote at the
original native receive creation time, not the recovery clock or buyer labels.
Deterministic SAT, MSAT and BTC terms require no rate service. Current rates and
key rotation must not reprice existing orders; retain historical verification
keys. Missing trusted authority or native time evidence pauses fiat admission.
Shared display and checkout requests use a common bounded currency set and
authenticated cache with the original validity timestamps. Mixed feeds retain
signed per-currency provenance; absent extensions preserve historical digests.
Only immediate live issuance permits an explicit one-second clock tolerance.
Expiry and historical native funding-time verification remain strict.

All required Lightning receivers must satisfy an accepted deployment-qualified
capability before funding. V1 qualifies ordinary private metadata-hash
receiving contracts; advertising LNURL verification alone is insufficient.
Public-zap capability is not a V1 admission requirement. An exact intent retains
a portable receiver binding, not a trusted shopper claim. Both clients
independently verify its invoice/account association
and receiver-settled result alongside native Spark debit, amount and preimage.
Local invoice origin or an unpaid verifier result alone cannot establish bound
recipient settlement. Delayed receiver history reconciles the same attempt,
without a new send. Historical unbound imported attempts remain unverified.
See the [router contract](universal-checkout-router.md) and
[receiver qualification](../knowledge/checkout-spark-recipient-verification-compat.md).

### Deferred public routed zaps

V1 offers no identified or anonymous public Merchant-payout zap option,
public-zap invoice or public signing authorization. Guests and signed-in
shoppers use ordinary private funding and payouts. Ordinary non-routed zaps and
global provider zap support remain unchanged.

Historical public policies and exact intents retain their digests, invoice
bindings and possible-send state. Never rewrite them as private payments or
infer nonpayment from a missing receipt. Exact settlement can be reconciled;
unavailable recipient proof or public renewal remains paused. Deferred public
signing adds no new service activation or V1 acceptance dependency.

### Immediate Merchant settlement observation

Authenticated exact-order recovery may query funding and outgoing evidence
before the two-minute takeover. Use an independently audited, pinned query-only
adapter: no wallet initialization, claim/sync, privacy change, invoice creation,
transaction signing or send. Verify its derived wallet identity, exact native
credit and every required commerce debit together with independent recipient
verification. Receiver-paid invoices alone are informational and cannot mark
another checkout paid. Bound reads and invalidate timed-out or revoked work.

Independent commerce settlement may enable the existing fulfillment flow
before takeover. It does not advance reconciliation, prepare another intent,
collect the Conduit fee or retire the wallet. Claim-capable recovery and outgoing
operations still obey the saved takeover deadline; historical deadlines and the
separate fifteen-minute funding invoice remain unchanged.

### Native final treasury allocation

New version-four plans may replace only the Conduit Lightning leg with one
native Spark transfer to an operator-configured static receive address.
Merchant and supplier payments remain Lightning payments with their existing
preimage and recipient-origin requirements, and Conduit remains last.
Without a configured address, new plans retain the existing Lightning fee
rail. A malformed or wrong-network configured address blocks preparation;
it must not silently change rails. Previously funded plans are never migrated.

Before funding, approval must explain that the fixed checkout total includes
a best-effort Conduit fee estimate and payment reserves. After every commerce
leg settles, the final native amount is the exact credited checkout funds
minus the actual verified commerce debits (including outgoing fees).
It therefore includes the settled Conduit allocation and unused commerce
reserves. It cannot include another deposit, an incomplete return, an
unresolved obligation, or unverified payment history. No additional buyer
funding is requested. Receipts retain the actual transfer amount, base
allocation, unused reserves and provider fee separately.
The inbound allowance is not a cap on outgoing reserves or actual final
collection; the approved fixed funding total remains the aggregate debit cap.

The static treasury address, network, receiver identity, sender-restricted
canonical Spark request and deterministic invoice UUID are frozen before
funding exposure. The request has no invoice expiry or fixed amount; its exact
amount is frozen locally only after fresh authenticated funding, commerce,
recipient and archived-return checks. This is an unsigned canonical request
constructed from the approved address, not a claim of receiver signing.
Address rotation cannot redirect a funded plan; previously approved
destinations must remain explicitly accepted for recovery.

The pinned native adapter supports only its verified zero-fee path. A fee,
unknown capability, inadequate funds or uncertain evidence pauses this leg.
Pre-send authenticated full-history scans must contain only the exact funding,
verified commerce and separately proven net-zero closed-attempt identifiers.
Positively verified, zero-net internal Spark swaps are also permitted only when
exact SSP linkage, wallet ownership, returned leaves and value conservation are
proven; unknown transfers remain blocked.
Available and owned funds must equal the attributed remainder, with no pending
activity. Unknown history or extra funds cannot subsidize or enlarge collection.
Before admission, atomically persist the exact intent and possible-send state
and relay-ACK each required recovery snapshot. Reconcile the exact canonical
invoice and its actual provider transfer identifier after sending.
An empty lookup after possible submission never authorizes another send.
Receiver-claim completion, not a fulfill response or invoice-finalized hint,
is the payment receipt. A zero attributed remainder creates no transfer or
fabricated receipt and remains an explicit recovery state.

Commerce remains paid while final collection needs attention. Completion and
wallet retirement still require independent native settlement and safe
whole-wallet inspection. Late or unrelated deposits are not automatically
collected; recovery material stays available when retirement is not proven.
These protocol rules do not publish a new effective legal-document version.

### Lightning closed-attempt invoice renewal

Merchant recovery may obtain a fresh invoice from the same frozen Lightning
address after positively verifying that the exact old outgoing transfer closed
unpaid and its complete debit returned to spendable checkout-wallet funds.
An expired invoice, an empty history lookup, a saved `prepared` status, a generic
failure, or aggregate wallet balance alone never establishes that closure.
Payment/preimage evidence, incomplete or conflicting history, a pending return,
or a failed return blocks renewal. Independently verified commerce remains paid
when the Conduit fee alone needs attention; Conduit remains the last payout.

The initial renewal contract permits one Merchant-only replacement, generation
zero to one, after a complete return with zero historical net debit. Partial
returns and uncertain or charged historical debits remain unsupported. The
original plan, receiving destination, settled allocation, order authority and
takeover boundary do not change. The fresh invoice and its outgoing fee must
fit that allocation without borrowing from another recipient.

Renewal must archive the exact prior intent and closure observation rather than
overwrite them. The successor receives its own deterministic, generation-bound
transfer identifier; retries of that successor retain its exact invoice and
identifier. Closure metadata received through recovery is not provider proof:
fresh exact provider checks are required before committing renewal and again
before dispatch. Atomically persist the successor and history, then obtain a
recipient-inbox relay acknowledgement for the authenticated Merchant recovery
snapshot before any replacement payment. Pause, session and takeover guards
continue to apply. No renewal submits a new buyer funding payment.

Existing attempts retain their original identifiers and acquire no inferred
closure during migration. Renewed reconciliation, Merchant progress and retired
receipt records must be explicitly versioned so older clients fail closed,
stale imports cannot erase attempt history, and retirement retains the actual
winning transfer identifier. A replacement must not trigger duplicate supplier
notifications or weaken the wallet-retirement replay barrier.

Retirement must separately verify archived closed attempts against fresh exact
terminal provider history. Returned leaves need not remain spendable after the
successor consumes them; retirement-only terminal evidence cannot substitute
for the spendable-return proof needed to prepare or dispatch a successor.

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
informed that a nickname is local and not backed up, and that the local password
encrypts the recovery phrase in this browser; it is neither the source wallet's
password nor required for recovery elsewhere.

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
- exact-wrap continuation after interrupted preparation and pristine-only
  revision-checked abandonment before cart retry;
- exact fifteen-minute funding presentation/payment versus two-minute outgoing
  admission, late credit and cross-actor reconciliation;
- original signed fiat/variation and shipping evidence, authenticated live-rate
  snapshots at independently verified funding creation time, unchanged-term
  rate refresh and historical verification-key/digest preservation;
- required receiver compatibility before funding and independently verified
  supported cold partial recovery, with historical unverifiable attempts paused;
- recovery and reopen behavior; and
- content-free logs and telemetry.

Before merge, run formatting, typecheck, lint, unit tests, telemetry policy, and
the main build. Spark browser QA must cover create, fund, pay, close/reopen, and
restore on the configured deployment network. Mainnet QA must use a deliberately
small balance and payment amount.
