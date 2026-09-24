# Universal Checkout-Scoped Spark Router

## Status and boundary

This is the target contract for **new checkout payments after the universal
router cutover**. The existing direct-to-merchant and public-zap checkout code
remains pre-cutover behavior until the router is integrated and validated; this
document does not claim the target flow is live. Existing orders retain their
original payment and fulfillment authority.

The router is one shopper-created, checkout-scoped Spark wallet with one
ordinary private Lightning funding invoice and one immutable authorized payment
plan. NWC, WebLN, a registered Portable Wallet, and an external Lightning wallet
are ways to fund that same invoice, not independent paths to pay recipients.
The checkout-scoped wallet is not a registered, reusable Portable Wallet and
does not create a Nostr account.

## Funding and authority

1. Resolve the exact current signed product, allocation, fulfillment, quantity,
   price, and recipient evidence needed for the order. Preauthorize the
   checkout and order identities, merchant, selected signed revisions, totals,
   ordered obligations, destinations, stable outgoing IDs, and fee
   responsibility before creating a funding invoice.
2. Create the checkout-scoped wallet and one invoice only after those commerce
   obligations are authorized. Freeze a versioned plan that also binds the
   wallet and funding-invoice identities before protecting the recovery bundle
   or exposing the invoice. An unavailable Spark provider or unresolved amount,
   recipient, signed revision, or recovery route preserves checkout intent and
   retry state but exposes no payable invoice. A new checkout never falls back
   to paying a merchant or another recipient directly inside Conduit.
3. Verify a valid, current merchant-authored kind `10050` inbox declaration.
   Protect the exact full one-checkout recovery bundle and plan in a dedicated
   machine-only NIP-17/NIP-59 message for that merchant. Persist the exact
   signed wrapper before relay I/O, publish only to eligible relays declared by
   that merchant, and require the normal persistent-message relay acceptance
   evidence before showing the funding invoice. Zero ACK does not authorize
   funding. A relay ACK means relay acceptance, not merchant receipt.
4. The shopper pays that private invoice using one eligible funding source. A
   locally initiated pending or ambiguous attempt stays bound to its original
   invoice, plan, and selected source until provider evidence classifies it.
   An external-wallet QR/deep link is reconciled by the exact invoice and
   receive evidence, not by assuming which external wallet paid. Refresh,
   reopening, and changing the selected default wallet must not cause another
   economic payment or a direct merchant payment fallback.

Funding the temporary wallet is **not** proof that a merchant, supplier,
organizer, or platform obligation settled. No router funding or required payout
emits or claims a public NIP-57 kind `9734` request, kind `9735` receipt, or
public checkout message. Optional public display on an actual merchant payout
is a separate later feature and never a core payment or recovery gate.

## Settlement and recovery

- The shopper browser normally reconciles the receive and executes the exact
  authorized merchant, supplier, and organizer obligations before the platform
  obligation. Each outgoing leg bears its own Lightning/provider fee. A later
  fee-leg failure cannot replay or invalidate settled commerce.
- The exact platform destination and amount come from the authorized checkout
  policy and are frozen in the plan. That leg bears only its own outgoing
  Lightning/provider fee; it cannot deduct from an earlier commerce
  obligation.
- Both shopper and Merchant recovery use the same immutable plan, stable
  outgoing IDs, provider history, and terminal-state rules. An obligation is
  paid only from conclusive evidence for its own exact outgoing payment. A
  pending, ambiguous, contradictory, or unavailable result pauses that leg;
  only an obligation proven unpaid may be sent.
- If the shopper disappears, a later eligible Merchant session may restore the
  same temporary wallet from the protected message and resume after the
  plan's objective takeover boundary. The shopper must not start new sends
  after that boundary, even if Merchant has not yet resumed. Duplicate tabs
  and restores must not duplicate a leg.
- Retire the temporary wallet only when every receive, outgoing, claim, and
  refund state is terminal and fresh available, owned, and incoming balances
  are zero. Retain a non-secret terminal marker that rejects replay.

The exact merchant may technically spend the whole temporary wallet after
receiving its recovery credential; the software plan is not a cryptographic
restriction on that merchant. Conduit-operated services never receive the
credential or execute a background payout. Recovery depends on the merchant
returning and at least one relay retaining the package; neither a relay ACK
nor this design guarantees eventual settlement.

## Privacy and compatibility

- Use the standard NIP-17/NIP-59 protection directly; do not add nested
  application encryption, merchant application acknowledgement, or a generic
  DM/order compatibility route for the wallet recovery package.
- Decrypted recovery material must not enter ordinary conversations, order UI,
  search, notifications, logs, telemetry, traces, or support artifacts. Persist
  only the encrypted wrapper and the minimum non-secret reconciliation state.
- The guest order-signing key described in `protocol.md` is distinct from the
  Spark wallet credential. Its same-tab/24-hour limit must not expire the
  merchant's checkout-wallet recovery authority.
- Legacy direct-payment and public-zap order history remains readable under
  its original semantics. A router order must not infer settlement from a
  legacy payment proof, public receipt, funding balance change, or relay ACK.

## Acceptance criteria

- [ ] The exact signed commerce and recipient evidence creates one immutable
      plan and one private funding invoice for each new checkout; missing or
      changed evidence blocks invoice exposure.
- [ ] A current merchant kind `10050`, durable exact recovery wrapper, and
      required relay ACK precede invoice display. No compatibility route or
      zero-ACK path exposes it.
- [ ] NWC, WebLN, Portable Wallet, and external-wallet funding all target the
      same type of invoice; none pays a recipient directly or publishes a
      router zap.
- [ ] Checkout, Orders retry, and Merchant recovery preserve the same IDs and
      plan across reload, multiple tabs, delayed relay/provider history, and
      browser suspension. No ambiguous outcome is automatically replayed.
- [ ] Exact provider evidence settles each commerce obligation once, then the
      platform leg. A later leg's failure preserves previously paid legs.
- [ ] A real device/browser test pays the invoice, suspends the shopper before
      completion, and has Merchant restore, reconcile, finish unpaid legs, and
      retire at conclusive terminal zero-funds state.
- [ ] Old direct-payment and manual second-payment routes cannot be reached
      for a new checkout after cutover; old orders remain inspectable.

## Open question before full cutover

How should a merchant-issued `pay_later` or `payment_request` for a **new router
order** enter this flow after order creation? The new-checkout rule forbids a
silent direct-recipient fallback, but the timing and authority for a later
merchant-approved invoice must be specified before that flow is migrated.
Historical pre-cutover orders retain their original payment authority. This
does not block testing a prepaid router checkout on an isolated branch.

## Source contracts

- [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) defines
  private-message delivery and the recipient's kind `10050` relay declaration;
  [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) defines
  its gift-wrap envelope.
- [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md) defines
  the NWC funding adapter's payment protocol.
- [NIP-57](https://github.com/nostr-protocol/nips/blob/master/57.md) defines
  public zap semantics, which this router does not claim for funding.
- `wallets.md` defines registered Portable and Connected Wallet ownership;
  `order-lifecycle.md` defines order state and existing-order compatibility.
