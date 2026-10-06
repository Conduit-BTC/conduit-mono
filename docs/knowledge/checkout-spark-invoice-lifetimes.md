# Checkout Spark invoice lifetimes

Funding invoices, outgoing invoices, and actor handoff have separate deadlines.
An invoice's expiry is not proof that a payment never started, and does not
delete its order or recovery evidence.

## Funding

The settled checkout entry requests a 15-minute funding invoice and freezes a
two-minute shopper-to-Merchant handoff from preparation. These are application settings, not a
Spark five-minute limit. Spark's [`createLightningInvoice` API](https://docs.spark.money/api-reference/wallet/create-lightning-invoice)
accepts an explicit `expirySeconds`; the adapter validates the actual signed
invoice rather than assuming the requested duration was honored.

Changing the duration applies only to new attempts and must remain coordinated
with handoff. An already signed invoice and frozen plan cannot be extended in
place. Expired funding stays available for exact receive-status inspection,
including late credit. The current flow does not silently renew an expired
invoice, erase its recovery material, or infer nonpayment from an empty read.

For an explicitly opted-in loopback development rehearsal only,
`VITE_CHECKOUT_SPARK_DEMO_FAST_HANDOFF=true` selects a three-minute handoff
and requests a two-minute funding invoice for new orders. It also requires
the local deployment profile and existing local-router and settled-rehearsal
flags. Public preview/production profiles, production builds,
non-loopback hosts, and development sessions without all three flags retain
the normal timings. The 60-second buyer preparation cutoff is unchanged;
Merchant always follows the deadline frozen in the recovered plan, not its
current environment. Remove the demo flag and restart the development server
to restore normal timing for subsequent orders. Never rewrite an existing
plan or advance a live device clock to accelerate recovery.

For normal new plans, the existing sixty-second buyer preparation buffer means
new payout preparation ends after the first minute; saved prepared attempts can
still dispatch before the two-minute handoff. A payment admitted before handoff
must settle or reconcile under its same identifier, even if completion is late.
Merchant can inspect late funding throughout the original fifteen-minute invoice
lifetime; handoff is neither invoice cancellation nor settlement evidence.

### External-wallet disclosure

An explicit external-wallet choice uses that same saved funding invoice. Before
returning it for QR, copy, or a `lightning:` link, the funding bridge verifies the
buyer/order and acknowledged recovery handoff, checks the exact receive, and
durably reserves a possible payment under the existing funding and store locks.
The immutable external-exposure marker permits reopening only that invoice;
an earlier ambiguous automatic attempt without this marker stays check-only.

Once disclosed, closing the panel or failing to open a wallet does not prove
nonpayment and cannot re-enable another funding rail. Invoice controls disappear
at expiry or shopper handoff and when the buyer/order authority changes. Opening
an external wallet or copying an invoice is not settlement evidence. Exact late
credit still belongs to the original checkout, and no disclosure action creates
a replacement invoice or records a merchant payment proof.

## Outgoing payouts

`checkoutSparkProviderSendWindowEndsAt` returns the signed BOLT11 expiration:
timestamp plus `x`, with the BOLT11 one-hour default when `x` is absent. The
invoice can enter preflight/send only while `now < expiresAt`; the checks are
repeated after asynchronous work and before SDK admission. A valid 59-second
invoice is not rejected merely for having less than a minute remaining.

There is no additional 60-second provider minimum in this helper. The separate
`CHECKOUT_SPARK_BUYER_PREPARATION_BUFFER_MS` remains a 60-second application
budget before Merchant handoff. The older pre-funded plan's execution allowance
is also unchanged. Neither budget is an invoice-validity rule imposed by Spark.

This follows [Spark's expiry guidance](https://docs.spark.money/wallets/withdraw-to-lightning#check-expiry-before-paying)
and the [BOLT11 payer requirements](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md#payer--payee-requirements).
The pinned SDK 0.13.0 does not perform a local invoice-expiry check before its
unquoted Lightning swap. Its send path may lock funds before an expired request is
rejected; a thrown call is therefore not proof of a safe, unattempted payment.

## Persistence and retry

The recipient stays frozen. Within each outgoing attempt, the invoice, amount,
maximum fee and transfer ID remain immutable.
Before sending, the runner saves submitted state and delivers the exact recovery
snapshot. If that work crosses expiry, it does not send or clear a previously
saved possible-send marker. Existing expired intents remain available for exact
history reconciliation; they do not cause another invoice or transfer ID to be
created merely because they expired. Positive paid evidence can still complete
the original leg after expiry.

The narrowly bounded closed-attempt renewal contract in
[`wallets.md`](../specs/wallets.md#closed-attempt-invoice-renewal) permits one
Merchant-only successor after exact positive unpaid closure and complete,
spendable return with zero historical net debit. The old attempt remains in an
append-only history; the successor gets a fresh recipient-origin invoice and
its own deterministic identifier. Fresh provider proof is required before
commit and dispatch, and the authenticated Merchant snapshot must be persisted
and relay-acknowledged before sending. An absent request, imported `prepared`
status or available aggregate balance is not this proof. Partial or charged
returns and uncertain old attempts remain blocked.

Recipient-issued LNURL invoices have their own signed expiry. LUD-06 does not
standardize a requested expiry parameter, so increasing the application funding
lifetime cannot extend an already issued payout invoice. The normal funding
invoice remains fifteen minutes; changing that duration affects new funding
attempts only.

Each recipient's allocation remains the limit for invoice plus all send fees.
Both app adapters retain `preferSpark: false` for these Lightning intents. No
expiry path changes the payout destination, borrows a sibling allocation, or
enables a different payment route.

Market's SDK adapter repeats the deadline check after its own history, fee,
and final account/reserve guard awaits, immediately before `payLightningInvoice`.
Only that pre-admission check can report `not_sent: invoice_expired`; an SDK
throw after admission is not classified that way. Merchant's native adapter
likewise rechecks after its final history, balance, and authority awaits.

Offline deadline tests do not prove that a particular provider, signer, relay,
or device will complete preparation and admission within a short lifetime.
That latency and actual settlement still require live validation.
