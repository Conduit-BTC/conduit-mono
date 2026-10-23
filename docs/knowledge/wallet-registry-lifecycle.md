# Account wallet membership

Spark recovery material remains owned by the wallet recovery lifecycle. The
account wallet list is a separate encrypted application record, using NIP-78
kind `30078` and `d=conduit:spark:registry:v1:<network>`.

The latest signed record carries active wallet IDs, retained removal IDs,
an explicit main-wallet choice, a revision and the previous event ID. It
contains no mnemonic. Recovery remains independent of account membership.

Wallet display names use a separate encrypted NIP-78 record at
`d=conduit:wallet-names:v1:<network>`. The v1 membership payload remains unchanged.
The name coordinate is outside `conduit:spark:*`, which deployed recovery readers
interpret as recovery evidence. Older clients ignore names and continue their
existing membership, main-wallet and removal lifecycle. Their membership writes
do not replace the name record. The protected reader and publisher accept only
these exact network-scoped coordinates with current account authorization.
The governing name scope, signer plaintext boundary and offline behavior are
defined in [the wallet specification](../specs/wallets.md#wallet-names).

Names are trimmed, nonempty and at most 80 characters. Rename commits the local
label and account/network-scoped pending intent in the same wallet transaction,
before relay discovery or signer consent. The name stays usable during outages,
denial and reload. Name sync has its own pending status and retry action; it does
not change backup readiness or require users to save recovery details again.
Device-only names remain local. Creation and explicit recovery sync seed existing
local names only when no shared name is recorded.

Complete confirmed membership determines which names can be applied or published.
After backup and membership writes, recovery discovers membership again before
name synchronization and readiness calculation. A pre-write snapshot cannot
override a confirmed wallet addition.
Incomplete, conflicting, malformed or stale name observations preserve local
labels. A pending local intent fences older confirmed names until synchronization
completes. Names never add membership; confirmed removal dominates retained names
and discards pending names for that wallet. Absence from active membership alone
preserves pending intent and prevents name readiness; only explicit removal can
discard it. Missing names never erase a label.
Optional metadata failures cannot invalidate otherwise usable recovery evidence.

Before publication, agreeing bounded name reads supply the parent record. The
signed encrypted successor and frozen targets are retained before the first send.
Interrupted delivery retries those exact bytes. A newer local rename keeps its
own token and cannot be cleared by an older delivery completion. A conflicting
remote successor prevents stale publication and retains local intent for repair.
Name delivery is confirmed only by fresh exact head readback from every frozen
target. This is bounded evidence, not cross-device compare-and-swap or global
convergence. No recovery material or database schema is migrated.

Shared discovery applies this record in Market and Merchant. A complete registry
read excludes explicitly removed wallets from automatic restore and the device
cache without erasing independently held recovery. Removing every wallet leaves
an empty account list on subsequent sign-in. Explicit creation remains an action,
not a consequence of an empty list. Locally owned wallets awaiting a membership
addition remain usable and eligible for retry with the same wallet ID.

Spending and receiving defaults remain device-local and work during relay
outages. Automatic sync never overwrites an existing local choice. Only the
explicit main-wallet synchronization action seeds choices on a fresh device.
Existing invoices and receiving addresses retain their original wallet authority.
NWC authorizations and their credentials remain device-local.

Writes require complete bounded discovery, agreeing planned relay heads and
current signer authority. Signed encrypted bytes are retained before network
delivery and retried unchanged. Registry delivery requires fresh accepted exact
read-back from every planned target; exported recovery never bypasses it. Backup
durability keeps its separate two-operator or acknowledged-export rule. A pending
backup sync does not disable a usable locally owned wallet.

Account removal waits for verified registry read-back before committing the
local removal. A locally retained removal remains pending after reload until
its exact signed event reaches every frozen target. Explicit recovery retry
delivers that event before signing a successor. Previously confirmed removals
remain effective while newer delivery is pending or sources are unavailable.
Partial reads, unresolved backups or conflicting heads do not
authorize replacing account state.

## Legacy registry bootstrap

This bounded migration lane preserves automatic recovery for valid pre-registry
Conduit backups. It requires complete agreeing discovery, validated signatures,
matching account/network/native wallet identity, no prior observed registry,
and validated local removal history. It publishes and verifies one encrypted
account snapshot before attaching recovered wallets. Unresolved Addy backups
still require their original network and account number.

Once a registry exists, it is authoritative for remote restoration. Old backups
do not add removed wallets back. Known removal history survives bootstrap and
later snapshots; an empty current registry stays empty.

The shared wallet maintainers own this preview migration lane. Review it before
production rollout. The per-account exit condition is positive registry evidence;
removing the lane globally requires maintainer verification that the supported
legacy cohort has migrated or been explicitly retired. Controlled evidence counts
attempted/ready bootstrap outcomes without publishing account identifiers or
recovery contents. No new telemetry is introduced.

This is not global relay consensus or cross-device compare-and-swap. A partition
or simultaneous write can require reconciliation. No fresh device can infer
removal history that every source has lost or that was never published or carried
from another device. Complete reads describe coverage of the bounded plan.

## Opening and recovery

Verified migration retains the exact password-encrypted envelope as a fallback,
alongside signer-backed recovery. Ordinary automatic opening does not retire
that envelope. The previous-password path remains available when that envelope
exists; an envelope erased by an older build cannot be reconstructed.

Descriptor reloads reconcile runtime with the live native session at commit time.
If another consumer opens a wallet while credential reads are pending, the card
shows Ready with an unknown balance until the balance observation arrives. A close
invalidates previously sampled ready state. Pending backup or name synchronization
does not mark an already open native session as closed.
An error from an earlier denied opening cannot hide a later confirmed native
session. Current balance errors remain visible; the live session does not erase
those failures or invent a balance.

The everyday UI deliberately omits Lock. Account logout/replacement still closes
signer-owned provider sessions. The shared `lockSpark` operation remains available
to lifecycle callers and composed close/reopen tests.

## Partial recovery and local repair

Recovery access and account membership have different evidence requirements.
A validated, owner-signed membership snapshot can restore its active wallet
while some relays are unavailable. Known removals, conflicting membership,
unusable signed evidence and account replacement still fence automatic restore.
Partial restoration does not apply account defaults or claim confirmed delivery.

Explicit phrase import validates the phrase, configured network, Spark account
number and native identity, then persists verified signer-encrypted local recovery.
It does not require a complete relay read. Matching verified backups retain their
opaque registration ID; repeated imports reuse the existing local signer wallet.
Known account removals keep their old registration IDs retired; explicit phrase
recovery may create a new registration for the same native wallet without erasing
removal history. Conflicting active registrations require account review.
Unrelated malformed recovery evidence stays retained, without vetoing an
independent phrase import. Import does not infer account absence, select a main
wallet, replace a primary pointer, publish account membership or change a public
receiving destination on incomplete evidence. Backup delivery remains pending.
Automatic new-wallet creation and account mutations retain their stronger gates.
Complete, valid empty account membership permits an explicit creation or import
to publish a new backup and membership entry. An empty list must not permanently
leave that new registration pending; partial or uncertain evidence still cannot
authorize account writes.

An older build may have retained an unexplained `unresolvedObserved` warning.
Retry alone preserves that warning. The explicit **Repair saved recovery state**
action acknowledges it only after verifying a usable signed backup and consistent
recovery: either the bounded plan completes, or positive signed account membership
is available. Empty, malformed or conflicting observations cannot authorize repair.
This is a device-local acknowledgement, never proof of global absence.

Repair compares the entire checked journal in one account-fenced transaction.
It preserves signed event bytes, credentials, removals, exclusions and pending
name/address work, and records the verified backup reference in
`legacyUnresolvedRepair`. A concurrent journal change aborts repair. New
owner-authenticated malformed observations retain an `unresolvedEventId`; legacy
repair cannot clear that evidence, even if a later relay read omits it. Phrase
import remains the independent access path while account recovery needs attention.
No recovery content or identifiers are added to diagnostics or telemetry.

Opening a signer-backed wallet uses the owning signer directly, including after
account replacement and when an encrypted password fallback remains. A rejected
signer open can expose the retained fallback explicitly. Recovery details also
retain the previous-password choice. Password-only device wallets keep their
existing unlock path; switching identities never converts a signer wallet to a
password wallet or grants another identity access.

Controlled coverage uses generated test identities, actual NIP-44/signature and
native identity checks, local relays, isolated databases and a controlled provider.
It does not establish installed-signer consent, physical-device behavior, public
relay durability, provider activation or funded settlement. Those remain
maintainer-owned validation.

## Deployment evidence

Hosted mainnet wallet builds require the public Breez client configuration in
each app's Pages environment. A configured Market project does not configure
Merchant. Repository feature enablement and a successful build do not establish
provider registration, settlement or cross-device recovery.

Name-request previews can show the finished interface without accepting real
requests. Production submission additionally needs the deployed gateway, real
database bindings/migrations, Turnstile configuration, allowed origins and the
signed status endpoint. Those are operator validation requirements, not evidence
provided by controlled transport tests.

## Explicit additional-wallet creation

The Create wallet action is distinct from automatic discovery and explicit phrase
restore. It does not substitute a discovered wallet for the requested new wallet.
Partial or unavailable unrelated sources do not veto this explicit operation.
Automatic recovery and account pointer changes retain their stronger evidence gates.

Before native initialization, the existing wallet transaction retains the descriptor
and verified signer-encrypted credential with a device-local `creationPending` marker.
Failure, reload, or interrupted relay backup resumes that exact identity. Multiple
unfinished identities require review; retained removals and conflicting backups
cannot be silently bypassed. Account/session replacement fences asynchronous work.
The marker clears only after the setup surface acknowledges recovery export; a
failed acknowledgement write leaves the identity resumable.

Additional creation preserves existing defaults. Incomplete discovery neither
selects another wallet nor changes account primary/default pointers. The setup
surface reports native usability, retained/exported recovery and optional account
synchronization separately. Recovery export remains required before inviting funding.

Automatic public-address defaults additionally require verified first-wallet evidence
from before creation. An empty device wallet list or a complete read of an unresolved
registry cannot establish that evidence. Additional creation under uncertainty leaves
the public profile unchanged and offers an explicit address choice instead.
