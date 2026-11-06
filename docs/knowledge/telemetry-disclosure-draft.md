# Product telemetry retirement disclosure draft

Status: prepared for maintainer/legal review, not an effective policy. No new
version or effective date is selected. Do not edit archived legal versions.
Publish a new version only after the approved builds and actual service state
support the statements below. The current v1.3 policy remains selected.

## Proposed replacement for privacy section 6

### 6. Product Analytics Retirement

The current Conduit Product Apps do not send product analytics, pageview events,
Web Vitals, or estimated commerce volume to PostHog or Plausible. The retired
analytics integration, including browser event collection and anonymous
checkout-authorization outcome reporting, has been removed from these releases.
Local payment state, recovery records, error messages, and content-free local
operational observations remain available to run the Product Apps; they are not
sent through the retired analytics integration.

Previously downloaded or cached releases may still attempt to contact the old
analytics service. Updating or reloading the Product Apps is necessary to use
the new release. Retiring collection does not by itself delete previously
collected information from PostHog or remove old browser storage.

Historical analytics information remains subject to the retention and deletion
arrangements that apply to that information. The prior policy recorded an
84-month plan-managed PostHog event-retention window. A shorter retention period
or deletion of historical records must not be assumed from this retirement.

Hosting, content delivery, security, and the services needed for product
functions continue to process the information described in the other sections
of this policy. These operational data flows are separate from the retired
analytics integration. Retirement does not imply that ordinary connection
metadata is never processed.

## Related copy changes in the next legal version

- Introduction: replace the assertion that Website and Product Apps use different
  analytics flows with “The Website and Product Apps serve different purposes
  and have separate privacy policies.” Keep the existing Website policy link.
- Section 9 service-provider list: replace the unqualified “PostHog” item with
  “PostHog for historical analytics records collected before retirement”. Keep
  all other applicable providers and independent third-party warnings.
- Section 13 privacy choices: replace the browser-analytics GPC/DNT exception
  and first-party GMV exception with “The current Product Apps do not enable
  the retired analytics integration, regardless of Do Not Track or Global
  Privacy Control settings. These settings do not disable product functions
  such as relay communication, payment processing by your selected providers,
  or operational security controls.” Preserve unrelated choice language.

## Publication evidence still needed

Record the approved release identifiers and confirmed collection cutoff;
verify Linux browser behavior with current and retained old clients; confirm
historical retention/deletion settings with the provider; review this text
against the actual hosting and service state; select the effective date and
append the new legal version. Do not claim the live proxy or historical data
has been deleted until those operations are separately approved and verified.
