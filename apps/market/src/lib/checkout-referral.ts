import {
  recordBrowserTelemetryEvent,
  resolveCheckoutAttribution,
  checkoutAttributionTelemetryProperties,
  type CheckoutAttribution,
  type CheckoutIntent,
} from "@conduit/core"
import type { CartItem } from "./cart-model"

const KEY = "conduit:checkout-referral:v1"
const MAX_AGE_MS = 30 * 60_000

export type CheckoutReferralClaim = CheckoutAttribution & {
  linkMode: "buy" | "cart"
}

type Context = CheckoutReferralClaim & {
  merchantPubkey: string
  purchaseId: string
  lines: { coordinate: string; quantity: number }[]
  sessionScope: string
  createdAt: number
  orderSubmitted: boolean
}

// Failed writes/removals must never revive an older persisted purchase.
let preferMemory = false
let fallback: Context | null = null

function save(value: Context): void {
  fallback = value
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value))
    preferMemory = false
  } catch {
    preferMemory = true
    /* tab memory remains available */
  }
}

export function clearCheckoutReferral(): void {
  fallback = null
  try {
    window.sessionStorage.removeItem(KEY)
    preferMemory = false
  } catch {
    preferMemory = true
    /* storage unavailable */
  }
}

function read(): Context | null {
  let value = fallback
  if (!preferMemory) {
    try {
      const raw = window.sessionStorage.getItem(KEY)
      value = raw ? (JSON.parse(raw) as Context) : null
    } catch {
      /* use tab memory */
    }
  }
  if (
    !value ||
    !["buy", "cart"].includes(value.linkMode) ||
    !["claimed", "referrer", "partner"].includes(value.sourceMethod) ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt > Date.now() ||
    Date.now() - value.createdAt > MAX_AGE_MS ||
    !Array.isArray(value.lines) ||
    typeof value.sessionScope !== "string"
  ) {
    clearCheckoutReferral()
    return null
  }
  const attribution = resolveCheckoutAttribution({
    ...(value.sourceDomain
      ? {
          source: {
            domain: value.sourceDomain,
            method: value.sourceMethod as "claimed" | "referrer",
          },
        }
      : {}),
    partner: value.partnerCode,
  })
  if (!attribution) {
    clearCheckoutReferral()
    return null
  }
  value = { ...value, ...attribution, partnerCode: attribution.partnerCode }
  fallback = value
  return value
}

export function bindCheckoutReferral(
  intent: CheckoutIntent,
  merchantPubkey: string,
  purchaseId: string,
  sessionScope: string,
  createdAt = Date.now()
): void {
  const attribution = resolveCheckoutAttribution(intent)
  if (!attribution) {
    clearCheckoutReferral()
    return
  }
  save({
    ...attribution,
    linkMode: intent.mode,
    merchantPubkey,
    purchaseId,
    lines: intent.items
      .map(({ coordinate, quantity }) => ({ coordinate, quantity }))
      .sort((a, b) => a.coordinate.localeCompare(b.coordinate)),
    sessionScope,
    createdAt,
    orderSubmitted: false,
  })
}

export function getCheckoutReferralClaim(
  merchantPubkey: string | undefined,
  purchaseId: string | undefined,
  items: readonly CartItem[],
  sessionScope: string | undefined
): CheckoutReferralClaim | undefined {
  // A stale async buyer frame has no authority to read or clear a newer binding.
  if (!sessionScope) return undefined
  const current = read()
  if (!current) return undefined
  const lines = items
    .map((item) => ({ coordinate: item.productId, quantity: item.quantity }))
    .sort((a, b) => a.coordinate.localeCompare(b.coordinate))
  if (
    current.merchantPubkey !== merchantPubkey ||
    current.purchaseId !== purchaseId ||
    current.sessionScope !== sessionScope ||
    JSON.stringify(current.lines) !== JSON.stringify(lines)
  ) {
    clearCheckoutReferral()
    return undefined
  }
  return {
    ...(current.sourceDomain ? { sourceDomain: current.sourceDomain } : {}),
    sourceMethod: current.sourceMethod,
    ...(current.partnerCode ? { partnerCode: current.partnerCode } : {}),
    linkMode: current.linkMode,
  }
}

export function recordCheckoutReferralOrderSubmitted(
  merchantPubkey: string | undefined,
  purchaseId: string | undefined,
  items: readonly CartItem[],
  sessionScope: string | undefined
): void {
  const claim = getCheckoutReferralClaim(
    merchantPubkey,
    purchaseId,
    items,
    sessionScope
  )
  const current = read()
  if (!claim || !current || current.orderSubmitted) return
  save({ ...current, orderSubmitted: true })
  recordBrowserTelemetryEvent({
    app: "market",
    eventName: "checkout_handoff_result",
    properties: {
      surface: "checkout",
      handoff_stage: "order_submitted",
      mode: claim.linkMode,
      ...checkoutAttributionTelemetryProperties(claim),
    },
  })
}
