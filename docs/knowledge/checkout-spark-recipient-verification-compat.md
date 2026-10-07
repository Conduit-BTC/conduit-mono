# Checkout Spark recipient verification compatibility

## Scope and canonical target

- **Name:** `coinos_account_lookup_v1`
- **Status:** proposed; implemented only behind local development recovery gates
- **Canonical target:** independently attribute the exact frozen payout invoice
  to its recipient, separately from proving that Spark paid it
- **Owner:** payment-boundary maintainers
- **Started:** 2026-10-01
- **Next review:** 2026-11-01
- **Rollout control:** local deployment profile plus development, loopback, rehearsal and router-canary
  gates; no production activation or provider-domain configuration
- **Activation state:** disabled outside the local rehearsal

This is a named provider adapter, not a Nostr extension or a generic LNURL
receipt. LUD-06/LUD-16 resolution does not provide a portable receiving-account
attestation. The buyer's authenticated recovery message preserves intent but
cannot independently prove which account owns its invoice. Strict device-local
origin checks therefore leave some otherwise paid cold recoveries unattributed.

The shared public Quantum Router capability does not activate this adapter.
Hosted routing and local receiving-provider compatibility have separate runtime
admission checks; see [deployment capability](quantum-router-deployment.md).

On the source baseline below, Coinos exposes a canonical invoice record with
the BOLT11, payment hash, amount, receiving user identifier and user name. Source
inspection and offline fixtures are not a guarantee about the deployed API.

## Evidence and behavior

Recipient identity, exact invoice parameters, allocation, Spark payment evidence
and strict Merchant recovery authority remain hard gates. A receiving-service
outage may degrade attribution, not erase stronger payment observations.

| Observation                                         | Action and result                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Existing matching local origin                      | Reuse it; no additional provider lookup.                                                                         |
| Canonical Coinos invoice/account match              | Persist an opaque-proof-derived local digest record; verify Spark payment separately.                            |
| Temporary transport failure                         | Keep saved attempts and exact Spark observations; retry attribution without dispatching an unattributed payment. |
| Conflicting invoice/account or unsupported provider | Keep recipient unverified and expose an exception; never substitute an invoice.                                  |
| Exact Spark payment observed without attribution    | Preserve terminal paid facts; do not send again or call the recipient verified.                                  |
| Retired wallet                                      | Keep retained settlement truth; do not reopen it to reconstruct missing evidence.                                |

## Bounds and prohibitions

- Mainnet, frozen Lightning addresses ending in `@coinos.io` only.
- One fixed HTTPS GET per saved invoice lacking trusted local evidence; no
  caller-supplied endpoint, redirects, cookies, credentials or referral header.
- Eight-second deadline and 64-KiB response budget. Account/page guards bracket
  transport and persistence. Sequential checks run inside the existing bounded
  Merchant worker, not a second payment runner.
- Full plan/recipient/wallet/allocation/intent digest binding and runtime-only
  proof branding. Only minimal verification records survive ordinary reload;
  imported messages cannot create them.
- No invoice replacement, new transfer identity, fee borrowing or receipt
  inferred from balance, node key, preimage alone or buyer progress.
- Provider records and invoice contents never enter logs, diagnostics,
  notifications or telemetry. Existing encrypted recovery remains separate.
- This adapter's amount check covers ordinary untipped Coinos LNURL invoices.
  Its upstream route limits the parameter to 500 characters; longer valid
  invoices and changed provider schemas may be unavailable. A shorter lookup
  identifier is not guessed or fabricated.

## Repair, rollout and removal

Merchant Orders owns the exception UI. It keeps verified commerce usable and
distinguishes a fee-only attribution issue from an unpaid order. Operators must
not request another buyer payment to repair missing evidence. Unsupported
providers require a separate reviewed recipient-bound proof path, not relaxed
identity checks or a mandatory receiving wallet introduced by this adapter.

The separately reviewed closed-attempt renewal path is not Coinos attribution
and does not relax this adapter. After positively verified complete unpaid
return under the [wallet renewal contract](../specs/wallets.md#lightning-closed-attempt-invoice-renewal),
Merchant may request the successor directly from the same frozen Lightning
address using the existing provider-generic LNURL origin path. This creates
origin evidence for the new invoice only, never retroactive attribution for
the old one. Unsupported-provider or missing-origin observations alone cannot
authorize renewal; pending, uncertain, partial-return and paid attempts remain
protected from replacement.

Rollback removes the verifier invocation behind the same local gate, preserving
saved payments, recovery material and provider-paid facts. Exact history remains
inspectable; no stored digest becomes authority for a new recipient or invoice.

No production measurements or enablement are included. Before production use,
maintainers must validate deployed canonical response/CORS behavior and funded
cold/interrupted recovery. Aggregate adapter-attempt, outcome and retry counts
need a tested observation window and denominator without identifiers or payment
content. Provider-specific failure classes may be counted; destination domains,
addresses, invoices, hashes and user/order identifiers must not be collected.

Removal requires a reviewed canonical recipient-proof replacement covering both
unpaid and already-paid restored invoices, including currently unsupported
providers and existing-record compatibility. Widening the provider list, changing
its trust boundary or production activation requires an explicit reviewed change.
This note does not promise universal recovery or authorize cleanup from a zero
balance; expired/uncertain-intent resolution and terminal wallet cleanup remain
separate boundaries.

## Regression evidence

Focused fixtures cover opaque proof persistence, account/page cancellation,
transport outages, canonical account matching, fresh repository reload,
unpaid/paid cold Merchant intents, no replay, and advisory supplier eligibility
only after independent payment plus recipient evidence. UI fixtures retain
commerce Paid status while exposing fee-only attribution exceptions. Isolated
or synthetic tests do not replace real-provider concurrency, mobile suspension
or funded recovery checks.

## Public references

- [LUD-06 LNURL-pay](https://github.com/lnurl/luds/blob/luds/06.md)
- [LUD-16 Lightning addresses](https://github.com/lnurl/luds/blob/luds/16.md)
- [Coinos canonical invoice lookup](https://github.com/coinos/coinos-server/blob/b1e175c1faa46ed67cf0575f8d8808f1ae10892c/routes/invoices.ts)
- [Coinos invoice generation](https://github.com/coinos/coinos-server/blob/b1e175c1faa46ed67cf0575f8d8808f1ae10892c/lib/invoices.ts)
- [Coinos transport configuration](https://github.com/coinos/coinos-server/blob/b1e175c1faa46ed67cf0575f8d8808f1ae10892c/lib/app.ts)
- [Merchant reconciliation boundary](merchant-checkout-reconciliation.md)
