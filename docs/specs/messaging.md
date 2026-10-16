# Messaging Specification

Secure buyer/merchant marketplace messaging. Defines the shared CommerceInbox
boundary, encrypted local history, conversation and order authority, and the
delivery/recovery contract that keeps incomplete reads and failed messages
visible. The implemented behavior and remaining interoperability acceptance
gates are detailed in [Commerce inbox and recovery](../knowledge/commerce-inbox-recovery.md).

References:

- Transport and event kinds: `docs/specs/protocol.md` ("Messaging Transport: NIP-17")
- Buyer surface: `docs/specs/market.md`
- Merchant surface: `docs/specs/merchant.md`
- Privacy rules: `docs/specs/privacy-observability.md`
- External sources: `docs/knowledge/external-nostr-references.md` (NIP-17,
  NIP-42, NIP-44, NIP-07)
- Protected-read contract and rollout:
  `docs/knowledge/nip42-protected-read-rollout.md`

Non-goals: public social inbox, comments, follows, reactions, unrelated
notifications, discovery feeds, group sending, NIP-29 groups, NIP-04 sending,
message-content telemetry, and defaulting to NIP-44 v3 before public protocol
and explicit capability support exists. Durable encrypted history and the
authorized order-message companion are part of the shared inbox.

## Secure conversation types

Buyer-merchant communication is NIP-17 gift-wrapped (seal kind `13`, gift wrap
kind `1059`). The inner rumor and its validated payload determine its handling:

- **General direct message — kind `14`.** An order-independent support
  conversation between two pubkeys. Threaded by **counterparty pubkey**, not by
  order. Free-text content.
- **Private file message — kind `15`.** An encrypted attachment in the selected
  counterparty's conversation. Download requires explicit user action, bounded
  fetching, encrypted-file hash verification and authenticated decryption.
- **Order-linked message — kind `16`.** A Conduit order message threaded by
  `["order", <order_id>]` with a `["type", ...]` tag (`order`, `payment_request`,
  `payment_proof`, `status_update`, `shipping_update`, `receipt`, `message`).
  Owned by the order lifecycle (`docs/specs/order-lifecycle.md`); rendered in the
  Orders surfaces, not the general inbox.

General conversations and order actions must stay distinct in product state and UI. A general-DM thread may link
back to the counterparty's orders, and an order conversation may show a compact
order-linked preview, but a kind-14 thread is never folded into an order and a
kind-16 order message never appears as a general DM. Thread identity is also
transport-qualified: NIP-17 and legacy NIP-04 messages between the same pubkeys
are separate threads and must not be merged into one chronology.

Sending remains two-party. Additional authenticated participant tags on an
incoming message are retained metadata; they do not authorize group fanout.

### Commerce payloads and authority

Conduit remains the default named kind-16 JSON contract. Standard Market
checkout offers an explicit Open Markets numeric choice for merchants requesting
that contract; private router checkout retains its required named contract. The shared
[numeric order adapter](../knowledge/open-markets-order-adapter.md) also admits
validated Open Markets orders to Merchant review and selects numeric replies for
those retained orders. New numeric orders freeze their party-scoped format before
encrypted staging and reuse it for kind-17 Lightning payment reports and kind-14
conversation. Reload and retries preserve the exact staged encrypted bytes;
no order emits both representations. Old orders without format metadata remain
named. Neither `client` nor kind-10050 relay declarations imply format support.
Kind-17 Lightning receipts with optional preimages enter the existing verifier as
unverified claims. Numeric invoice expiration describes BOLT11 payment validity,
not disappearance of authenticated invoice history. Ordinary message/wrapper
expiration still applies. Other rails, unknown versions and incomplete terms remain explicit
evidence. No kind-1327 writer or complete cross-client conformance is claimed.

Authenticated external commerce records may be inspected, searched and associated
locally. Replies require one unambiguous authenticated counterparty. Neither
association nor a declared amount grants order
adoption, payment, inventory or fulfillment authority. Supported external orders
require explicit merchant review; missing prices or destination terms are never
fabricated. Kind-14 notes remain direct messages, with a non-authoritative order
preview only for an exact known external order and participant pair. The bounded `conduit`
version-1 extension is read only when its identity matches its surrounding
message; unknown versions remain inspectable evidence.

Kind-16 classification must be collision-safe. A reader accepts the Conduit
order-message shape only when its required Conduit payload and explicit `p`,
`type`, and `order` tags validate. NIP-18 generic reposts, which also use kind
`16`, are ignored by the order-message lane rather than rendered as orders or
failures.

### Order-message migration gate

The versioned OMF envelope remains experimental. Its implementation may proceed
using a frozen contract, explicit supported-peer selection and Conduit-owned
correctness/compatibility evidence; unrelated marketplace adoption or upstream
acceptance is not a universal implementation gate. No kind-1327 writer is enabled
by the current numeric adapter. The migration sequence is:

1. Reconcile codecs with the selected contract while preserving current reads.
2. Validate strict dual-read with semantic deduplication across legacy and new
   representations.
3. Select one supported writer using explicit capability or authenticated per-order evidence.
4. Retire legacy writes after compatibility evidence is sufficient, while
   retaining bounded legacy reads for recovery.

## Shared core boundary

Private messaging belongs to shared `@conduit/core` owners. Market and Merchant
consume shared inbox state and workflows; routes must not duplicate wrapping,
relay loops or decoding. Order and payment coordinators retain domain authority.

Delivery must durably stage exact signed bytes and authorized targets after domain
persistence checkpoints succeed and before network I/O. Recovery must reuse saved
bytes under applicable current authority. Recipient acceptance must survive optional
self-copy or local-history failure; it does not establish reading, payment or
fulfillment. The [delivery implementation and recovery rules](../knowledge/commerce-inbox-recovery.md#interoperability-and-domain-authority)
define the module boundaries, saved-plan and legacy replay paths, and self-copy
ordering.

The boundary provides:

- **NIP-44 capability seam.** NIP-44 v2 is the default wire version.
  Signer capability is probed (`window.nostr.nip44`, optional `nip44v3`) so v3
  can be negotiated later, but v3 is **source-gated OFF** as a send default until
  public draft/client references and recipient capability detection are in place.
  NWC/NIP-47 wallet traffic stays on its wallet-supported version regardless.
- **Secure-message relays (kind `10050`).** Each gift-wrap write uses only the
  wrap recipient's declared kind-10050 relays, except the bounded validated
  order compatibility lane below. NIP-65, configured relay lists, commerce
  capability order, and general relay defaults are not secure-message write
  fallbacks. The only App Relay write exception is the explicit, separately
  flagged compatibility registry for a validated kind-16 send whose completed
  bounded declaration lookup resolved to `not_observed`.
  Kind `10002` never supplies a gift-wrap write target. A `signed_empty` or
  `malformed` declaration is an explicit blocking state that the client never
  overrides with retained relay tags.
- **Authority-scoped transport.** An authenticated owner may explicitly select
  a `ws://` or `wss://` relay in Network for eligible operations on that
  owner's own account. A `ws://` URL learned from discovery, metadata, event
  hints, cached provenance, fallback configuration, or a recipient's or other
  account's declaration is never contacted automatically. A remote recipient's
  `ws://` kind-10050 tag remains declaration evidence but is filtered from
  delivery; remote `wss://` targets remain subject to the normal routing,
  evidence, validity, and exclusion rules. The executor enforces this again
  immediately before final I/O.
- **Typed routing states (`protocol/private-message-routing.ts`).** Declaration
  discovery distinguishes signed frontier states (`declared`, `signed_empty`,
  `malformed`) from bounded observation outcomes (`not_observed`,
  `lookup_partial`, `lookup_unavailable`). The state is account-scoped and backed
  by durable declaration evidence rather than process memory alone. A complete
  bounded read with no event and no retained frontier is `not_observed`, not
  proof of global absence; an all-failed lookup is `lookup_unavailable`, and a
  partial empty read is `lookup_partial`. When signed evidence is retained, the
  observation outcome degrades freshness without replacing the dominant signed
  state.
- **Monotonic declaration frontier.** The durable record stores the exact
  validated signed event and source-relay observations. Frontier selection
  follows NIP-01: greater `created_at` wins and the lexicographically lowest id
  wins a timestamp tie. Re-observation unions provenance. Only a complete
  bounded-plan observation advances the durable freshness used after restart;
  partial or unavailable fanout cannot turn retained evidence fresh.
  The latest lookup outcome is stored separately, so a later complete-empty,
  partial, or unavailable read remains stale after restart but never erases the
  signed frontier. The current resolver totally orders valid events and does not
  emit a conflict state. Conflict is reserved as a fail-closed outcome only if a
  future richer evidence model validates an internal inconsistency after
  canonical ordering. Relay-settings changes expire freshness rather than
  deleting evidence.
- **Current versus last usable.** A newer `signed_empty` or `malformed` event
  becomes the current frontier and blocks every declaration-based write. The
  last usable declared relay set remains available only for permissive inbox
  reads and recovery. Without retained signed evidence, only a completed empty
  bounded read resolves to `not_observed`.
- **Pending declaration cutover.** An unsigned draft, cancelled signer flow, or
  missing required signature changes no route and removes no recovery behavior.
  After every required event is signed and durably staged, new writes use the
  pending declaration. Each locally staged ordinary `kind:10050` replacement
  owns an independent recovery batch containing the previous valid inboxes. A
  batch's own seven-day, versioned stale-sender clock starts only after that
  replacement's exact readback from its bounded shared discovery set. Stronger
  signed evidence, including a replacement produced by another client, preserves
  every existing batch but creates none without a matching locally staged
  immutable replacement plan. Signer-free redistribution of the same exact event
  may append an inbox-only immutable confirmation attempt for the current shared
  set. Any one complete attempt starts the owning batch's clock exactly once;
  later attempts and observations never reset it. A whole-relay removal that
  policy-blocks any target leaves that historical attempt incomplete rather than
  shrinking it retroactively. A fresh signer-free attempt for the same exact
  event may complete against the then-current unblocked shared set. Recovery
  batches are not current membership and never authorize writes. Explicit
  whole-relay removal filters its URL from every batch immediately after the
  atomic local commit, before ACK or readback, accepting the warned risk of
  missing stale-client sends.
- **Cross-client declaration discovery.** Declaration publish and repair use a
  bounded shared discovery set that unrelated Conduit clients query. Repair is
  confirmed only after the exact signed event is observed from that shared set;
  process priming, durable local persistence, or owner-only readback does not
  establish cross-client discoverability. A complete shared lookup that observes
  no declaration may expose explicit same-set redistribution only for a retained
  current `declared` event. Redistribution republishes that exact signed event
  without asking the signer to mint a newer replacement. Retained
  `signed_empty`/`malformed`, partial, and unavailable observations, plus any
  future reserved fail-closed conflict, remain retry-only.
- **Permissive inbox reads.** The principal's gift-wrap read plan is the union
  of their current or pending declared inboxes, every recovery batch awaiting
  its own exact readback or still within its own seven-day grace, eligible
  retained last-usable inboxes, and the bounded Conduit compatibility read set.
  A committed whole-relay removal is excluded immediately from every batch. General NIP-65
  membership never adds an inbox read target. Wraps are deduplicated by outer
  wrapper and inner rumor ids, and found or cached messages stay visible under
  partial failure. Reads report `complete`, `partial`, or `unavailable` coverage
  and an explicit source such as `declared`, `pending_declared`,
  `cutover_recovery`, `compatibility`, `mixed`, or `cache`.
  A valid owner `kind:10050` declaration stays active for inbox reads even when
  the Conduit-local Your Relays NIP-65 layer is disabled. Neither App Relays nor
  Your Relays changes the signed declaration.
- **Signed recovery boundary.** Unpublished legacy local Network settings and
  migration records never supply inbox routes or recovery. A persisted
  singleton cutover record from the current signed protocol up-converts to one
  recovery batch without changing its relay URLs or any established readback
  and expiry timestamps.
- **Protected inbox execution.** The shared inbox path executes the principal's
  own `kind:1059`, `#p`-scoped filters through the NDK-neutral protected relay
  executor. The explicit account/session authorization boundary accepts only
  the active NIP-07 or NIP-46 signer; guest and anonymous sessions are rejected
  before connecting or signing. Public reads carry no NIP-42 account proof and
  never prompt a signer, but queried relays still see request filters and
  ordinary connection metadata. Authentication challenge/OK/retry state and
  per-relay failures are preserved as typed observations without putting
  challenge or account identifiers in logs or telemetry. Shared account/session
  signer boundaries and plain-event primitives own signing and unwrapping;
  routes do not need an NDK messaging edge.
- **Authenticated recipient writes.** A foreground signed-in NIP-07 or NIP-46
  order send may answer a recipient inbox relay's NIP-42 challenge only when
  the active account, authenticated session, event author, and auth signer all
  identify the same pubkey. The auth event is bound to the exact relay and
  challenge; after its matching positive `OK`, the writer resends the same
  already-signed gift wrap on that socket. Authentication never widens the
  recipient's exclusive relay set, installs a global relay policy, creates a
  replacement wrap, or prompts from guest/background delivery.
  Before each exact socket opens, the writer re-reads the account's durable
  relay exclusions and skips targets that are no longer eligible. Interactive
  auth prompts are serialized by signer session; a socket timeout cancels any
  visibility wait, and a dispatched signer request keeps its slot until it
  settles so a later relay cannot open an overlapping prompt.
- **Validated-order compatibility routing (temporary, CND-208).** When a validated
  kind-16 order-lifecycle send completes its bounded recipient declaration
  lookup as `not_observed` with no retained signed frontier, the write may use a
  maximum of three relays from the explicit private-inbox compatibility
  registry. `signed_empty`, `malformed`, `lookup_partial`, and
  `lookup_unavailable` cannot enter the lane. A signed recipient NIP-65 read
  list may rank matches inside that registry but cannot widen it. Kind-14
  general DMs never use this lane; a valid declaration always outranks it. A
  one-use order scope binds the rumor, order, sender, and recipient. The lane is
  recipient-only:
  the non-critical sender self-copy leg stays strict and fails soft. A
  bounded complete-empty observation never erases a retained signed frontier.
  A current `signed_empty` or `malformed` frontier still blocks the lane, and a
  current `declared` frontier still outranks it. See `docs/specs/protocol.md` and
  `docs/knowledge/nip17-inbox-bootstrap-migration.md`.

## Legacy NIP-04 read lane

Legacy NIP-04 kind-4 events have a separate, read-only recovery lane. Conduit may
fetch and decrypt them for historical access, but never publishes kind `4` and
never treats NIP-04 as a NIP-17 encryption or relay fallback. Its reads follow
the bounded legacy-read policy rather than the kind-10050 secure-message lane.

Legacy conversations remain transport-qualified as NIP-04 and are never merged
with NIP-17 threads between the same participants. Fetch, signer, and decrypt
failures must retain a retryable degraded state and provide actionable feedback
to the person accessing the affected conversation. Diagnostics remain
content-free and must not expose plaintext, ciphertext, or participant pubkeys.

## Conversation model and encrypted history

Inbox records and delivery jobs must be encrypted locally and isolated by account.
Retain encrypted wrappers before signer work and authenticate envelopes before
classification. Disconnect or account replacement must fence pending writes and
local decryptions; retained history grants no signing, protected-read or cache-write authority.
Preserve recoverable records and distinguish incomplete history from a complete
bounded observation. The [persistence and recovery contract](../knowledge/commerce-inbox-recovery.md#persistence-and-recovery)
specifies encryption, migration, paging, suppression and retained-account access;
[conversation identity](../knowledge/commerce-inbox-recovery.md#interoperability-and-domain-authority)
uses transport plus counterparty.

## Degraded and retry behavior

Messaging state must distinguish these outcomes. A person using an affected
conversation must not see a falsely complete empty result or lose an available
retry or repair path. Detailed relay and decrypt diagnostics may live in
Network, recovery, or diagnostic surfaces:

- **Loading** while the first read is in flight.
- **Stale / degraded** from the shared snapshot's coverage and freshness evidence,
  including retained views when the signer or relay sources are unavailable.
- **Not ready / relay unavailable** when the required principal or recipient
  kind-10050 declaration is absent or its declared relays are unusable. Do not
  hide this state behind NIP-65 or an unnamed configured-relay fallback. A
  validated kind-16 send may report the named compatibility route only for
  `not_observed`; this does not make the recipient NIP-17-ready. Distinguish
  lookup failure (`lookup_partial` / `lookup_unavailable`, retryable), bounded
  complete-empty discovery (`not_observed`), a signed no-inbox frontier
  (`signed_empty`), and structurally unusable signed evidence (`malformed`).
  Setup and repair are owned by the Network surface; Messages/Orders can direct
  the affected person there instead of publishing declarations. A stale
  retained signed state remains retryable; retained last-usable relays are
  historical evidence rather than current write targets. Hidden cutover recovery
  never appears as current membership or authorizes writes. Only complete shared-empty
  discovery exposes explicit redistribution of an
  unchanged declaration.
- **Waiting / failed / unsupported** distinguish signer unavailability or refusal,
  provider timeout, invalid envelopes, decryption failure and recognized commerce
  that cannot yet be decoded. Retain wrappers and retry eligible records without
  requiring a full refetch. Permission refusal pauses recovery; queue waiting is
  separate from provider execution time. Unresolved provider work retains its
  signer slot, and late results cannot write into a replacement account/session.
  Changed decoder rules can recover retained records without network refetch.
- **Empty** as a distinct terminal state from loading and error.

An empty result describes only the bounded read and history actually attempted.
Every required relay attempt must reach successful EOSE with no unresolved auth,
connection, protocol or decoding failure; attempted partial or capped history
cannot imply completeness. EOSE is not proof of global historical absence.
One success plus one auth or transport failure is degraded/partial;
all failures are unavailable. Cached conversations remain visible as
stale/degraded in either case. An auth rejection, missing challenge, signer
failure, `restricted:` close, or reconnect failure must never render "No
messages" or "No orders" by itself.

Raw Nostr event detail (gift-wrap ids, seal internals, ciphertext) must not be
the primary UX. Prepared conversation state is rendered instead.

## Privacy

Exported diagnostics, logs, telemetry and analytics must exclude message content,
ciphertext, plaintext, order contents, invoices, payment hashes, shipping/contact
data, NWC URIs, signer secrets, pubkeys, event/order identifiers and account-relay
mappings. Account-local UI may use identifiers needed to inspect or retry a
record; that does not authorize exporting them. Diagnostic summaries contain
only coarse categories, counts and retry state. This follows
`docs/specs/privacy-observability.md` and the commerce inbox recovery note.

Protected-read diagnostics additionally exclude NIP-42 challenges, auth events,
signatures, full filters, authenticated socket material, and stable
account-derived session identifiers. Auth capability claims must distinguish
untested, NIP-11-advertised, challenge-observed, succeeded, and
rejected/unavailable evidence. NIP-11 advertisement is not proof of successful
authentication or recipient enforcement.

Shared acceleration, cache, index, and routing infrastructure may derive only
from relay-visible state and must never expose a hidden API for private message
content or ciphertext, order contents, payment or invoice data, signer or auth
material, wallet credentials or recovery material, or wallet balances.

## Validation / testing

- Classify direct, file, Conduit and numeric Open Markets commerce, unsupported,
  malformed, machine and unrelated records without granting domain authority.
- Keep signer waiting/refusal, timeout, invalid-envelope and decode outcomes
  distinct; recover eligible retained wrappers without a full refetch.
- Persist encrypted projections, resumable legacy migration, read state and
  per-relay history across restart. Account changes fence late results; partial
  and capped history remains incomplete while valid messages stay visible.
- Stage exact bytes after domain persistence and before network delivery.
  Recipient ACK survives self-copy or projection failure. Generic resume skips
  acknowledged targets; explicit receipt replay requires fresh delivery evidence.
- Resolve NIP-17 writes exclusively through the recipient kind-10050
  declaration; only validated kind-16 order sends with a completed
  `not_observed` lookup and no retained signed frontier may use the flagged
  bounded compatibility plan. Signed-empty, malformed, partial, unavailable,
  and kind-14 cases are excluded. One relay ACK is a successful partial
  delivery; zero ACKs is an explicit failure.
- Allow an authenticated owner's explicit new or existing Network `ws://`
  selection for eligible operations on that owner's account, with informed
  owner approval of the unencrypted transport risk. Filter remotely learned,
  recipient, and other-account `ws://` URLs again at final I/O while leaving
  otherwise eligible remote `wss://` routes unchanged.
- Declaration discovery separates `not_observed`, `lookup_partial`,
  `lookup_unavailable`, `signed_empty`, and `malformed`; permissive reads keep
  retained and partial results visible with coverage and source provenance.
- Retained evidence survives restart and settings changes, follows NIP-01
  frontier ordering, and cannot be erased by complete-empty, partial, or
  unavailable observations.
- A newer `signed_empty` or `malformed` frontier blocks writes while the last
  usable declaration remains read-only recovery evidence.
- Declaration repair confirms the exact signed event through the bounded shared
  discovery set rather than accepting local priming or owner-only readback.
- Partial and unavailable declaration observations do not advance durable
  complete-plan freshness across restart, and later degraded lookup evidence is
  retained. Complete shared-empty discovery may permit exact-event same-set
  redistribution; it never signs a new replacement. Partial or unavailable
  observations and any future reserved fail-closed conflict do not authorize
  it.
- Capability detection reports v2 as default and keeps v3 gated off.
- Send helper emits the correct rumor kind and tags for each conversation type.
- Legacy kind-4 events are read-only, never published, and remain in
  transport-qualified threads separate from NIP-17.
- Kind-16 parsing preserves validated Conduit reads and compatible numeric
  Open Markets reads and explicitly selected writes, rejects NIP-18 generic repost
  collisions, and preserves saved per-order format and exact recovery bytes.
  Kind-17 receipts do not authorize payment or order adoption. Only the exact
  locally selected buyer order projects its merchant's common status reports
  into buyer-facing confirmation and fulfillment; Merchant settlement gates remain.
- General conversations group by transport and counterparty pubkey.
- No message text or encrypted payload reaches any telemetry/log path.
- Slow/missing relay readback still leaves cached conversations understandable.
- Public reads never call the auth signer; protected reads accept NIP-07 and
  NIP-46 and reject guest/cross-recipient filters before connection. When a
  current challenge exists, they authenticate, wait for the matching `OK`, and
  retry with a new subscription id. Under `when_challenged`, a relay that sends
  no challenge may complete the initial protected request without NIP-42.
- Deterministic relay tests cover challenge timing, negative/unrelated/missing
  `OK`, signer failures, reconnect, bounded challenge loops, `restricted:`
  responses, multi-relay partial success, account isolation, cleanup, and the
  complete-empty versus unavailable distinction. The canonical matrix lives in
  `docs/knowledge/nip42-protected-read-rollout.md`.
- Foreground auth-required recipient writes sign one relay/challenge-bound
  NIP-42 event, wait for its matching positive `OK`, then resend the exact gift
  wrap. Tests reject cross-account authority, changed challenges, invalid auth
  events, background prompts, stale relay admission, overlapping signer
  requests, fallback widening, and replacement-wrap retries.

Deterministic tests do not establish real signer/client interoperability,
physical-device recovery, relay delivery or payment acceptance. Those remain
separate maintainer-owned gates in the commerce inbox recovery note; updating
this specification does not activate a compatibility exception or new writer.
