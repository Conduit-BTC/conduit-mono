# Product telemetry retirement

Market and Merchant contain no browser analytics reporting entry points,
provider SDK, event contracts, GMV reporting, analytics error listeners, or
analytics test hooks. Anonymous-signer reporting and the PostHog proxy workspace
are removed. Old analytics environment settings cannot enable collection in
these builds. The policy check rejects retired provider APIs/configuration and
continues to enforce the cookieless source and dependency restrictions.

Checkout referral data used in order creation, payment state and recovery,
local error presentation, and content-free local performance/NIP-17 observers
remain. The retained payment/recovery and gateway test suite is unchanged.
Removed test suites are not restored.

Removing source does not delete the deployed proxy, its hostname, credentials,
or historical PostHog data. Existing legal archives and the selected policy
are unchanged. See [the disclosure draft](telemetry-disclosure-draft.md) for
proposed copy pending release evidence and maintainer/legal approval.

## Release and operator sequence

1. Review current-head checks and production artifact scans. Verify approved
   previews on Linux: navigation, signer reconnect, checkout/order recovery,
   and merchant actions must produce no retired analytics requests.
2. Verify a retained old client remains functional when analytics requests are
   rejected, time out, or fail DNS. Cached old clients can continue attempting
   collection until replaced; record this limitation with the release cutoff.
3. Obtain release approval, deploy the exact verified product builds, confirm
   the live builds and absence of analytics requests, and publish the reviewed
   disclosure as a new legal version with an approved effective date.
4. Inventory the live proxy, custom domain/DNS, rate-limit bindings, and
   analytics settings. Obtain explicit approval for the exact deletion set.
   Delete only resources and credentials proven exclusive to this integration.
5. Verify retirement and record the cutoff. Preserve the PostHog account,
   historical data, shared credentials, other Workers, and functional services.

A rollback to an older client restores that client's analytics behavior. Prefer
forward fixes; check any rollback against the current disclosure and service
state. Source and asset scans do not replace browser or production observation.
