# Event Markets And Local Pickup

**Status:** experimental Event Market implementation contract. Uses kind `30409` and causal merchant authorization. Deployment and real-world fulfillment require separate validation.

## Future Event Market contract

### Public wire and authority

Future events use the experimental [Open Markets Event Market proposal](https://github.com/OpenMarketsFoundation/specification/pull/15). The organizer signs a dedicated addressable kind `30409` record, `30409:<organizer>:<market-d>`, that links exactly one same-author NIP-52 `31922` or `31923` calendar coordinate, or one same-author finite `31924` schedule coordinate. Its required tags are one `d`, one calendar `a`, and `event_market` with version `2` and `open` or `closed`. Its replaceable revisions contain zero to 128 unique `merchant` rows:

```text
["d", "fair-2027-market"]
["a", "31923:<organizer>:fair-2027"]
["event_market", "2", "open"]
["merchant", "<merchant-1>", "merchant_present", "Booth 12"]
["merchant", "<merchant-2>", "organizer_handoff", "North pickup desk"]
["prev", "<prior-signed-market-event-id>"]  // later revisions
```

The organizer sets and may later edit each merchant's sole mode and public assignment. A duplicate or conflicting merchant row is invalid. The organizer's signed market state controls new commerce; calendar dates describe the event schedule. The `prev` tag identifies the signed parent on an update; the initial revision has none. A writer checks the strongest known revision before editing, preserves unaffected rows, and surfaces known divergent ancestry. NIP-01 replacement is deterministic but not a global compare-and-swap.

For a multi-date market, the signed `31924` contains a finite list of full `31922` or `31923` member coordinates authored by that same organizer. The current `31924` revision alone establishes market membership; an occurrence's own calendar reference cannot add itself. The organizer may publish new concrete NIP-52 dates before extending the schedule, edit one future occurrence, or remove a future occurrence from the schedule without deleting its public event. Past members remain available for timeline and order history. A weekly authoring pattern expands into editable concrete dates and is not published as an RRULE or run by a background scheduler. The initial writer caps one batch at 32 dates for signer usability; this is not a protocol limit.

Kind `3841` is a regular immutable organizer-signed authorization transition scoped to one market coordinate and merchant pubkey. Its empty content and required tags are:

```text
["openmarkets", "event-market-auth", "1"]
["a", "30409:<organizer>:<market-d>"]
["p", "<merchant>"]
["state", "active" | "revoked"]
["seq", "<canonical nonnegative decimal>"]
["auth_parent", "<prior transition id>"]  // zero on a root; up to eight otherwise
["repair", "<kind-5 id>", "<deleted transition id>"]  // only for a reviewed repair
["alt", "Open Markets event merchant authorization"]
```

An active grant with validated observed ancestry and a current roster row are both required for new commerce. Observed incomparable tips, missing parents, and unresolved organizer deletion evidence block admission. A later stale relay response cannot restore a known revoke or erase a conflict. Merchant enrollment is an authenticated merchant-level request or organizer invitation; neither grants admission. Approval signs a causal active grant and adds a row. Revocation signs a descendant revoke and removes the row. Because these are separate relay writes, an interrupted operation must retain signed bytes for exact retry; either an absent row or revoked grant denies admission. Reapproval requires a descendant active grant and a row, and warns that all still-valid active assignments may become eligible again. Mode and assignment edits need only a roster revision.

A merchant's kind `30402` product may carry a discovery hint for the market with `["a", "30409:<organizer>:<market-d>"]`. That tag establishes no assignment authority. The ordinary product carries no independent event pickup, booth, handler, or fee. Merchant product publication, edits, untagging, visibility, price, inventory, and payment destination remain under the merchant's signature. No organizer product acceptance occurs. Earlier experimental version-1 `30409` revisions do not imply grants.

### Occurrence assignments and durable acceptance

The implemented merchant-pickup slice follows experimental proposal revision `8aa6d83331c750be22bf01413a1f932778e64568`. A merchant signs kind `30410` for the exact market, concrete occurrence and existing sellable product tuple. Its deterministic `d` is SHA-256 of compact UTF-8 JSON `[market, occurrence, product]`. A variation uses its own sellable coordinate. Product market tags cannot synthesize assignment authority. Current signed roster, causal grant, selected date, product and assignment evidence remain required for new purchases; retained revocation, deletion and conflict evidence dominates stale positives.

Product, Assignment and Accepted order are separate durable records. The existing `commitLocalProductWrite` transaction owns ordinary product edits and its shared listing outbox. Once initialized, inventory participates in that same transaction. A merchant acceptance transaction commits all item debits and the order-ID binding before signing or publication. Pickup consumes both total stock and its allocation once; ordinary sales respect every effective allocation. A replay of the same order resumes the saved decision; changed identity or terms under that ID are rejected. Failed publication does not undo acceptance or prevent another safe acceptance from intact committed inventory.

Unsigned and signed projection work remains attached to these durable records. Signed retry bytes are immutable. Product projections join the existing product-write/outbox owner without consuming stock again; a subsequent ordinary edit remains the metadata baseline. Upgrades retain the complete installed main/discovery/assignment schema union at v27, including the installed-v25 repair. Cache pruning or reset must not erase committed inventory, accepted orders or signed recovery work. This provides local transaction serialization, not cross-device atomicity or proof of global network absence.

The direct Merchant control supports pickup assignments. Atomic rollover, the full Reschedule/Relocate workflow and shipping/digital assignment controls remain separate. A real start/end or venue change requires a replacement occurrence plus merchant notice and confirmation of remaining allocations; typo, directions and booth corrections remain ordinary edits. Current organizer acceptance uses the finite stock handover, exact order reconciliation and checkout recovery boundaries below. Existing authenticated historical release receipts remain inspectable without granting new authority.

### Market and checkout behavior

Read the known organizer-signed market record and calendar before candidate discovery. Fast provisional discovery may paint clearly provisional product candidates before per-merchant authorization is checked. A candidate is not an admission claim and cannot authorize adding to cart, ordering, or payment. Known negative signed evidence suppresses a candidate; an unavailable optional source does not prove absence. Use the organizer's observed NIP-65 write relays with bounded hints and fallback relays; retain unioned signed observations. Derive the finite roster author set, then discover kind `30410` assignments by those authors and the exact market/occurrence, and resolve their exact ordinary product coordinates. Filters yield candidates only. Before treating a candidate as an admitted event product or allowing a consequential action, including at a direct product link, resolve the current signed product revision and applicable NIP-09 deletion evidence; verify merchant author, exact assignment tuple, active grant, visibility, and valid product terms. A newer product revision supersedes older product terms; product deletion or a revoked/deleted assignment denies new pickup. Removing a product discovery hint does not revoke a still-valid assignment. Retain stronger known signed market, authorization, and product evidence when relays return stale or partial data. Surface incomplete evidence instead of treating it as proof of admission or removal.

An unpaid cart resolves current open market, calendar, merchant row, active validated authorization tip, product, and payment terms again before payment. A series purchase requires an explicitly selected current or future occurrence with complete signed membership and occurrence evidence. Missing siblings do not invalidate a verified selected date; an unresolved master or selected date blocks its purchase. Its participation identity is market coordinate plus merchant pubkey and, for a series, selected occurrence coordinate. Compatible products from that merchant at the same date form one purchase; products selected for different dates remain separate. A roster revision or booth rename alone does not split it. A material mode, assignment, selected date or membership, product, price, or payee change requires buyer review before payment. Calendar time does not close the whole market; each selected assignment must still have an unended occurrence. There is no separate buyer event-pickup fee; event costs belong in merchant prices, and the merchant remains payee.

Created and paid orders retain the exact market revision, merchant row, observed authorization tip and required ancestry, relevant observed deletion evidence, calendar, product and assignment revisions, payee, and accepted terms. Series orders also retain the exact signed `31924` revision and selected occurrence revision so their same-author membership can be verified later. This is a bounded observation snapshot, not proof that no unseen event existed. A later roster, schedule, or occurrence edit does not reinterpret an order. Material handoff changes to an existing order require an explicit authorized per-order update or transfer and buyer notice. Historical live-Merchant release receipts carry `releaseAuthorized: true` after the Merchant's paid or zero-cost check; they carry no payment confirmation or full order. New organizer-handoff purchases use the bounded advance stock and checkout authority below instead of requiring another live Merchant release signature. Private release, delivery, and recovery remain content-minimal and encrypted; the organizer never gains Merchant account or standing-wallet authority.

### Compatibility and validation

New kind `30409` records do not reinterpret old kind `30405` product collections or per-product kind `30406` event pickups. Collection-based event readers, writers, pickup checkout and handoff compatibility are removed. Organizers must repost events in the new structure; there is no automatic conversion, dual authority or old-model fallback. Ordinary product collections and standard shipping remain separate commerce concepts. Do not derive participation from previous products or republish all products for a roster edit.

Future-event validation covers unapproved product spam, automatic admission for approved merchants, product revision/untag/deletion, organizer mode and assignment edits, revocation and reapproval, stale and divergent relays, stale organizer edits, direct links, compatible cart grouping, buyer review, historical order continuity, and composed Market/Merchant browser journeys. Local tests do not establish live-relay convergence or physical handoff.

## Conduit organizer-fee extension

This is a Conduit extension, not a claim that the experimental Open Markets
proposal defines buyer event fees or organizer payment authority. Merchant
product prices, allocations and destinations remain Merchant-owned. The
ordinary profile's no-separate-pickup-fee rule above remains the baseline for
orders without this explicitly disclosed extension.

The organizer may author one optional namespaced tag in its existing signed
kind `30409` roster. No new kind or second public fee registry is introduced:

```text
["conduit_event_fee", "1", "active", "<basis-points>", "<minimum-sats>", "<lightning-address>"]
// An optional seventh value is the exclusive expiry in Unix seconds.
["conduit_event_fee", "1", "disabled"]
["conduit_event_fee", "1", "revoked"]
```

The complete signed roster revision binds the market coordinate, organizer,
terms and destination. Integer fields use canonical nonnegative decimal
integers; amounts and totals must also fit safe millisatoshi conversion. The
receiver is a normalized Lightning address, not a profile lookup that can later
redirect a funded payment. Active terms with both economic fields zero are
disabled. An absent tag retains the original zero-organizer-fee behavior.
Duplicate tags, unknown versions, malformed fields, a wrong author/market or
invalid signature provide no financial authority. Fee parsing is independent
of catalog presentation; invalid fee terms do not erase otherwise valid roster
evidence or hide its recovery path.

Fee authoring requires the authenticated organizer and strongest observed roster
parent. Save the exact signed revision before publication, and retry its same
bytes. Unrelated open/close, booth and merchant-approval/revocation edits preserve
existing fee tags, including unsupported versions, rather than silently
dropping them. Disabling or revoking is an explicit newly signed revision.
Expiry must be later than a new active revision's signing time. Current
financial admission checks signed creation time and exclusive expiry; historical
parsing must not apply today's clock to correctly retained funded evidence.

The fee is `max(minimumSats, ceil(commerceTotalSats * basisPoints / 10000))`.
Its base is the approved merchandise plus shipping total, excluding organizer,
Conduit and network fees. Do not charge a fee on another fee or change the
independent Conduit floor. A coordinated fee-bearing plan must disclose the
organizer, rate/minimum, exact fee and complete fixed funding total before
payment. Freeze the exact signed terms revision and destination. Later edits,
revocation, profile changes or expiry cannot reprice or redirect that funded
plan.

Execution must reuse the existing ordered router: required Merchant/supplier
commerce, organizer fee, then Conduit's existing native final collection. The
organizer obligation bears its own approved outgoing fee. Its uncertainty cannot
undo paid commerce, ask for another full purchase or block otherwise authorized
handout. Conduit collection cannot sweep an unresolved organizer obligation.

Coordinated event checkout uses the version-five economics and source binding
in [the router contract](universal-checkout-router.md#event-market-checkout-extension).
Signed term parsing or roster publication alone is not financial admission:
verify the complete signed occurrence graph, receiving qualification and exact
same-plan recovery before funding. Existing version-three/four funded plans
retain their original digests and amounts. The organizer fee is separate from
the commerce/Conduit weights; it is not another commerce recipient appended to
an old plan. Zero-price goods with a signed positive minimum require the
disclosed fee-only plan; zero commerce and zero fee need no funding.
No public routed zap, service-operated executor, guest inbox or automatic refund
is introduced.

## Conduit organizer stock handover extension

Merchant-absent organizer sales use an explicitly entrusted, finite tracked
quantity from one occurrence assignment. Merchant remains the sole product and
assignment stock writer. The organizer consumes only its private reserved pool;
it never signs Merchant listings or obtains the Merchant account key. Untracked
inventory is not an implicit infinite pool. The pool binds the exact Merchant,
organizer, product, assignment, roster, occurrence, authorization and optional
schedule revisions, an exclusive organizer-device writer, quantity and deadline.
New organizer acceptance still requires current event authority. Zero organizer
fee does not disable otherwise valid handout authority.

Before requesting a grant seal or publishing its assignment commitment, commit
the private grant draft and assignment stock hold in the existing inventory
transaction. A failed signature or relay acknowledgement does not release that
hold. The signed assignment carries the Conduit-only commitment:

```text
["conduit_stock_pool", "1", "active" | "closed", "<grant-rumor-id>", "<organizer>", "<original-quantity>", "<imported-quantity>"]
```

This is not part of the experimental Open Markets assignment profile. It is a
commitment to the exact private unsigned grant rumor, not a public order or
payment registry. Duplicate, unknown or malformed commitments supply no new
commerce authority. General catalog parsing retains that distinction. Cold
Merchant recovery must not reconstruct ordinary availability from an active or
unusable commitment without its private pool/journal evidence. An intact local
writer may continue from durable state; a fresh organizer device must not reset
consumption from the original grant after a partial or empty inbox read.

While unresolved, each assignment reserves the greater of its currently live
allocation and its outstanding organizer hold, not their sum. Seller pickup may
consume only the live allocation less that hold. Ordinary sales and every stock
edit honor the hold, even after assignment removal, event end, cancellation or
revocation. Those transitions stop new acceptance; they do not prove that
entrusted goods are unused. Tracking-mode changes cannot erase a hold.

Private grant, acceptance and closing records reuse unsigned kind-14 rumors,
author-signed NIP-59 seals, ephemeral gift wraps and NIP-44 v2 encryption. The
reserved subject is `conduit-event-stock`, with the exact marker
`["conduit", "event-stock", "1"]`. Dedicated consumers validate the payload,
exact roles and grant commitment after envelope authentication. Generic Messages
must quarantine that reserved subject/marker, including unknown versions or
malformed content. A parsed JSON body alone is not proof of its sender. Exact
encrypted recipient and owner recovery copies are retained before delivery.
Only account signers can author these records; the guest-key exception is not
widened.

Organizer acceptance atomically debits its remaining pool and retains an
immutable sequence/predecessor, order, accepted identity/terms, quantity and
unique claim before sealing or publication. Exact retries resume that decision;
changed terms under an existing order/claim reject. Handout does not debit it
again, and funding or organizer-fee receipt alone cannot authorize handout.
The accepted order still requires exact commerce settlement and claim checks.
Closing freezes acceptance locally before requesting its seal. Unused stock may
return only after the Merchant verifies that closing frontier and imports every
accepted entry through it once. Missing, conflicting or divergent entries keep
the remaining hold. Import uses the existing accepted-order transaction and
product projection owner, preserving original order terms even after the date
ends; it is not a second stock writer or a second payment executor.

These are local serialized writers with an explicit handover, not a distributed
lease, cross-device lock or proof of global network absence. Parallel independent
organizer devices require reconciliation/handover rather than starting a second
pool writer. Durable grants, decisions, closing evidence and replay protection
are not cache and survive relay changes and schema upgrades. This contract does
not itself activate organizer purchasing or relax the separate wallet recovery,
frozen router plan, receiving qualification and composed acceptance gates.

Active device replacement is an explicit cooperative handover. The destination
first registers a recovery target without writer authority. The source verifies
its durable installed-pool manifest and complete market journal, then durably
retires itself before requesting signatures or publishing the transfer. The
self-only encrypted snapshot includes original grants, all acceptance/handout
decisions, complete-order manifests, pending exact delivery operations and
frontiers. Its reserved subject is `conduit-event-stock-handover`, with marker
`["conduit", "event-stock-handover", "1"]`; generic Messages quarantines this
family, including malformed or unknown versions. Only the organizer account
signer may author it, addressed to that same account, never another Merchant
or a guest. The destination authenticates every part and original authority
before atomically activating the same logical writer and unchanged pool,
order, claim and payment identifiers. Retired source devices cannot accept
future grants, route delegated payments, close pools or hand out goods.

Transfers support at most 8 MiB of complete snapshot JSON and 2,048 rows per
snapshot collection, split when necessary into at most 128 authenticated
64-KiB binary parts plus their ordered hash manifest. Every encoded packet must
also fit the existing private-message transport bound. All exact encrypted
packets are retained before publication and independently acknowledged;
partial delivery retries those same packets. Missing, conflicting or incomplete
parts never activate the target. An oversized journal is rejected before source
retirement; the original device remains active for existing workflows. Closing
and reconciliation do not erase terminal replay evidence or shrink this complete
snapshot. Replacement beyond these supported bounds needs a separately reviewed
larger-transfer or terminal-history compaction capability, never truncation or a
fresh writer reset. Loss of the source without a complete retained transfer does
not prove that unobserved decisions never happened and requires reconciliation;
this is not a remote revocation service.

## Usable workflows and recovery

Organizer-handoff checkout requires a current, exact finite stock grant and
its published assignment commitment. Separately encrypted Merchant and
organizer checkout recovery must be durably retained and acknowledged before
funding exposure. This is a bounded exception to physical-release-only
delegation: it entrusts only that checkout wallet and minimal machine commercial
evidence, not a Merchant account or standing wallet. The original full buyer
order remains encrypted to the Merchant. Organizer acceptance carries hashes
binding that original order; Merchant import independently authenticates the
buyer order and organizer seal, compares exact terms and debits the existing
inventory transaction once. No hash, relay acknowledgement, funding receipt or
fee payment substitutes for the commerce-settlement and unique-claim checks.

The designated organizer writer uses the existing router after the saved buyer
cutoff. A fresh device restores exact encrypted decisions, payout attempts and
handout evidence; it does not mint a new wallet, reset pool consumption or
start a parallel writer from an original grant. Incomplete or conflicting
frontiers require explicit reconciliation/handover. The Merchant can inspect
and import historical entries after occurrence expiry/removal without
authorizing a new sale. Closing releases unused stock only after the complete
accepted prefix is authenticated and imported, with a terminal replay barrier.

The organizer is an additional financial recovery actor, not a replacement for
the Merchant. After the buyer cutoff, Merchant may finish the same checkout's
remaining payments using its original Buyer-order witness, authenticated actor
progress and fresh exact provider/recipient reconciliation. All actors preserve
the same wallet, frozen obligations, invoices and outgoing IDs. This financial
fallback does not reserve stock, redeem a claim or transfer the exclusive stock
writer; physical handout retains its independent settlement/journal/claim gates.

Merchant cold recovery uses a bounded, Merchant-authored encrypted self
checkpoint on the existing private delivery boundary. It binds exact signed
product/assignment revisions, original grants, imported/closing frontiers and
once-only order attribution. Related public stock projections are signed as a
batch and require the matching exact checkpoint to be retained and acknowledged
before publication. A fresh device restores only a positively observed and
authenticated checkpoint with its exact signed projections; older, partial or
conflicting evidence does not restore availability or reset a writer. Known
newer checkpoint observations remain durable high-water evidence.

The exclusive pool prevents the Merchant from independently selling entrusted
units; it is not a distributed Buyer reservation service. Public remaining
stock can lag private organizer consumption. Funding or paid commerce alone
does not guarantee pickup availability: an organizer must atomically reserve
the full order against its current journal before delegated routing/handout.
If the remaining pool cannot cover a funded order, show Needs attention and
retain its payment/recovery evidence; never release a second item, silently
reset consumption or describe pickup as confirmed. No live recipient application
ACK, guest reply inbox or automatic refund service is introduced.

The same Event Market link identifies the host workspace and merchant participation surface. An authenticated request, invitation, decline or withdrawal is private coordination, never public admission authority. The merchant sees the current signed approval separately from private request delivery. The organizer can admit their own merchant identity without manually copying a public key. Approved merchants add existing products or create a product in the event context; product ownership, stock and prices stay with the merchant.

Authoring supports description, banner upload/preview, location, timezone and concrete single or recurring dates. Corrections are available after creation. Merchant profiles label rosters and booth signs, with public-key fallback when a profile is unavailable.

Checkout compares material accepted terms and retains the latest authenticated evidence when only an unrelated roster revision changed. Positive required facts, source freshness, observed negative evidence and coverage are distinct. Missing ancestry, known conflicts/revokes/deletions, and missing current selected facts block; a failed optional relay alone does not.

Handoff delivery retains exact encrypted operations for retry. Completed delivery leaves the bounded pending queue without erasing claim identity or stronger authenticated evidence. Merchant inbox self-copies participate in duplicate-issuance protection on a fresh device. An exact authenticated handoff acknowledgement may support completion despite an incomplete unrelated inbox read; known conflicting or revoked evidence still blocks.

Finite recurrence and event pickup versus ordinary shipping compose with these workflows. New assignment purchases permit pseudonymous contact-free pickup without a separate product opt-in until the selected date ends; the buyer must retain their private receipt. Historical pre-assignment immediate pickup retains its currently-occurring-date and merchant opt-in checks. Ordinary contact-based pickup and shipping contact requirements remain available. Organizer fees and checkout-wallet recovery require the exact payment-router and stock authority described above; a historical physical-release receipt alone does not imply those capabilities.

## Validation boundary

Maintain a current evidence index in `docs/knowledge/event-market-validation-evidence.md`. Composed browser journeys must start with event creation and merchant enrollment, not only seeded approvals. Include source failure, signer interruption, reload, changed purchase terms, recurring date choice, shipping, optional contact-free receipt, duplicate delivery and stock-once cases. Local synthetic signers, relays and invoices do not establish physical-device, live payment or real pickup success.
