import {
  getTelemetryAmountBucket,
  type BrowserTelemetryEventProperties,
} from "./telemetry"

export type TelemetryResultStatus =
  "success" | "failure" | "blocked" | "unavailable" | "ambiguous"

export type PaymentAttemptTelemetryRail = "wallet" | "webln" | "none"
export type ProductPublishTelemetryFamily =
  "create" | "update" | "delivery_retry"
export type ShippingPublishTelemetryFamily = "publish" | "clear"
export type MerchantSetupTelemetryStep =
  "profile" | "payments" | "shipping" | "network"
export type ProductDetailTelemetryAction = "add_to_cart" | "view_cart"

export type Nip17DeclarationTelemetryClass =
  | "declared"
  | "distribution_pending"
  | "signed_empty"
  | "not_observed"
  | "lookup_partial"
  | "lookup_unavailable"
  | "malformed"
  | "unknown"
export type Nip17DeliveryTelemetryRoute =
  "declared_inbox" | "compatibility_order" | "blocked" | "not_applicable"
export type Nip17AckTelemetryOutcome =
  "zero" | "partial" | "positive" | "not_applicable"
export type Nip17RepairTelemetryOutcome =
  "discoverable" | "confirmation_pending" | "failed" | "not_applicable"
export type Nip17BlockTelemetryReason =
  | "sender_not_ready"
  | "recipient_not_ready"
  | "recipient_lookup_failed"
  | "recipient_declaration_distribution_pending"
  | "recipient_declaration_signed_empty"
  | "recipient_declaration_malformed"
  | "not_applicable"

export interface Nip17CompatibilityResultTelemetryInput {
  action: "order_delivery" | "declaration_repair"
  declarationClass: Nip17DeclarationTelemetryClass
  deliveryRoute: Nip17DeliveryTelemetryRoute
  ackOutcome: Nip17AckTelemetryOutcome
  repairOutcome: Nip17RepairTelemetryOutcome
  blockReason: Nip17BlockTelemetryReason
}

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

/** Build the fixed-label, content-free CND-219 rollout counter. */
export function buildNip17CompatibilityResultTelemetryProperties(
  input: Nip17CompatibilityResultTelemetryInput
): BrowserTelemetryEventProperties {
  return {
    action: input.action,
    declaration_class: input.declarationClass,
    delivery_route: input.deliveryRoute,
    ack_outcome: input.ackOutcome,
    repair_outcome: input.repairOutcome,
    block_reason: input.blockReason,
  }
}
