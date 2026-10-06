# Commerce inbox and recovery

`CommerceInbox` owns private-message ingestion in `@conduit/core`. Market and
Merchant Messages, Orders and Network consume the same account-fenced snapshot.
Order lifecycle and payment coordinators retain authority over commerce actions.

## Persistence and recovery

Persist the signed encrypted wrapper before scheduling signer work. A device-local,
nonextractable AES-GCM key protects normalized records and exact delivery jobs in
IndexedDB. This key grants no Nostr signing authority. Every access requires the
current account session; disconnect and account changes fence pending commits.
The retained account may read existing device-encrypted projections while its
signer is unavailable. Those views remain stale with unavailable relay coverage;
they grant no signing, publishing, protected-read, or cache-write authority.
This keeps existing order delivery retries reachable under their separate exact
delivery authorization. Account changes also fence pending local decryptions.

Legacy plaintext message/order caches migrate into encrypted projections in
resumable transactions. Read markers and existing order delivery recovery remain
available. Storage failure is visible and cannot imply a durable queued send.
Wrappers retain decode state and rules version so parser upgrades can recover
unsupported or previously rejected messages without requesting them again.

NIP-17 uses the declared inbox plan; legacy NIP-04 incoming and outgoing reads
use the established bounded legacy plan, including eligible general/personal and
fallback relays. These plans remain separate for recent reads and older pages.

Recent reads and demand-driven older pages use the protected reader and isolated
NIP-42 executor. Per-relay overlapping inclusive ranges deduplicate wrapper IDs.
A changed saturated or incomplete recent window invalidates that source's older
cursor and restarts paging from the newest range, retaining all prior wrappers.
A device-local fingerprint avoids repeatedly restarting an unchanged recent
window. Versioned range writes prevent an in-flight older page or another tab
from overwriting the restart. Existing cursors without this metadata are repaired
on their next saturated or incomplete recent read. These checks are scoped to
the account, relay and transport; they do not establish global relay completeness.
Partial and capped pages retain valid signed positive observations without
advancing the cursor. Capped equal-timestamp pages retain unresolved range evidence; an empty or short
page describes that bounded observation, not global historical absence.

Signer queue waiting is separate from active provider time. Permission refusal
pauses recovery. Provider timeout holds ownership of unresolved provider work;
late results cannot write into a replacement account/session. History admission
is bounded so user-initiated operations can proceed between decrypt requests.

Expiration and authenticated deletion suppress projections without destroying
retained originals. Ciphertext remains device-local until explicit cache removal.
Re-decoding or late pages must honor suppression. Clearing this device is not
evidence that a relay removed a message. No automatic relay backup is performed.

## Interoperability and domain authority

Writes use canonical empty-tag NIP-59 seals and public NIP-44 v2. Envelope,
recipient, seal/rumor author and supplied rumor-hash checks remain mandatory.
Authenticated participant metadata is retained for reading. Sending remains
two-party: replies and attachments target the selected counterparty only, and
extra incoming recipient tags cannot authorize fanout. Conversation and read-state
identity use transport plus counterparty, so two-party replies remain with their
incoming messages even when those messages carry extra participant metadata.
Self-authored external
commerce records require one unambiguous authenticated recipient for replies.
Kind-15 AES-GCM downloads require
an explicit user action, a bounded stream, encrypted-file SHA-256 verification
and authenticated decryption. Optional size and original-file hash are checked
when supplied. Attachments are not fetched merely by opening a conversation.

Shared codecs read Conduit named JSON histories and current Open Markets
numeric-tag kind-16 messages and kind-17 receipts. Normal order operations retain
the deployed named kind-16 JSON grammar. A numeric writer requires an accepted
migration contract and explicit recipient capability evidence before activation.
The bounded `conduit` version-1 extension is read only when its identity agrees
with the surrounding message. Unknown versions remain inspectable evidence.
Kind 1327 is not a default writer.
NIP-44 v3 selection requires a public contract and explicit capabilities; v2
remains the implemented default.

Authenticated external commerce can be searched, inspected, associated locally
and replied to. An association or declared amount does not authorize payment,
inventory, fulfillment or order adoption. Recovery credentials reach the dedicated
consumer before generic rendering and are excluded from general search.

Private attachments reject files larger than 8 MiB before allocating file bytes.

Signed bytes and the authorized relay plan are staged before delivery I/O, after
caller-owned pre-publish persistence callbacks succeed. A rejected persistence
callback must leave no generic delivery job that can bypass that boundary. Retry
replays those bytes against saved targets and stronger current refusal evidence.
Concurrent acknowledgements merge atomically. A relay ACK describes delivery;
it does not prove the recipient read the message or paid an order. Initial-order
first-ACK completion, guest merchant-only scope and existing routing-lane rollout
controls remain owned by their established coordinators. Initial-order self-copy
routing, signing and staging run only after the recipient ACK is durably committed.

## Bounded client-seal metadata compatibility

- Name: `client-seal-metadata-read`
- Status: proposed implementation, pending maintainer runtime sign-off
- Canonical target: empty seal tags, as specified by NIP-59
- Owner: private messaging maintainers
- Started: 2026-10-03
- Review checkpoint: before production activation, then each supported-client review
- Rollout control: reviewed client build and normal deployment approval
- Activation state: local candidate; no production activation established here

Some clients attach a `client` metadata tag to a valid signed seal. The reader
accepts at most one such tag, with two through four fields and at most 512
characters per field. Other tags, including routing/domain tags, remain invalid.
This is a read compatibility rule. Writers continue to emit empty seal tags.
All cryptographic and identity checks complete before compatibility is counted.

Synthetic fixtures prove canonical/tagged acceptance and tamper rejection through
the production envelope implementation. These fixtures do not establish the
affected real account's failure distribution or an independent client's current
behavior. Maintainer validation must record that separately before activation.

The account-local diagnostic `clientSealMetadataAccepted` counts retained wrappers
that opened through this rule. `received` is its retained-wrapper denominator;
both describe the current device cache, not a global client population or a timed
telemetry window. No content, ciphertext, identifiers or account-to-relay mapping
is exported. Fleet measurement requires a separately reviewed allowlist change.

Removal requires a reviewed change, real-client evidence for the supported-release
window and proof that retained historical wrappers remain recoverable. A zero
counter on one device cannot authorize removal. Renewal or widening requires
explicit fixture evidence and review; there is no silent expiry. Rolling back a
build does not erase retained ciphertext. Never delete encrypted history to make
a compatibility counter disappear.

## Diagnostic evidence

NIP-04 and NIP-17 retain separate outcome counts. Recent reads expose source,
transport, observation time, AUTH, coverage and malformed/unusable counts from
the protected executor. History exposes the durable range status and observation
time. Relay labels stay in the authenticated account-local snapshot; the export
contains only session-local source indexes and aggregate evidence. A new session
has no recent-read observation until a read occurs. Retained history timestamps
do not imply a fresh successful relay read.

## Validation boundary

Composed tests cover real cryptographic envelopes, encrypted reload, storage and
worker claims, signer scheduling, paging, exact delivery replay and domain fences.
The browser journey uses synthetic identities with genuine NIP-44/NIP-59 crypto
through a controlled NIP-07-shaped provider and a local AUTH relay. Browser
emulation cannot prove real extension prompts, NIP-46 behavior, physical software
keyboard/scroll behavior or live relay history.

Required candidate validation includes the affected account, independent-client
bidirectional messaging/common commerce, real NIP-07/NIP-46 signers and physical
mobile interruption/recovery. Keep identifiers and content in authorized local
inspection. Report exported evidence as aggregate outcomes and explicit gaps.

Public references: [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md),
[NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md),
[NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md),
[NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md), and the
[Open Markets specification](https://github.com/OpenMarketsFoundation/specification/blob/main/README.md).
