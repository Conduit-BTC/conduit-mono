# Telemetry collection pause

Browser analytics collection is unconditionally disabled in the shared Market
and Merchant reporting entry points. They do not load a provider, queue events,
create provider storage, or send events, even with legacy environment settings.
The browser PostHog dependency and its web-vitals extension are removed.

Commerce GMV reporting is independently disabled and returns false without
retaining orders or issuing requests. Anonymous-signer analytics delivery is
also disabled; signer authorization, rate limits and responses are unchanged.

Pure legacy configuration/sanitization helpers and inert instrumentation callers
remain temporarily to keep this release separate from their wider removal.
The proxy source and deployed Worker remain until the retirement release is
verified. This change does not delete infrastructure or historical PostHog data.
Existing legal archives are unchanged; publication of updated disclosures is a
separate release step.

## Release verification and remaining removal

1. Review focused no-delivery tests, workspace checks and built assets.
2. Verify approved preview and production builds on Linux: browser navigation,
   checkout/order recovery and merchant flows must emit no analytics traffic.
3. Verify a retained old client keeps functioning when the analytics endpoint
   rejects requests, times out or fails DNS. Old cached clients may still try
   to send; errors must remain independent of product and payment behavior.
4. Remove inert instrumentation, obsolete provider contracts/tests, test hooks,
   environment declarations and the proxy workspace in a scoped follow-up.
   Preserve functional attribution, local observers and operational monitoring.
5. Publish reviewed disclosures using the append-only legal version process.
6. Only after release verification and explicit operator approval, remove the
   deployed proxy, its custom domain/DNS and proven-exclusive configuration.
   Preserve the PostHog account/history, shared credentials and other Workers.

A normal rollback to an older client build restores that build's analytics
behavior. Prefer a forward fix that retains the pause; review any rollback
against the current disclosure and infrastructure state before using it.
