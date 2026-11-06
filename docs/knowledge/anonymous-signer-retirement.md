# Anonymous signer retirement

Guest payments remain supported. Market guests tip `receiver@conduit.cash` with an ordinary Lightning invoice and check their wallet for confirmation. A connected wallet must provide the matching payment preimage before the app confirms payment. Plain tips do not publish a zap message or wait for a Nostr receipt. Signed-in public tips and shopper-signed checkout zaps retain their existing behavior.

New checkout defaults to private invoices, with shopper-signed public zaps available as an explicit signed-in choice. Guest checkout always uses private invoices. Historical anonymous orders and receipts remain readable; existing private-invoice recovery remains available. New invoice preparation for a historical anonymous mode selects a private invoice. The signer-dependent zapout feed is replaced with a retirement notice. Obsolete signing and authority endpoints return HTTP 410 with `Cache-Control: no-store`, so stale clients fail explicitly.

The checkout-pricing source moved from `apps/anon-zap-signer` to `apps/checkout-pricing`; its Worker names and pricing implementation are unchanged. Keep both checkout-pricing Workers, the address gateway and its payment paths, and all other unrelated services. PostHog retirement is a separate change.

## Production sequence

1. Review and merge the application change. Verify the Market and Merchant production deployments report that merged commit. Verify the Market preview deployment independently.
2. Check guest tip invoice preparation, private guest checkout, signed-in tips, and historical order recovery. Do not count an invoice or a wallet opening as proof of payment. A funded payment requires separate authorization. Confirm obsolete API endpoints return 410 and new assets do not reference signer endpoints.
3. In the `conduit-market` Pages project, remove only `ANON_ZAP_SIGNER_SERVICE` and `ANON_ZAP_RATE_LIMIT_SERVICE` from both production and preview service bindings. Preserve every unrelated binding and setting. Redeploy the application and confirm active deployment bindings no longer reference either anonymous signer.
4. Check other live Workers and Pages projects for dependencies. Delete `conduit-anon-zap-signer-preview`, verify the preview app, then delete `conduit-anon-zap-signer`. Do not force deletion through an unresolved service dependency.
5. Remove obsolete signer-only Market configuration by name after confirming no caller remains: `ANON_SIGNER_REQUEST_AUTH_SECRET`, `ANON_ZAP_*`, and `VITE_ANON_ZAP_SIGNER_*`. Do not read secret values or remove similarly named checkout-pricing configuration. Confirm the final inventory and the availability of the Conduit tip metadata endpoint.

## Rollback boundary

Before Worker deletion, app rollback also requires restoring the two service bindings if they were detached. After deletion, do not roll back to a signer-dependent app until the signer services, dedicated secrets and bindings have been restored through approved secret-management procedures. Keep the plain Lightning payment path available while investigating. No payment or order data migration is required.
