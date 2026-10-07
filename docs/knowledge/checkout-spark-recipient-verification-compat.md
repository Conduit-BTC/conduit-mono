# Checkout Spark receiver qualification

## Scope and trust

The router independently associates each exact Lightning payout with its frozen
recipient, separately from proving that Spark paid it. A shopper's recovery
message, invoice signature, preimage or balance cannot supply all these facts.
This is a provider-neutral capability contract, not a Coinos adapter, a permanent
wallet-brand allowlist, an invoice witness or a new Nostr receipt standard.

Trusted deployment policy qualifies exact pay-request, callback and verifier
origins, verifier path and historical private-invoice binding semantics. V1
uses ordinary private payments; public mode is deferred, not a receiving-service
API or release dependency. A descriptor
marked `pending` cannot admit a receiver. Advertising LUD-21 alone is not
qualification. All required Merchant and supplier receivers must be supported
before wallet creation or funding disclosure; unsupported endpoints do not
enable direct-payment fallback. The reference implementation is the
`@conduit.cash` receiving integration, but reference status does not implicitly
activate it. Other endpoints can qualify through the same contract.

## Independent evidence

- Fresh canonical Lightning-address metadata must identify the frozen address
  and match the qualified pay-request/callback policy.
- A private invoice's description hash must bind the exact provider metadata.
  The qualified provider must preserve the account association and historical
  verification semantics, including account/name reassignment behavior.
- Retained historical public invoices still need independent account proof.
  They are never converted into private payments or treated as unpaid because
  a receipt is missing. New V1 preparation requests no public invoice.
- The prepared intent retains the exact mode-qualified receiver binding as a
  portable lookup hint. Imported hints do not create trusted verification.
- Both clients check the qualified verifier's exact invoice, network, amount
  and payment hash. Its settled result must include the matching preimage.
- Exact native Spark transfer/debit/amount/preimage proof remains a separate
  requirement. Neither provider's evidence replaces the other.

An unpaid issuance check permits only the same exact unpaid intent under the
existing send guards. It does not mark its recipient settled. For bound intents,
local origin alone cannot unlock commerce readiness or final treasury collection.
Proof-derived local records bind the plan, wallet, recipient, allocation and
intent digest; receiver-settled observations upgrade monotonically. Exact
Spark-paid facts remain terminal for duplicate prevention while receiver history
is delayed. Retry refreshes verification and reconciles that same possible send,
never fabricates another invoice or transfer identifier.

## Transport, recovery and compatibility

Verification uses a qualified HTTPS endpoint with no redirects, credentials,
cookies or referrer; its response is bounded to 64 KiB and eight seconds.
Session/order guards bracket transport and persistence. Invoice/account/provider
contents remain private and do not enter logs, telemetry or diagnostics.

Supported cold partial recovery must verify previously paid recipients, complete
only remaining obligations, confirm native collection and independently establish
safe retirement. Historical imported attempts without usable recipient binding
remain unverified rather than inferred from a balance or buyer label. Legacy
matching device-local origin remains readable under its original contract; it
does not retroactively add portable receiver settlement to a historical plan.

Closed-attempt renewal remains a distinct
[wallet contract](../specs/wallets.md#lightning-closed-attempt-invoice-renewal).
Only positive terminal unpaid closure, complete spendable return and zero
historical net debit authorize its bounded successor for the same frozen
recipient. Missing qualification, absent origin, expiry, an outage or a paid
attempt does not authorize replacement. Retirement remains separately gated
by exact terminal history and zero owned/available/pending funds.

## Qualification and acceptance

Managed policy defaults to no accepted live receivers. Before adding an accepted
descriptor, maintainers must establish deployed issuance/account retention,
exact verification/CORS behavior for ordinary private receiving. Preserve
necessary historical verification policy during endpoint changes; rotation must
not redirect a frozen attempt or invent evidence for an unsupported old one.

Normal provider-owned fixtures cover issuance, fresh-reader verification,
delayed settlement, proof persistence, supported partial recovery and no replay.
They do not prove deployment qualification. Real acceptance must include fresh
funded checkout, receiving-side confirmation, concurrent buyer/Merchant and
in-flight/delayed history, and external mobile payment followed by Safari
termination while Merchant is offline, then cold Merchant restore and completion.
No synthetic test or source inspection waives this gate.

## Public references

- [LUD-06 LNURL-pay](https://github.com/lnurl/luds/blob/luds/06.md)
- [LUD-16 Lightning addresses](https://github.com/lnurl/luds/blob/luds/16.md)
- [LUD-21 invoice verification](https://github.com/lnurl/luds/blob/luds/21.md)
- [NIP-57 public zaps](https://github.com/nostr-protocol/nips/blob/master/57.md)
- [Merchant reconciliation boundary](merchant-checkout-reconciliation.md)
