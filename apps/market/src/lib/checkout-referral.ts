import {
  recordBrowserTelemetryEvent,
  resolveCheckoutPartnerCode,
  type CheckoutIntent,
} from "@conduit/core"
import type { CartItem } from "./cart-model"

const KEY = "conduit:checkout-referral:v1"
const MAX_AGE_MS = 30 * 60_000

export type CheckoutReferralClaim = {
  partnerCode: string
  linkMode: "buy" | "cart"
}

type Context = CheckoutReferralClaim & {
  merchantPubkey: string
  purchaseId: string
  coordinates: string[]
  createdAt: number
  orderSubmitted: boolean
}

let fallback: Context | null = null

function save(value: Context): void {
  fallback = value
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    /* tab memory remains available */
  }
}

export function clearCheckoutReferral(): void {
  fallback = null
  try {
    window.sessionStorage.removeItem(KEY)
  } catch {
    /* storage unavailable */
  }
}

function read(): Context | null {
  let value = fallback
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (raw) value = JSON.parse(raw) as Context
  } catch {
    /* use tab memory */
  }
  if (
    !value ||
    !resolveCheckoutPartnerCode(value.partnerCode) ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt > Date.now() ||
    Date.now() - value.createdAt > MAX_AGE_MS ||
    !Array.isArray(value.coordinates)
  ) {
    clearCheckoutReferral()
    return null
  }
  fallback = value
  return value
}

export function bindCheckoutReferral(
  intent: CheckoutIntent,
  merchantPubkey: string,
  purchaseId: string
): void {
  const partnerCode = resolveCheckoutPartnerCode(intent.partner)
  if (!partnerCode) {
    clearCheckoutReferral()
    return
  }
  save({
    partnerCode,
    linkMode: intent.mode,
    merchantPubkey,
    purchaseId,
    coordinates: intent.items.map((item) => item.coordinate).sort(),
    createdAt: Date.now(),
    orderSubmitted: false,
  })
}

export function getCheckoutReferralClaim(
  merchantPubkey: string | undefined,
  purchaseId: string | undefined,
  items: readonly CartItem[]
): CheckoutReferralClaim | undefined {
  const current = read()
  if (!current) return undefined
  const coordinates = [...new Set(items.map((item) => item.productId))].sort()
  if (
    current.merchantPubkey !== merchantPubkey ||
    current.purchaseId !== purchaseId ||
    JSON.stringify(current.coordinates) !== JSON.stringify(coordinates)
  ) {
    clearCheckoutReferral()
    return undefined
  }
  return { partnerCode: current.partnerCode, linkMode: current.linkMode }
}

export function recordCheckoutReferralOrderSubmitted(
  merchantPubkey: string | undefined,
  purchaseId: string | undefined,
  items: readonly CartItem[]
): void {
  const claim = getCheckoutReferralClaim(merchantPubkey, purchaseId, items)
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
      partner_code: claim.partnerCode,
    },
  })
  clearCheckoutReferral()
}
