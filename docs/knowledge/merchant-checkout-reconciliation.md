# Merchant checkout reconciliation

The capability-enabled Merchant recovery surface composes separate sources
of evidence. It is not a second payment engine.

1. Declared-inbox discovery finds signed checkout recovery envelopes and the
   authenticated buyer order. An exact order witness binds the private saved
   plan to that order. Discovery does not initialize Spark or prove payment.
2. As soon as authenticated order and source evidence is available, a bounded
   read-only check can observe an exact ordinary receiver invoice settlement.
   This does not initialize Spark, claim funds, confirm this checkout paid, or
   unlock fulfillment. It is informational until native checkout evidence joins it.
3. An isolated query-only adapter can read exact native funding and payout
   evidence immediately, without calling wallet initialization or changing
   privacy. Only jointly verified native debits and recipient attribution can
   confirm commerce before handoff. Receiver receipts alone remain informational.
4. After the signed shopper handoff time, an active, visible Merchant session
   checks the exact funding receive and existing frozen payout IDs. Opening the
   SDK can claim pending inbound funds, even when no outgoing payment is sent.
5. Separate provider-attested facts, joined to device-local invoice-origin or
   independently verified receiving-provider evidence, project recipient
   payment truth into Merchant Orders and Home.
   Imported buyer progress, a funded wallet, and a generic order status are not
   substitutes for completed required commerce payouts.

## Scheduling and cancellation

The Core reconciliation worker retains at most 512 coarse candidates and runs
one operation at a time. New history pages replace its candidate snapshot; a
changed or removed candidate invalidates the old operation's result guard.
Pending or unavailable work retries with bounded backoff. A retired wallet is
not reopened. History-only mode stops repeated checks after verified commerce;
automatic payout mode keeps an unfinished Conduit leg scheduled independently.

The Merchant adapter explicitly opts into immediate receiver observation. The
shared worker otherwise retains its handoff-first default. Pre-handoff retries
are bounded and still wake at the frozen takeover boundary. Only independent
receiver checks and the separate query-only native adapter can run early. Every
claim-capable initialization, ordinary recovered-wallet history inspection,
invoice preparation and send remains behind takeover.

The immediate native adapter is source-audited against exactly Spark SDK 0.13.0.
It uses only the public inert constructor with a prederived, exact-identity
authentication signer and allowlisted getters; it never invokes initialization,
sync, privacy mutation, leaf derivation, claims, invoices or sends. Upgrades must
be re-audited and otherwise fail closed. The authenticated recovery callback
rechecks the exact buyer order, frozen signed sources, wallet identity and saved
revision. The shared credit and exact-invoice debit validators record independent
financial facts only. No outgoing intent, payment-state transition, treasury
collection or retirement is advanced. This source audit and offline operation
traces do not establish a funded-provider or mobile lifecycle guarantee.

A candidate whose next send lacks independent recipient evidence pauses with
`recipient_unverified`; provider-paid history lacking recipient attribution
also pauses once all relevant invoice payments have been observed. Polling
cannot create that missing evidence. A changed signed candidate or manual
worker restart can recheck it, but this status never claims commerce completion
or wallet retirement. Unprepared later legs remain eligible for ordinary
advancement, and an optional fee does not undo verified commerce.

The app adapter requires an authenticated order witness before opening a wallet.
Both provider helpers re-read the selected recovery through the strict signed
inbox route, verify the pinned wallet identity, and compare the recovery sender
with the witness's buyer. No compatibility inbox route grants wallet authority.

Visibility changes, account changes, unmount, and manual recovery actions stop
new automatic work. An in-flight provider call may not be physically cancelable:
its active-session guard prevents subsequent work or persistence, but does not
undo a claim already made by SDK initialization. Cleanup is drained before a
manual action starts. A timeout must not release an unresolved operation and
launch another wallet session alongside it.

The capability-enabled Orders surface starts eligible foreground recovery automatically.
Opening that page can prepare and send remaining payments after the frozen
handoff time; it is not a read-only wallet inspection. Managed mainnet preview
and production builds enable this through the shared Quantum Router capability.
Local fee destinations, provider compatibility and accelerated timing remain
separately development/loopback-gated; see [deployment capability](quantum-router-deployment.md).
The reusable panel's automatic-start input defaults to false; only the
capability-enabled Orders route opts in.
This does not change order, payout, recipient or provider authority checks.
The selected order shows one payment card; healthy technical controls remain
hidden. Unfinished coordination fees remain separate from commerce readiness.

Activation and Pause exist only in the mounted account session. A new eligible
Orders mount starts fresh after checking that session; Pause is not a durable
preference across reload. **Pause** revokes held authority synchronously and waits
for cleanup; it cannot undo a payment already submitted. History-only checks can
resume after that drain. Manual actions also revoke automatic mode and drain
both workers before proceeding; Resume is required to enable payouts again. Live
session guards surround drains, provider work, and local result reads, including
the interval before React unmount cleanup. Hidden pages pause dispatch, and
returning to the same still-authorized mounted session can resume it.

## Bounded automatic advancement

`advanceMerchantCheckoutSparkOrder` first checks the authenticated order binding,
handoff time, exact funding credit, and existing payout history. It advances at
most one preparation or continuation phase per invocation. A missing intent or
buyer-only recovery selection uses the existing preparation path to retain a
Merchant self-wrap. It then requests a bounded discovery rescan and returns
without sending. A self-wrap pointer alone is insufficient: a later invocation
privately opens its signed state and compares the first unpaid local intent with
that exact signed intent before calling the existing continuation adapter.

The discovery request is coalesced and never awaits or drains the calling worker.
If a scan is in flight, it finishes serially; remaining pages are bounded and
the same session restarts only after its current sweep exhausts. Hidden pages
remain paused, and a fatal or retention-limited session cannot be reopened by
this request. New signed selections invalidate held worker results.

Every awaited phase retains active-account/page guards, immutable invoice and
transfer identity within each attempt, allocation limits, and the existing local
recovery lock. Preparation does not send and no second leg is sent in the same
invocation. Unknown or previously submitted payments remain exact-history
reconciliation cases. The bounded closed-return renewal exception below retains
the old attempt instead of changing its invoice or transfer identity.

Provider-attested commerce with a pending fee returns `progress_pending`, not
terminal commerce completion for the router worker. Provider-attested payment
of every leg returns `retirement_pending`; this still does not claim terminal
receives, claims, refunds, or a fresh zero-funds observation. Local `paid` rows
alone grant neither settlement nor retirement authority.

The recovery panel's `allowAutomaticPayouts` and `startAutomatically` inputs
default to false. The gated Orders route supplies both plus its current
auth-generation guard and remounts the panel on an account/session change.
Automatic Merchant recovery requires a visible current session; it is not a
server-side background job. Its retirement phase requires separate terminal
evidence. Offline
activation and cancellation tests do not establish live provider concurrency,
funded execution, or mobile/browser behavior; those remain separate validation.

## Shared payout preparation

Invoice resolution and allocation-limited fee fitting live in Core. The app
supplies its authenticated session, exact wallet/plan authority, repository,
fee estimator, and recovery-persistence callback. Preparation never sends money.
Market retains the shopper cutoff; a post-handoff timing check alone does not
authorize Merchant wallet access or prove inbound settlement.

The helper validates the frozen recipient, network, invoice amount and hash,
and keeps each invoice plus maximum send fee inside that recipient's settled
allocation. It saves the exact intent before acknowledging its recovery copy.
A concurrent saved intent wins; an existing attempt's invoice and transfer ID
are never mutated, even when expired or followed by an uncertain send. Renewal
requires the separate positive closed-return proof below.

Sharing the helper alone does not enable UI preparation or resolve cross-device
concurrency. Before a never-prepared Merchant payout can be sent,
the recovery path must check the fixed transfer ID and retain its exact new
intent. An unavailable or absent relay update is not proof that no payment was
attempted. An existing provider transfer without the previously authorized
invoice is not sufficient evidence of payment to the frozen recipient.

The Merchant preparation adapter now composes that shared helper within one
local recovery lock and fresh strict-inbox callback. It requires the saved,
authenticated order witness to match the recovery sender, the objective handoff
time to have passed, and the recovered wallet identity to match funding. Exact
completed receive evidence establishes the allocation; wallet balance and
buyer-signed progress do not. Existing frozen sibling payouts are reconciled
against their exact provider records before the next unprepared leg is selected.

Before requesting a new invoice, the adapter queries the leg's preassigned
transfer ID. A present transfer or unavailable lookup leaves preparation pending;
it does not infer another invoice's recipient or payment outcome. Invoice and
all send fees must fit the settled allocation. Local CAS and account-generation
checks prevent overwrites after awaited work. The quote-only wallet interface
does not enable outgoing sends, and every opened session is cleaned up.

After saving an intent, the adapter retains its exact Merchant progress through
the encrypted outbox below. A failed signing, staging, or relay attempt returns
`recovery_pending`; local intent persistence alone does not promise a durable
recovery copy. Successful relay acceptance returns `prepared`, or
`existing_intent` when retrying a previously saved intent. These results are not
payment proof or permission to send. Preparation does not send a payout;
confirmation separately restores and reviews the exact authenticated intent.

Before opening a wallet or requesting another invoice, a later invocation
retries an unresolved staged wrap byte-for-byte, even if local reconciliation
has advanced. It does not reconstruct that older snapshot or replace an expired
invoice. A buyer-prepared intent first retained after handoff gets one metadata
timestamp update; its invoice and transfer ID stay unchanged. Subsequent retries
reuse the saved timestamp and wrapper. An account or local-state change during
awaited work stops further preparation. This recovery delivery is not an
application ACK, distributed lease, or new funding gate.

The recovery panel exposes preparation as a separate explicit
action. It stops and drains both discovery and provider-history work before
loading the exact active Merchant/order/plan binding. Selection uses the first
unpaid obligation in plan order, including an existing unresolved intent; it
never skips that intent to prepare a later leg. Missing or retired local state
does not open a wallet. All-paid local progress is only a reason that there is
nothing to prepare, not new provider proof.

The action reuses the private preparation adapter and retains existing or
expired attempts unchanged unless the closed-return renewal contract is met.
Preparation may initialize Spark and claim inbound
funds, but has no outgoing-send capability. Pending recovery delivery is shown
without claiming that signing, staging, or relay acceptance succeeded. After
successful delivery, the panel clears the older selection and refreshes signed
discovery before a separate payout review; it does not construct a Merchant
progress pointer from local state or confirm a payout automatically. Cancellation
while workers drain or state loads prevents further preparation. History-only
background checks do not create invoices or send payouts; those require explicit
automatic activation or the separate manual actions.

## Invoice payment and recipient attribution

Spark's exact transfer, invoice, fee and preimage evidence establishes payment
of that invoice. It does not independently bind the invoice to a Lightning
address or the Nostr author of a payment profile. A signed profile establishes
the intended destination, not the origin of an imported invoice. A buyer
progress message or Merchant self-wrap cannot fill that gap.

The shared plain-LNURL resolver records local evidence of the exact invoice
returned for the frozen destination. Its in-memory token cannot be restored
from a wire payload. Preparation atomically saves a minimal private fingerprint
with the winning immutable intent in the existing local plan binding. The
fingerprint binds the plan, recipient, wallet, allocation and exact payment
parameters. A concurrent winner is reused without attaching the losing
resolver's evidence. Ordinary state saves and imports cannot create origin.

This local evidence survives reload on the same device. Market requires it;
Merchant accepts it or the narrow independently verified receiving-provider
record described below. Both adapters recheck recipient evidence before
preflight and at the final send boundary. Missing evidence leaves an imported
unpaid intent unsent, with its original invoice and transfer ID intact. Exact
provider-history reconciliation remains available without it.
An independently observed invoice payment stays terminal for duplicate-payment
prevention even when its intended recipient is unverified on this device.

Settlement stores those provider facts separately from the locally derived
recipient-verification flag. Commerce readiness requires all required commerce
recipients to be verified. A missing Conduit attribution does not undo already
verified commerce. Safe retirement removes active invoice-origin material and
retains the minimal attribution result with settlement facts; it does not
invent missing evidence from a zero balance or imported paid status.

Local origin is device-local assurance, not portable recipient attestation.
New qualified intents retain a portable receiver binding and require fresh
independent verification against deployment-qualified endpoints. Private
metadata-hash and public provider-recipient modes have separate account-proof
requirements. Exact invoice association and receiver settlement are independent
of native Spark debit proof. An opaque runtime proof permits digest-only local
persistence; imported recovery hints cannot manufacture it. An unpaid issuance
result or local origin alone cannot mark a bound recipient settled. See
[receiver qualification and acceptance](checkout-spark-recipient-verification-compat.md).

Receiver-only observations never set paid commerce, paid revenue, fulfillment
readiness, fee completion or wallet retirement. A buyer can reuse an older paid
invoice in another matching checkout; even valid receiver account and preimage
evidence does not prove this checkout funded or debited that invoice. A fresh
device may have no older plan to exclude locally. Exact native debit attribution
is therefore still required for every required commerce recipient. The UI may
show a recipient receipt observed while wallet verification remains pending;
already jointly verified native and recipient facts remain paid immediately.

The local observation projection requires the exact authenticated buyer-order
witness and locally validated frozen sources. It does not persist empty display
defaults as financial facts, advance outgoing intents, or expose receiver
payloads in diagnostics. An ambiguous witness, changed plan or unsupported
historical receiver cannot grant observation or payment authority.

Transient attribution outages retry while exact funding/history observations
continue. A verified required commerce payment remains terminal even if the
optional fee's recipient is unverified; that fee-only exception remains visible
without offering repayment. Unsupported receiving services still require an
independently authenticated recipient/provider binding. Expired or uncertain
intents are not silently replaced. Required receiver compatibility is checked
before funding; historical unbound imported invoices remain unverified. This
does not introduce an application ACK or generic portable receipt protocol.

Sources: [LUD-16 Lightning addresses](https://github.com/lnurl/luds/blob/luds/16.md),
[LUD-06 LNURL-pay](https://github.com/lnurl/luds/blob/luds/06.md),
[LUD-21 invoice verification](https://github.com/lnurl/luds/blob/luds/21.md), and
[Spark Lightning payment semantics](https://docs.spark.money/api-reference/wallet/pay-lightning-invoice).

## Merchant-authored progress transport

Core has a separate `checkout_spark_merchant_progress` machine envelope for
post-handoff payout intents. It does not change the buyer-authored recovery
schema, replace the initial wallet recovery package, or authorize takeover.
The canonical payload binds the initial handoff, exact plan, settled allocation,
and immutable payout invoice/transfer IDs. It contains no wallet recovery phrase
or full order body. Fresh NIP-59 opening verifies the merchant's seal and exact
self-recipient rather than using a decrypted-event cache.

Publication uses the ordinary strict declared-inbox transport, with one
merchant-to-self wrap and no compatibility route. The exact signed ciphertext
is durably staged before the first relay write. A retry resolves the merchant's
current declared inbox but reuses those same signed bytes without wrapping a
new message. Account-generation checks surround awaited work. Only an ACK from
an attempted, declared relay marks the local record as accepted; that mark is
not proof of payment, recipient processing, or distributed uniqueness.

The encrypted outbox shares the existing private plan binding and requires an
active exact plan plus its authenticated order witness. Conflicting records for
one snapshot are rejected. Unresolved wraps are not silently evicted. Ordinary
settlement updates preserve them; successful terminal retirement removes them
atomically while retaining the minimal order/settlement summary. Generic chat
and order inbox processing defers this machine type without exposing its
plaintext or consuming the wrap.

Both bounded discovery paths recognize this machine type without decrypting a
wrap twice. A Merchant snapshot is usable only alongside its exact initial
buyer recovery package and compatible buyer progress. Conflicting snapshots,
changed invoice intents, and backward payment transitions remain conflicts;
an orphan Merchant snapshot is not wallet authority. The public candidate carries
only a separate opaque progress pointer, never the decrypted payout state.

Discovery imports a selected snapshot through the existing authenticated-order
repository boundary. Later Merchant progress changes the worker's candidate
identity, invalidating an older held result. Opening a selection re-fetches its
exact Merchant self-wrap, rechecks its seal, and preserves known stronger
observations rather than falling back to the buyer's older state. The private
read-only credit/history adapters require the saved buyer/order witness and
locally compatible state before opening the recovered wallet. Exact provider
readback is still necessary: imported `paid` state cannot manufacture
provider-attested settlement facts.

Explicit import uses that same authenticated order witness and monotonic
repository boundary. Local key verification also requires an active imported
state at least as strong as the selected snapshot before deriving the funding
identity; it does not initialize a provider wallet or send a payment.

The preparation and continuation adapters consume a restored Merchant snapshot
through the same private callback and authenticated order witness. Confirmation
pins the selected recovery pointer and reviewed invoice before awaited work.
The initial buyer, exact order, frozen plan, and local monotonic state must all
match before opening the recovered wallet. It re-attests funding and every
prepared sibling against provider history, then uses the existing actor-neutral
outgoing runner. Preparation is not repeated during confirmation, and a local-only
or changed invoice cannot be substituted for the restored intent.

For Merchant-authored progress, the runner retains the prepared and submitted
snapshots through the same strict private outbox before a send. A failed
submitted-snapshot delivery leaves the possible-send state intact; retrying the
exact wrap cannot reset it to prepared. A later paid-snapshot delivery failure
does not undo verified payment or permit another send. Exact provider history
that establishes a previously uncertain payment also retains a paid snapshot,
without sending again or requiring its delivery to recognize the payment.
Unresolved older wraps are retried byte-for-byte before wallet initialization,
including after invoice expiry; expiry still prevents an outgoing attempt.
Delivery remains ordinary relay acceptance, not an application ACK or
distributed lease.

Spark's documented retry contract requires the same transfer ID and payment
parameters ([payLightningInvoice](https://docs.spark.money/api-reference/wallet/pay-lightning-invoice)).
The SDK's [transfer-ID changeset](https://github.com/buildonspark/spark/blob/main/sdks/js/.changeset/dedupe-lightning-by-transfer-id.md)
describes one deduplication identity across the Spark fallback, preimage swap,
and SSP admission. The [SO idempotency interceptor](https://github.com/buildonspark/spark/blob/main/spark/so/grpc/idempotency_interceptor.go)
returns the saved response under the same authenticated identity, method, and
key; it does not compare new invoice parameters. Conduit therefore preserves the
original invoice and transfer ID, and accepts payment only from exact matching
provider readback. Pending, missing-after-submission, and conflicting results do
not authorize a replacement invoice or a fresh transfer ID. Expired intents remain
history-reconciliation cases unless a positive full return meets the separate
renewal contract. Source inspection supports reusing this existing
runner; it does not replace funded SDK validation of concurrent clients, nor
independently establish the private SSP server's divergent-invoice behavior.

### Bounded renewal after a full unpaid return

The [wallet contract](../specs/wallets.md#lightning-closed-attempt-invoice-renewal) permits
one Merchant-only successor attempt after positive, exact provider evidence of a
closed unpaid transfer with its full debit returned and spendable. The first
implementation does not renew a partial return, charged failure, missing record,
prepared-only snapshot, or possible send. Expiry and balance are not closure
proof. Saved-only inspection never performs this native wallet check.

Renewal leaves the signed plan and original attempt intact. It appends the old
intent and closure metadata, fetches a genuinely new invoice from the same frozen
Lightning address, saves a deterministic generation-one transfer identity, and
retains authenticated Merchant progress before dispatch. A fresh public SDK
inspection correlates SSP, operator transfer, sender HTLC and exact returned
available leaves before committing the successor and again before its first
send. Serialized closure metadata is not provider authority. Reconciliation of
an already admitted successor does not require its consumed leaves to remain
available and does not downgrade verified payment.

Renewed reconciliation and private progress use explicit versions that retain
attempt history; unchanged legacy state retains its original formats. Retirement
keeps the winning attempt identity and actual payment costs. Renewal neither
funds the order again nor repeats a supplier notice. Conduit remains the last
allocation, and a held fee does not erase independently verified commerce.

Wallet retirement checks an archived returned attempt against fresh, exact
terminal SSP/operator/HTLC history. It does not require the returned leaves to
remain available after the successor has spent them. This retirement-only
evidence is distinct from the spendable-return proof required for renewal and
cannot authorize another invoice or payment. Uncorrelated failures or missing
history still block retirement.

## Evidence and limitations

Merchant recovery independently verifies the exact signed listing and payout
profile revisions referenced by the frozen plan before handing recovery data to
a wallet adapter. The shared validator reconstructs the supported deterministic
or signed-rate pricing, selected variations and fulfillment terms, re-derives
the commerce allocations, and matches each merchant or supplier destination to
its original signed profile. Fiat financial acceptance additionally verifies
the frozen rate attestation against the original native provider funding
creation time and retained verification keys, not the recovery clock. A newer
profile or listing must not redirect an older
order. New initial settled recovery packages include a canonical copy of these
original signed events inside the existing merchant-only encrypted handoff.
Products come from the frozen verified quote; payout profiles come from the
exact final signed profile selected during the fresh payment read, not a display
fallback or a reconstructed profile projection.

The source bundle is committed into the initial handoff identity without
changing the checkout plan, payout IDs, or provider history. Progress messages
reference that initial identity and do not repeat the sources or wallet recovery
material. Merchant opens and authenticates the referenced initial package before
validating sources, including when the selected message is later buyer or
Merchant progress. Complete bundled evidence needs no public-history lookup.

Older source-less recovery packages retain their original identities and remain
readable. For those packages the reader uses exact public event IDs and the
existing account relay planner; complete positive evidence remains usable when
another relay is slow or unavailable. Missing historical sources leave recovery
unresolved. A present but unusable bundle is not silently replaced by a newer
public record.

Verified public source events are retained with the active local plan binding.
The Merchant settlement projection requires a locally generated, exact-plan
source-validation marker as well as its order witness and separate provider
facts. Older active rows without that marker stay saved but unverified until
their sources can be checked. Older retired rows without it remain unverified;
discovery never reopens retired state to backfill admission. Retirement removes the full public source cache and
retains only the minimal validation marker with the existing settlement facts.
This marker is not accepted from an imported recovery payload, is not payment
proof, and does not establish invoice-to-recipient attribution across devices.

The new bundle has a 32-KiB canonical UTF-8 source budget, and the complete
source-bearing unsigned recovery rumor has a separate 32-KiB budget. The first
check can reject oversized source material before wallet preparation; the final
check includes nested JSON escaping and the full plan/state envelope before
wrapping or funding disclosure. Nothing is truncated or silently omitted. These
are application resource limits, not a claimed Nostr protocol maximum. The full
rumor budget leaves space for NIP-59's encrypted content and signed seal within
the conservative NIP-44 plaintext baseline; it is not proof that every signer or
relay accepts every bounded message.

This is backward-read compatibility, not old-reader forward compatibility:
older strict schema-v2 readers do not understand the added source field. The
settled producer and consumers must roll out together with compatible schemas
and the same deployment capability. Previously staged wraps remain unchanged, including source-less ones;
retry never rebuilds an acknowledged initial handoff to add sources. Source
bundles reduce dependence on pruned public revisions, but do not guarantee
continued availability of the private recovery wrap itself.

Orders and Home share one account/session-scoped local settlement query and
exact order-witness join. This query reads saved facts only; it does not open
Spark or start relay discovery. Revoked sessions and late cancelled reads cannot
expose new projections. A refresh failure retains previously verified facts.

Home queue counts and recent-order cards use the same projection as Orders.
Routed sales appear in the paid-revenue and top-product charts only after every
required commerce payout is verified. Charts show the order's value, not net
wallet receipts, and use the last required payout's local verification date;
they do not claim the provider's actual settlement timestamp. Completing the
optional fee later does not move or duplicate the sale. Retained settlement
records remain usable without reopening a retired wallet. Historical direct
orders keep their existing payment-evidence/merchant-confirmation dating.

The worker reports aggregate progress and check freshness. Unknown, unavailable,
and incomplete checks preserve prior verified facts. A bounded scan or empty
provider result does not establish global absence or abandonment. Historical
direct-payment orders retain their original manual payment semantics.

Only minimal order-binding and settlement facts survive wallet retirement.
Recovery credentials stay in the private adapter, not component state, ordinary
order caches, logs, or telemetry. The scheduler holds no recovery material.

Deterministic scheduling, repository, and provider-adapter fixtures do not prove
live relay delivery, SDK behavior, mobile suspension, or real payment settlement.
Those require separate browser/device and funded validation before release.
Hosted preview and production activation are separate from that validation;
local compatibility exceptions do not become public dispatch authority.

### Native final collection

New version-four plans created with an approved Spark treasury address keep
merchant and supplier payouts on Lightning, then collect Conduit's settled
allocation and unused authorized commerce reserves in one native Spark payment.
The exact final amount comes from independently verified funding credit less
verified commerce debits, not an aggregate wallet balance. Unknown activity,
pending returns, nonzero native fees and uncertain attempts pause collection.
Claimed terminal provider evidence, not a submitted response, is the receipt.
Commerce remains paid while final collection needs attention.

Without a configured address, new plans keep the Lightning fee rail. Historical
funded plans are never migrated. Native completion and retirement require their
own exact evidence; see [native final collection](checkout-spark-native-treasury.md)
and the [wallet contract](../specs/wallets.md#native-final-treasury-allocation).

## Buyer-local presentation

Market also keeps exact provider observations separate from recovery progress.
Its local funding and payout adapters record the observations already returned
by Spark; a stored `paid` leg or imported progress snapshot cannot create these
facts. Buyer Orders joins the provider record to the current signed-in buyer's
exact saved order, wallet, and plan. A scoped guest router session can use the
same redacted local projection only with its original same-tab 24-hour guest
key, exact order/merchant/plan binding, and matching retained session expiry.
The current guest registry must still authorize each read; an expired or replaced
key does not grant access. This does not add a guest inbox or broader order
history. The local read does not initialize Spark or contact a relay. Account
or guest-session changes cancel pending reads and hide old results. Separately
retained Merchant recovery remains available after the guest session expires;
guest expiry does not erase its encrypted handoff or Merchant recovery authority.

Only all required commerce payouts qualify as paid commerce. Optional fee
progress cannot reopen that payment. Merchant shipping/completion messages
remain visible as fulfillment history, without becoming payout verification.
Generic merchant-invoice and buyer payment-proof milestones do not apply to
these orders. Missing local facts mean "not yet verified on this device", not
proof of nonpayment and not permission to send again.

After durable order delivery, Market saves a minimal buyer/order/plan binding.
That local binding is not an additional relay acknowledgement or funding gate.
A storage failure reports a local-history warning without retrying an already
delivered order. Retirement retains the exact wallet/order amount and settled
leg allocations alongside the separate provider facts in the existing private
plan-binding row. The buyer can then verify those facts against its exact saved
order without reopening the wallet or retaining its invoices and destinations.
The tombstone alone still proves no payment.

Older active preparations remain readable under their exact local order/plan
checks. Retired history without the buyer binding and retained summary stays
unverified; it is not reconstructed from a generic paid label. Older or imported
already-paid progress without separate provider observations is also unverified.
This does not replay payments to backfill that history or infer merchant-takeover
outcomes on another device. Exact provider readback and cross-device evidence
remain separate work.

The retained summary does not enable automatic wallet cleanup. Retirement still
requires terminal receive, send, claim, and refund evidence plus a later fresh
zero available/owned/incoming funds observation. A zero balance and completed
known payouts alone must not be used to erase recovery material.

### Explicit buyer cleanup after successful payouts

The gated buyer Orders surface offers **Check wallet cleanup** after every saved
payout is paid, while the original shopper session still controls the open
wallet before the frozen Merchant handoff. Paid or completed order presentation
does not prevent inspection. Cancellation, a refund request, account/session
changes, or expired guest authority prevent the action. Cleanup neither sends
funds nor prepares an invoice.

The helper rechecks the exact order/plan binding, funding credit, every payout's
provider evidence, and device-local invoice origin. Provider funding and payout
reads have five-second deadlines; timed-out reads cannot later resume retirement.
It then uses an identity-authenticated reader from the initialized wallet's
existing signer, never a public privacy-filtered reader or exported credential.
The exact wallet address, identity, and network must match the frozen plan.

The success-only native collector requires two equal, complete, bounded transfer
history scans before the funds observations and another matching equal pair
afterward, with all observed transfers completed, every expected transfer present,
no pending incoming transfers, and fresh zero available and owned funds. Newly
completed or changed activity during funds reads rejects cleanup. The surrounding
scans do not claim an atomic provider snapshot or close future wallet activity.
Each native read is bounded. Locked or residual funds, unknown transfer states,
truncated history, provider failure, or lost authority retain recovery. These
observations do not establish the absence of future wallet activity, nor do they
implement failed-payment, refund, or residual-disposal paths.

The inspection reader is released before the repository atomically compares the
inspected revision and writes the existing retirement tombstone. Concurrent state
changes reject cleanup. The retired UI retains separately verified payment and
fulfillment history after reload without offering another payout. The tombstone
is a cleanup result, not payment proof. This does not delete the Merchant's
encrypted recovery messages, close the active wallet session, or claim a complete
funded/interrupted recovery test.

### Buyer payment receipt and foreground routing

The private payment breakdown projects only independently validated provider
records against the frozen plan. It shows invoice amount, actual fee, total
debit and recipient verification separately. Missing observations remain
unknown, not zero or the maximum fee budget. Once all planned payouts have
records, credited funds less recorded debits can be shown as historical
unspent credit. That is not a fresh wallet balance, a refund result, or authority
to remove recovery. The same receipt remains readable after safe retirement.

One explicit checkout-plan approval can authorize the buyer's foreground
runner to verify funding, prepare and reconcile each commerce payment, then
pay Conduit last. It uses the existing exact-intent, recipient-origin,
allocation, reserve, recovery-delivery and durable send guards. The first
funding admission is separate from subsequent receive inspections; neither
polling nor resume submits a second funding payment. Source-wallet fee
approval remains required where the wallet rail requires it.

Pausing, hiding the page, changing identity or leaving the order revokes new
dispatch synchronously, including while the approval handler is still reading
saved state. An admitted operation drains before another activation can start.
Resume requires explicit approval of the same plan and inspects uncertain
payments; it never substitutes a new invoice or transfer identity. Automatic
authorization is not persisted across reload. Merchant recovery uses its
separate frozen takeover authority, not the buyer's foreground authorization.

Commerce-paid presentation does not mean the fee leg is complete. The runner
finishes only when all planned legs are paid, and cleanup stays a separate
action. Simulated native-provider/browser coverage is not a funded provider,
mobile-suspension, or production-release guarantee.

## Merchant order dates and local-read continuity

Orders defaults to **Newest orders**, based on the original authenticated buyer
order message rather than a later status update or relay arrival. **Recently
updated** sorts by latest conversation activity. **Needs attention — oldest
first** retains the operational priority queue and its oldest-first active
groups. The device remembers only this UI preference. Order cards label
**Placed** and **Updated** separately; unavailable placed dates sort last rather
than being fabricated from latest activity. Reordering does not change an
existing selected order or the payout worker's schedule.

The local settlement query key includes the observed order-ID set. A pending
list-key change can temporarily reuse previous raw bindings only for the same
principal and authentication generation. Every display projection still joins
those rows to the current exact order witness. Completed missing, partial, or
conflicting results replace the temporary rows; account changes and revoked
sessions hide them. A failed read for a new key clears its placeholder and is
shown as unavailable, not proof of an invalid recipient or nonpayment. Same-key
refresh failures retain the previously read data. These display rules grant no
provider access, recovery authority, or permission to retry a payment.

**Check recovery access** validates the saved key against the order's signed
funding identity. It does not reveal a recovery phrase, inspect funds, verify
recipient payments, or move money. Manual access checks pause automatic work;
their success notice states this explicitly. Early handoff denials are attached
to the affected order so their explanation remains visible.
