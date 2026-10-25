# Custom Lightning address reconciliation

Approval, wallet ownership, public receiving lookup and profile publication are
separate evidence. A saved request phase is a resumable hint, never authority.
Activation checks current gateway approval and the selected account/wallet before
making changes. Profile publication still requires exact recovered ownership and
validated public LNURL metadata; neither proves payment settlement.

The client owns registration under the wallet/domain lock. A fresh activation
uses three recovery requests: initial ownership, the pre-registration race check,
and confirmation. The form consumes that result without a fourth display refresh.
Two ordinary lookups plus activation therefore fit the existing five-per-minute
source and identity budgets. The limit and gateway authorization rules are
unchanged. Gateway 429 replies advertise a browser-readable `Retry-After`; clients
also use a conservative minute when an older gateway omits the header.

The existing encrypted `activating` phase is retained immediately before mutation.
On restart it permits read-only reconciliation, never another registration based
on an absent or unavailable lookup. A pending custom-name provider checkpoint is
also pinned across clients. Indefinite ambiguity requires later positive ownership
evidence; availability is not proof that a previous mutation cannot still commit.
Preflight failures before mutation intent remain retryable through a deliberate
activation action. There is no automatic registration loop.

An activation action performs at most three automatic rechecks. Delays increase
from 20 to 40 to 60 seconds, or respect the provider's retry deadline. A deadline
more than a minute away stops automatic work and remains visible for manual retry.
Unmounting, account/wallet changes and Stop checking cancel the current attempt.
In-flight registration cancellation remains uncertain and is reconciled by reads.
No activation resumes merely because a component mounts.

Session-only progress distinguishes approval checking, registration confirmation,
public lookup, and profile confirmation, including throttling, invalid responses,
and exhausted retries. These fields are not written to wallet records. The wallet
does not promote an unverified recovered address to its persisted receiving address
or offer it as ready to share. A verified address can remain visible while the form
explains that profile publication is still pending. A fresh profile read recognizes
an already published address before constructing another update.

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

Sources: [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md),
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md), and
[LUD-06](https://github.com/lnurl/luds/blob/luds/06.md).
