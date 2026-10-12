# Account wallet membership

Spark recovery material remains owned by the wallet recovery lifecycle. The
account wallet list is a separate encrypted application record, using NIP-78
kind `30078` and `d=conduit:spark:registry:v1:<network>`.

The latest signed record carries active wallet IDs, spending and receiving
choices, retained removal IDs, a revision and the previous event ID. It contains
no mnemonic. A recovery backup is evidence that a wallet can be recovered; it
does not independently authorize adding that wallet to the current account list.

Shared core discovery applies account membership in Market and Merchant. A
complete registry read excludes removed wallets from automatic restore and from
an already populated device cache, without erasing independently held recovery.
Removing every wallet leaves an empty account list on subsequent sign-in.
Explicit creation remains an action, not a consequence of an empty list.

Legacy backups without a registry remain available for explicit recovery.
Automatic restoration does not treat their presence as current membership.
The first verified registry preserves the existing primary/receiving choices.

Writes require complete bounded discovery, agreeing planned relay heads and
current signer authority. Signed encrypted bytes are retained before network
delivery and retried unchanged. Account removal waits for verified relay
read-back before committing the local removal. Partial reads, unresolved backups
or conflicting heads do not authorize replacing account state.

This is not global relay consensus or cross-device compare-and-swap. A partition
or simultaneous write can require reconciliation; observed removal history is
retained when snapshots diverge. No client can infer history that every source
has lost. Missing registry evidence therefore does not reactivate old backups.

NWC authorizations remain device-local. Account membership does not publish or
restore their credentials. Existing invoices and registered receiving addresses
remain bound to their original wallets when list membership or defaults change.

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
