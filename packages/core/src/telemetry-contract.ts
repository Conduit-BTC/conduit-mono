/**
 * Dependency-free browser telemetry contract shared by the in-app sanitizer
 * (`packages/core/src/telemetry.ts`) and the PostHog proxy worker
 * (`apps/posthog-proxy`). Keep this module import-free so edge bundles can
 * consume it without pulling app or protocol code.
 */

export const browserTelemetryEventNames = [
  "app_load_result",
  "client_error_result",
  "signer_connected",
  "signer_disconnected",
  "cart_add",
  "cart_remove",
  "cart_clear",
  "checkout_initiated",
  "checkout_step_result",
  "checkout_success",
  "checkout_result",
  "relay_connect_result",
  "relay_publish_result",
  "wallet_connect_result",
  "payment_attempt_result",
  "merchant_setup_step_result",
  "product_publish_result",
  "shipping_publish_result",
  "market_browse_action",
  "product_detail_action",
] as const

export type BrowserTelemetryEventName =
  (typeof browserTelemetryEventNames)[number]

export type BrowserTelemetryApp = "market" | "merchant"

export const officialProductTelemetryHostnames = {
  market: "shop.conduit.market",
  merchant: "sell.conduit.market",
} as const satisfies Record<BrowserTelemetryApp, string>

export function getOfficialProductTelemetryApp(
  hostname: string
): BrowserTelemetryApp | null {
  const normalizedHostname = hostname.trim().toLowerCase()
  if (normalizedHostname === officialProductTelemetryHostnames.market) {
    return "market"
  }
  if (normalizedHostname === officialProductTelemetryHostnames.merchant) {
    return "merchant"
  }
  return null
}

export const browserTelemetryPropertyNames = [
  "event_name",
  "app",
  "network",
  "status",
  "latency_bucket",
  "count",
  "time_bucket",
  "surface",
  "action",
  "step",
  "mode",
  "rail",
  "method",
  "event_family",
  "count_bucket",
  "result_count_bucket",
  "amount_bucket",
  "product_type",
  "page_url",
  "page_path",
] as const

export type BrowserTelemetryPropertyName =
  (typeof browserTelemetryPropertyNames)[number]

interface BrowserTelemetryEventPropertyContract {
  apps: readonly BrowserTelemetryApp[]
  required: readonly BrowserTelemetryPropertyName[]
  optional: readonly BrowserTelemetryPropertyName[]
}

const browserTelemetryBasePropertyNames = [
  "event_name",
  "app",
  "page_url",
  "page_path",
] as const
const countAndTimePropertyNames = ["count", "time_bucket"] as const
const timePropertyNames = ["time_bucket"] as const
const sharedTelemetryApps = ["market", "merchant"] as const
const marketTelemetryApps = ["market"] as const
const merchantTelemetryApps = ["merchant"] as const

/**
 * Event-specific property contracts. The four base fields above are required
 * for every custom browser event. Raw `count` and `time_bucket` remain
 * documented but closed by the value allowlist until shared bounded builders
 * define their values.
 */
export const browserTelemetryEventPropertyContracts = {
  app_load_result: {
    apps: sharedTelemetryApps,
    required: ["network", "status"],
    optional: ["latency_bucket", ...countAndTimePropertyNames],
  },
  client_error_result: {
    apps: sharedTelemetryApps,
    required: ["surface", "action", "event_family", "mode", "status"],
    optional: [],
  },
  signer_connected: {
    apps: sharedTelemetryApps,
    required: ["method", "status"],
    optional: countAndTimePropertyNames,
  },
  signer_disconnected: {
    apps: sharedTelemetryApps,
    required: ["method", "status"],
    optional: countAndTimePropertyNames,
  },
  cart_add: {
    apps: marketTelemetryApps,
    required: ["surface", "action", "status", "count_bucket", "product_type"],
    optional: timePropertyNames,
  },
  cart_remove: {
    apps: marketTelemetryApps,
    required: ["surface", "action", "status", "count_bucket", "product_type"],
    optional: timePropertyNames,
  },
  cart_clear: {
    apps: marketTelemetryApps,
    required: ["surface", "action", "status", "count_bucket", "product_type"],
    optional: timePropertyNames,
  },
  checkout_initiated: {
    apps: marketTelemetryApps,
    required: ["surface", "status", "count_bucket", "product_type"],
    optional: timePropertyNames,
  },
  checkout_step_result: {
    apps: marketTelemetryApps,
    required: [
      "surface",
      "step",
      "mode",
      "rail",
      "status",
      "count_bucket",
      "amount_bucket",
      "product_type",
    ],
    optional: timePropertyNames,
  },
  checkout_success: {
    apps: marketTelemetryApps,
    required: [
      "surface",
      "mode",
      "rail",
      "status",
      "count_bucket",
      "amount_bucket",
      "product_type",
    ],
    optional: timePropertyNames,
  },
  checkout_result: {
    apps: marketTelemetryApps,
    required: [
      "surface",
      "mode",
      "rail",
      "network",
      "status",
      "count_bucket",
      "amount_bucket",
      "product_type",
    ],
    optional: timePropertyNames,
  },
  relay_connect_result: {
    apps: sharedTelemetryApps,
    required: ["network", "status"],
    optional: ["latency_bucket", ...countAndTimePropertyNames],
  },
  relay_publish_result: {
    apps: sharedTelemetryApps,
    required: ["network", "status"],
    optional: ["latency_bucket", ...countAndTimePropertyNames],
  },
  wallet_connect_result: {
    apps: marketTelemetryApps,
    required: ["rail", "method", "status"],
    optional: ["latency_bucket", ...countAndTimePropertyNames],
  },
  payment_attempt_result: {
    apps: marketTelemetryApps,
    required: ["rail", "mode", "status", "latency_bucket", "amount_bucket"],
    optional: countAndTimePropertyNames,
  },
  merchant_setup_step_result: {
    apps: merchantTelemetryApps,
    required: ["surface", "step", "status"],
    optional: countAndTimePropertyNames,
  },
  product_publish_result: {
    apps: merchantTelemetryApps,
    required: ["event_family", "status", "latency_bucket"],
    optional: countAndTimePropertyNames,
  },
  shipping_publish_result: {
    apps: merchantTelemetryApps,
    required: ["event_family", "status", "latency_bucket"],
    optional: countAndTimePropertyNames,
  },
  market_browse_action: {
    apps: marketTelemetryApps,
    required: ["surface", "action", "status", "result_count_bucket"],
    optional: ["product_type", ...timePropertyNames],
  },
  product_detail_action: {
    apps: marketTelemetryApps,
    required: ["surface", "action", "product_type"],
    optional: timePropertyNames,
  },
} as const satisfies Record<
  BrowserTelemetryEventName,
  BrowserTelemetryEventPropertyContract
>

function getBrowserTelemetryEventPropertyContract(
  eventName: string
): BrowserTelemetryEventPropertyContract | undefined {
  return (
    browserTelemetryEventPropertyContracts as Partial<
      Record<string, BrowserTelemetryEventPropertyContract>
    >
  )[eventName]
}

export function isAllowedBrowserTelemetryEventProperty(
  eventName: string,
  propertyName: string
): boolean {
  const contract = getBrowserTelemetryEventPropertyContract(eventName)
  if (!contract) return false
  return (
    browserTelemetryBasePropertyNames.includes(
      propertyName as (typeof browserTelemetryBasePropertyNames)[number]
    ) ||
    contract.required.includes(propertyName as BrowserTelemetryPropertyName) ||
    contract.optional.includes(propertyName as BrowserTelemetryPropertyName)
  )
}

export function isAllowedBrowserTelemetryEventApp(
  eventName: string,
  app: string
): app is BrowserTelemetryApp {
  const contract = getBrowserTelemetryEventPropertyContract(eventName)
  return contract?.apps.includes(app as BrowserTelemetryApp) === true
}

export function hasRequiredBrowserTelemetryEventProperties(
  eventName: string,
  properties: Readonly<Record<string, unknown>>
): boolean {
  const contract = getBrowserTelemetryEventPropertyContract(eventName)
  if (!contract) return false

  return [...browserTelemetryBasePropertyNames, ...contract.required].every(
    (propertyName) =>
      Object.prototype.hasOwnProperty.call(properties, propertyName)
  )
}

type BrowserTelemetryLabelPropertyName = Exclude<
  BrowserTelemetryPropertyName,
  "page_path" | "page_url"
>

const countBucketValues = ["0", "1", "2_3", "4_10", "11_plus"] as const

const browserTelemetryLabelValues = {
  event_name: browserTelemetryEventNames,
  app: ["market", "merchant"],
  network: ["browser"],
  status: [
    "success",
    "failure",
    "blocked",
    "unavailable",
    "ambiguous",
    "invalid",
    "disconnected",
    "connecting",
    "connected",
    "pay_capable",
    "unsupported",
    "unreachable",
    "error",
    "started",
    "failed",
    "order_sent",
    "order_queued",
    "queued",
    "order_sent_local_tracking_failed",
    "success_local_tracking_failed",
  ],
  latency_bucket: [
    "unknown",
    "lt_250ms",
    "250ms_1s",
    "1s_3s",
    "3s_10s",
    "10s_plus",
  ],
  // No browser emitter currently defines raw count or time-bucket values.
  // Keep them closed until a shared bounded builder establishes the contract.
  count: [],
  time_bucket: [],
  surface: [
    "browser",
    "cart",
    "checkout",
    "merchant_readiness",
    "product_detail",
    "storefront",
  ],
  action: [
    "window_error",
    "unhandled_rejection",
    "react_error_boundary",
    "add",
    "remove",
    "clear_all",
    "clear_merchant",
    "storefront_search",
    "storefront_search_clear",
    "add_to_cart",
    "view_cart",
  ],
  step: [
    "availability",
    "profile",
    "payments",
    "shipping",
    "network",
    "order_submit",
    "direct_payment",
  ],
  mode: [
    "handled",
    "unhandled",
    "automatic",
    "checkout",
    "order_first",
    "anonymous_public_zap",
    "public_zap_as_shopper",
    "private_checkout",
  ],
  rail: ["lightning", "wallet", "nwc", "webln", "none"],
  method: ["nip07", "nip46", "nwc"],
  event_family: [
    "type_error",
    "reference_error",
    "range_error",
    "syntax_error",
    "aggregate_error",
    "dom_exception",
    "error",
    "non_error",
    "create",
    "update",
    "delivery_retry",
    "publish",
    "clear",
  ],
  count_bucket: countBucketValues,
  result_count_bucket: countBucketValues,
  amount_bucket: [
    "unknown",
    "lt_1k_sats",
    "1k_10k_sats",
    "10k_100k_sats",
    "100k_1m_sats",
    "1m_plus_sats",
  ],
  product_type: ["physical", "digital", "mixed", "unknown"],
} as const satisfies Record<
  BrowserTelemetryLabelPropertyName,
  readonly string[]
>

/**
 * Accept only the enum and bucket values emitted by the shared telemetry
 * helpers and current browser call sites. Exact values, rather than a syntax
 * pattern, keep identifiers and free text out of otherwise allowlisted keys.
 */
export function isAllowedBrowserTelemetryLabelValue(
  propertyName: string,
  value: string,
  eventName?: string
): boolean {
  const allowedValues = (
    browserTelemetryLabelValues as Partial<Record<string, readonly string[]>>
  )[propertyName]
  if (!allowedValues?.includes(value)) return false
  if (
    propertyName === "app" &&
    eventName !== undefined &&
    getBrowserTelemetryEventPropertyContract(eventName) &&
    !isAllowedBrowserTelemetryEventApp(eventName, value)
  ) {
    return false
  }
  return (
    propertyName !== "event_name" ||
    eventName === undefined ||
    value === eventName
  )
}
