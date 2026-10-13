# Account wallet membership

Spark recovery material remains owned by the wallet recovery lifecycle. The
account wallet list is a separate encrypted application record, using NIP-78
kind `30078` and `d=conduit:spark:registry:v1:<network>`.

The latest signed record carries active wallet IDs, retained removal IDs,
an explicit main-wallet choice, a revision and the previous event ID. It
contains no mnemonic. Recovery remains independent of account membership.

Wallet display names live in the optional encrypted `walletNames` map, keyed by
active wallet ID. Names are trimmed, nonempty and at most 80 characters. Creating
or explicitly syncing a wallet publishes its existing name when none is recorded;
renaming a signer-owned wallet retains the new name and exact signed registry
event in one transaction before delivery. Interrupted delivery remains pending
and uses the existing wallet-recovery retry. Device-only wallet names stay local.

Confirmed complete discovery applies names to existing account-owned wallets and
fresh recovery. Incomplete or conflicting reads do not overwrite local names.
Validated ancestry retains a name when a legacy successor omits it; removal wins
and drops names for removed wallets. Successors preserve other encrypted metadata
without interpreting it as membership or name authority.

This extends the existing version-1 payload and event address; it adds no event,
discovery path or recovery-material migration. Earlier strict version-1 readers
reject extended records, so old open clients must refresh before using account
sync after a name is published. Deploy the updated readers to both apps before
using name publication across them. New readers accept records without names;
missing names never erase an existing local label. Historical names can be
retained only when their signed ancestry is available, not reconstructed after
all sources have discarded it.

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

The everyday UI deliberately omits Lock. Account logout/replacement still closes
signer-owned provider sessions. The shared `lockSpark` operation remains available
to lifecycle callers and composed close/reopen tests.

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
