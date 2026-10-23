# Complete Portable Wallet lifecycle

The account wallet lifecycle is defined by one complete encrypted record per
wallet. See [the wallet specification](../specs/wallets.md#complete-account-wallet-records).

The `conduit:portable-wallet:v1` namespace and `portableWalletAccounts` table
start empty. Previous recovery, primary/main, registry, names, Addy and address
request records are ignored. Import requires the original phrase, network and
account number and verifies the derived native identity. It does not create a
new native identity or transfer funds. Existing stored data stays untouched.

A complete record carries the recovery tuple, name, provider-verified receiving
address, preferences, lifecycle and signed address-request progress. There is no
second membership or name authority. The newest valid signed record wins per
wallet, including the NIP-01 lowest-ID tie break. Native identity checks happen
before projection. Current provider checks remain required for payments and
address activation; saved address/request metadata cannot grant approval.

Local signed bytes survive interrupted delivery. The coordinator refreshes on
sign-in, reconnect, foreground wakeup and bounded periodic retries. Actual
readback confirms storage; a prior receipt does not excuse a currently missing
copy. Valid local records survive unavailable, stale or empty sources. Signer
refusal stops background consent attempts. A foreground Continue action resumes.

A signed removal excludes a wallet from automatic opening. It does not destroy
funds or independently held recovery. Explicit seed import can reactivate it.
Checkout/order records are outside this cutover: their original wallet and
operation references remain fixed. The wallet-retention and payment-attempt
safety boundaries must continue to prevent replay or automatic reassignment.

The bounded discovery reader reports partial coverage when it reaches its
resource limits. Empty or partial results do not prove global absence. The
production storage policy remains centralized in account-storage-relay-policy.
No public relay or funded-wallet claim follows from controlled fixture tests.
