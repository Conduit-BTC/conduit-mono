# Buyer coordination pricing

The local settled-router lane presents four inline totals: item subtotal,
shipping subtotal, coordination fee, and order total. It does not disclose
supplier identities, individual recipient shares, or payout destinations.
Hiding those UI details does not make public signed listing terms private.

## Price projections

`calculateCheckoutSparkBuyerPrice` projects the existing router funding policy
without changing it. The commerce base includes quoted shipping. The Conduit
component is the greater of 111 sats and the rounded-up 2.1% component; the
inbound network allowance is rounded up from 0.15% of commerce. Both components
appear in one coordination-fee row, with the network estimate labeled separately
from the percentage or minimum. Free orders do not acquire a payment or fee.

Fee-inclusive listing prices are approximate single-item order totals, excluding
unquoted shipping. A compatible combined purchase applies the minimum once,
not once per item. Separate purchases receive separate fees. Unavailable or
stale conversions cannot produce a usable estimate.

These values are presentation only. Signed listing prices, cached products,
cart lines, and commerce payloads retain their base prices. Existing saved
orders display their validated frozen funding total, including historical plans
that predate the inbound allowance; they are not repriced on reopen.

## Payment authorization

The existing Pay, external-wallet, or Resume action authorizes automatic
foreground routing. There is no additional router confirmation modal. The
handler still reloads and compares the saved plan and funding amount, validates
the selected payer, and checks current account/session authority before running.
Pause, hidden-page cancellation, exact payment reconciliation, and the existing
Portable Wallet source-fee approval remain unchanged. A resumed uncertain
payment is inspected, not sent a second time.

Buyer payment history aggregates recorded payouts and fees without individual
recipient rows. Those records are not a live wallet balance, proof of delivery,
or permission to discard recovery data.

The estimate is gated to the same local canary as the router. Disabled and
production direct-payment lanes keep their existing prices. Isolated browser
tests cover price continuity, supplier UI privacy, automatic routing, and
pause/resume; they do not replace funded provider or physical-device testing.
