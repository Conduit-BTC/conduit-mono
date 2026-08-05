import {
  getTelemetryAmountBucket,
  type BrowserTelemetryEventProperties,
} from "./telemetry"

export type TelemetryResultStatus =
  "success" | "failure" | "blocked" | "unavailable" | "ambiguous"

export type PaymentAttemptTelemetryRail = "nwc" | "webln" | "none"
export type ProductPublishTelemetryFamily =
  "create" | "update" | "delivery_retry"
export type ShippingPublishTelemetryFamily = "publish" | "clear"
export type MerchantSetupTelemetryStep =
  "profile" | "payments" | "shipping" | "network"
export type ProductDetailTelemetryAction = "add_to_cart" | "view_cart"

export function getTelemetryLatencyBucket(
  durationMs: number | null | undefined
): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return "unknown"
  }

  const normalized = Math.max(0, durationMs)
  if (normalized < 250) return "lt_250ms"
  if (normalized < 1_000) return "250ms_1s"
  if (normalized < 3_000) return "1s_3s"
  if (normalized < 10_000) return "3s_10s"
  return "10s_plus"
}

export function buildPaymentAttemptResultTelemetryProperties(input: {
  amountSats: number | null | undefined
  latencyMs?: number | null
  rail: PaymentAttemptTelemetryRail
  status: TelemetryResultStatus
}): BrowserTelemetryEventProperties {
  return {
    amount_bucket: getTelemetryAmountBucket(input.amountSats),
    latency_bucket: getTelemetryLatencyBucket(input.latencyMs),
    mode: "automatic",
    rail: input.rail,
    status: input.status,
  }
}

export function buildProductPublishResultTelemetryProperties(input: {
  eventFamily: ProductPublishTelemetryFamily
  latencyMs: number
  status: Extract<TelemetryResultStatus, "success" | "failure">
}): BrowserTelemetryEventProperties {
  return {
    event_family: input.eventFamily,
    latency_bucket: getTelemetryLatencyBucket(input.latencyMs),
    status: input.status,
  }
}

export function buildShippingPublishResultTelemetryProperties(input: {
  eventFamily: ShippingPublishTelemetryFamily
  latencyMs: number
  status: Extract<TelemetryResultStatus, "success" | "failure">
}): BrowserTelemetryEventProperties {
  return {
    event_family: input.eventFamily,
    latency_bucket: getTelemetryLatencyBucket(input.latencyMs),
    status: input.status,
  }
}

export function buildMerchantSetupStepResultTelemetryProperties(input: {
  status: Extract<TelemetryResultStatus, "success" | "blocked">
  step: MerchantSetupTelemetryStep
}): BrowserTelemetryEventProperties {
  return {
    status: input.status,
    step: input.step,
    surface: "merchant_readiness",
  }
}

export function buildProductDetailActionTelemetryProperties(input: {
  action: ProductDetailTelemetryAction
  productType: "physical" | "digital"
}): BrowserTelemetryEventProperties {
  return {
    action: input.action,
    product_type: input.productType,
    surface: "product_detail",
  }
}
