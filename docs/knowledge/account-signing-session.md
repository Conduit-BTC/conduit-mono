# Account signing session

Market, Merchant and shared account workflows receive the same plain
`AccountSigner` from auth or `getAccountSigner()`. It exposes a bound public key,
revision, current operation capabilities, verified event signing, NIP-44
encryption/decryption and the explicit read-only `decryptLegacy` operation.
Relay clients provide event/transport context and never own account authority.

`SessionSigner` is the common owner. It snapshots an unsigned template before
queueing, serializes key operations, applies a bounded approval deadline and
checks authority before dispatch and after completion. A changed account or
revision, changed template, invalid hash or invalid signature cannot produce an
accepted result. Failures use content-free `NostrSignerError` codes. Replacing or
retiring an owner cancels its pending operations; stale cleanup cannot retire a
newer owner.

NIP-07 retains its existing live bridge identity checks and transient readiness
retry. NIP-46 retains pairing, encrypted local session persistence, pending RPC,
route verification, draining and transport recovery. Those states describe
transport readiness; they do not grant a different account. A stored restoration
candidate and profile metadata remain separate from active signing authority.
Protected-read authorization is installed from the exact active account owner.

Shared messaging constructs and verifies NIP-59 envelopes through plain key
operations. The rumor is unsigned, its kind-13 seal is signed by its author and
the kind-1059 outer wrap uses an ephemeral key. Both signatures, the recipient,
seal shape and rumor hash/author are checked before private data is accepted.
Legacy NIP-04 decryption remains a separate read-only lane.

Guest order keys implement only the purpose-scoped plain key contract. They can
sign the bound order and seal and encrypt outbound messages, expire with the
order scope and cannot decrypt inbound messages or install protected account
reads. They are never account sessions.

Public [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) remains
v2. NIP-44 v3 readiness must remain explicit; implementation requires public
draft/client references and capability detection. This migration adds no v3
assumption or encryption downgrade.

Validation separates controlled-provider failures, local cryptographic
interoperability and mounted app lifecycle checks from real extension/mobile
prompts and remote signer delivery. Passing fixtures does not prove the latter.
Relevant references are [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md),
[NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) and
[NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md).
