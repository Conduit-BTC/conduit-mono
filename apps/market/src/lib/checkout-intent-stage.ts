import {
  parseCheckoutIntentFragment,
  recordBrowserTelemetryEvent,
  resolveCheckoutAttribution,
  checkoutAttributionTelemetryProperties,
  type CheckoutIntentParseResult,
} from "@conduit/core"

import { clearCheckoutReferral } from "./checkout-referral"

const KEY = "conduit:checkout-intent:v1"
const MAX_AGE_MS = 30 * 60_000

export type StagedCheckoutIntent = {
  id: string
  createdAt: number
  result: CheckoutIntentParseResult
  reportedStages?: string[]
}

// Failed writes/removals must never revive an older persisted purchase.
let preferMemory = false
let fallback: StagedCheckoutIntent | null = null

function save(stage: StagedCheckoutIntent): void {
  fallback = stage
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(stage))
    preferMemory = false
  } catch {
    preferMemory = true
    /* tab memory remains available */
  }
}

export function clearStagedCheckoutIntent(): void {
  fallback = null
  try {
    window.sessionStorage.removeItem(KEY)
    preferMemory = false
  } catch {
    preferMemory = true
    /* storage unavailable */
  }
}

export function getStagedCheckoutIntent(): StagedCheckoutIntent | null {
  let candidate = fallback
  if (!preferMemory) {
    try {
      const raw = window.sessionStorage.getItem(KEY)
      candidate = raw ? (JSON.parse(raw) as StagedCheckoutIntent) : null
    } catch {
      /* use tab memory */
    }
  }
  if (
    !candidate ||
    typeof candidate.id !== "string" ||
    !Number.isFinite(candidate.createdAt) ||
    Date.now() - candidate.createdAt > MAX_AGE_MS ||
    candidate.createdAt > Date.now() ||
    !candidate.result ||
    !["valid", "invalid"].includes(candidate.result.status)
  ) {
    clearStagedCheckoutIntent()
    return null
  }
  fallback = candidate
  return candidate
}

export type CheckoutHandoffStage =
  | "arrival"
  | "products_resolved"
  | "checkout_ready"
  | "cart_conflict"
  | "retryable_lookup_failure"
  | "rejected_link"
  | "order_submitted"

export function recordCheckoutHandoffStage(
  stage: StagedCheckoutIntent,
  handoffStage: CheckoutHandoffStage
): void {
  const current = getStagedCheckoutIntent()
  if (
    !current ||
    current.id !== stage.id ||
    current.reportedStages?.includes(handoffStage)
  )
    return
  save({
    ...current,
    reportedStages: [...(current.reportedStages ?? []), handoffStage],
  })
  const attribution =
    current.result.status === "valid"
      ? resolveCheckoutAttribution(current.result.intent)
      : undefined
  recordBrowserTelemetryEvent({
    app: "market",
    eventName: "checkout_handoff_result",
    properties: {
      surface: "checkout",
      handoff_stage: handoffStage,
      mode:
        current.result.status === "valid"
          ? current.result.intent.mode
          : "unknown",
      ...checkoutAttributionTelemetryProperties(attribution),
    },
  })
}

/** Called before the Market provider tree or browser telemetry can observe the URL. */
export function captureCheckoutIntentFragment(): void {
  if (window.location.pathname !== "/checkout" || !window.location.hash) return
  clearCheckoutReferral()
  const result = parseCheckoutIntentFragment(
    window.location.hash,
    document.referrer
  )
  const stage: StagedCheckoutIntent = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    result,
  }
  save(stage)
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname
  )
  recordCheckoutHandoffStage(
    stage,
    result.status === "valid" ? "arrival" : "rejected_link"
  )
}
