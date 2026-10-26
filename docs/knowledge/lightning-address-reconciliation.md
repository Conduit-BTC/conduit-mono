# Custom Lightning address reconciliation

Approval, wallet ownership, public receiving lookup and profile publication are
separate evidence. A saved request phase is a resumable hint, never authority.
Activation checks current gateway approval and the selected account/wallet before
making changes. Profile publication still requires exact recovered ownership and
validated public LNURL metadata; neither proves payment settlement.

The client serializes registration under a wallet/domain lock within one browser
origin. A fresh activation uses three recovery requests: initial ownership, the
pre-registration race check, and confirmation. The form consumes that result
without a fourth display refresh.
Two ordinary lookups plus activation therefore fit the existing five-per-minute
source and identity budgets. The limit and gateway authorization rules are
unchanged. Gateway 429 replies advertise a browser-readable `Retry-After`; clients
also use a conservative minute when an older gateway omits the header.

The existing encrypted `activating` phase is retained immediately before mutation.
On restart it permits read-only reconciliation unless the client, under the same
wallet/domain lock, finds an exact `selected` checkpoint retaining this origin's
known non-submission or definite rejection. Only a deliberate activation action
can retry that registration, after fresh approval and account/wallet authorization.
An absent or unavailable lookup never grants retry permission. A missing,
different-name, or `registering` checkpoint leaves the retained intent read-only.
A pending custom-name provider checkpoint is pinned across clients.
Indefinite ambiguity requires later positive ownership
evidence; availability is not proof that a previous mutation cannot still commit.
Preflight failures before mutation intent remain retryable through a deliberate
activation action. There is no automatic registration loop.

Browser locks and checkpoints do not coordinate separate origins or devices.
An older local `selected` checkpoint cannot disprove another origin's uncertain
submission, even when both origins have the same saved `activating` request.
This change does not add cross-device registration arbitration or a provider
idempotency guarantee; cross-device consistency still needs provider validation.

An activation action performs at most three automatic rechecks. Delays increase
from 20 to 40 to 60 seconds, or respect the provider's retry deadline. A deadline
more than a minute away stops automatic work and remains visible for manual retry.
Unmounting, account/wallet changes and Stop checking cancel the current attempt.
In-flight registration cancellation remains uncertain and is reconciled by reads.
No activation resumes merely because a component mounts.

Session-only progress distinguishes approval checking, registration confirmation,
public lookup, wallet persistence, and profile confirmation, including throttling,
invalid responses, and exhausted retries. These fields are not written to wallet records. The wallet
does not promote an unverified provider response to its persisted receiving address
or offer it as a wallet-generated public-profile suggestion. Suggestions still
require current public verification. An already saved selection is displayed and
may be copied with its separate availability status, even during provider failure.
A later unavailable lookup does not erase an independently published profile
address. A verified address can remain visible while the form explains that
wallet persistence or profile publication is still pending. The workflow exposes
the verified result before either metadata or checkpoint signing/storage write;
a failed write remains an error and leaves registration intent resumable. A retry
rechecks ownership and public receiving without replaying an uncertain registration.
A fresh profile read recognizes an already published address before constructing
another update.

Accepting verified activation retires older wallet-row receiving observations,
including an explicit receiving-address Retry. Late default-domain results,
unavailable results, and errors cannot replace that verified display. The resolver
also checks observation retirement before queuing address metadata. Retirement
does not cancel or replay a provider operation; it only prevents stale results
from being accepted. Later deliberate or runtime-driven observations remain allowed.
If an older observation was already queued after failed background persistence,
a successful explicit address save retires that captured queue entry within the
wallet sync coordinator. Failed saves preserve prior pending intent; observations
received during the save remain queued. This does not automatically retry a refused
activation write or repeat registration.

## Saved selection and provider availability

The complete encrypted wallet event is the source of the selected receiving
address. Read and validate it before provider discovery, including before the
provider session opens. A saved `registered` or `complete` custom-name request
retains that selection even if historical `lightningAddress` metadata contains a
default-domain observation. This is selection evidence, not current registration
authority, public lookup verification, profile freshness, or payment settlement.

Ordinary reads of a saved address check only its selected domain without
registration. Missing, unavailable, throttled, unverified, and conflicting provider
responses retain the selection and display an availability notice. Failure to read
the saved record is unknown state, not permission to discover and persist a fallback.
No new plaintext address cache or event schema is introduced. Wallet/account
retirement cancels acceptance of pending reads, and a second saved-record read
prevents a result started before a new selection from queuing old metadata.

Provider observations may fill an empty wallet address, but cannot replace a saved
selection in the sync writer. This applies to an observation queued during an
explicit save as well as one queued before it; explicit workflow updates remain
the path for changing selection. Relays can still supply a newer valid complete
record according to the existing event reconciliation rules.

The finished card shows the selected address once, with Copy/Share and a separate
current-profile comparison. Completed name-request controls disappear. A differing
profile remains visible and a deliberate profile update still requires verified
receiving evidence; Manage address exposes the existing public-profile editor.
Unfinished activation and failed saved-request reads retain their recovery controls.

Controlled UI evidence (synthetic account, no live wallet or signer data):
[desktop](images/wallet-address/finished-desktop.png) and
[mobile](images/wallet-address/finished-mobile.png). The saved-address browser
regression exercises the actual controller, encrypted storage and reload path
separately, with a cryptographic test signer and a controlled provider.

The persisted request schema and phase meanings are unchanged. Legacy `activating`,
`registered`, and `complete` records remain readable; no wallet-event version or
migration is introduced. New transient progress cannot make an older strict wallet
reader reject a record. `registered` continues to mean that ownership and public
lookup passed before profile publication was attempted.

Controlled regression tests compose the workflow with the signing client and,
separately, the actual gateway limiter and authority checks. Browser fixtures cover
countdown, cancellation, account/wallet replacement and profile recovery. These
tests do not establish installed-signer behavior, production rate-limit incidence,
relay retention, or live receiving/settlement. A reproduced 429 mechanism does not
identify an earlier production failure whose response was not captured.

Sources: [NIP-78](https://github.com/nostr-protocol/nips/blob/master/78.md),
[NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md),
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), and
[LUD-06](https://github.com/lnurl/luds/blob/luds/06.md).
