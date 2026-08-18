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
