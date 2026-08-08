import { getCartCommerceFingerprint, type CartItem } from "./cart-model"

const HUD_ZAP_INTENT_TTL_MS = 30_000

export type HudZapAuthorization = {
  merchantPubkey: string
  buyerPubkey: string
  cartFingerprint: string
  totalMsats: number
  createdAt: number
}

let pendingIntent: HudZapAuthorization | null = null

export function getHudZapCartFingerprint(items: readonly CartItem[]): string {
  return getCartCommerceFingerprint(items)
}

export function armHudZapIntent(intent: HudZapAuthorization): void {
  pendingIntent = intent
}

export function consumeHudZapIntent(
  merchantPubkey: string | undefined,
  nowMs = Date.now()
): HudZapAuthorization | null {
  const intent = pendingIntent
  pendingIntent = null
  return intent &&
    merchantPubkey === intent.merchantPubkey &&
    nowMs >= intent.createdAt &&
    nowMs - intent.createdAt <= HUD_ZAP_INTENT_TTL_MS
    ? intent
    : null
}

export type HudZapAuthorizationInput = {
  merchantPubkey: string | undefined
  buyerPubkey: string | null
  items: readonly CartItem[]
  totalMsats: number | null
  nowMs?: number
}

export type HudZapAuthorizationRejection = "expired" | "changed"

/**
 * Names why an armed authorization cannot be used, so checkout can explain a
 * slow merchant endpoint separately from a cart or identity change.
 */
export function getHudZapAuthorizationRejection(
  authorization: HudZapAuthorization,
  input: HudZapAuthorizationInput
): HudZapAuthorizationRejection | null {
  const nowMs = input.nowMs ?? Date.now()
  if (
    nowMs < authorization.createdAt ||
    nowMs - authorization.createdAt > HUD_ZAP_INTENT_TTL_MS
  ) {
    return "expired"
  }
  if (
    input.merchantPubkey !== authorization.merchantPubkey ||
    input.buyerPubkey !== authorization.buyerPubkey ||
    input.totalMsats !== authorization.totalMsats ||
    getHudZapCartFingerprint(input.items) !== authorization.cartFingerprint
  ) {
    return "changed"
  }
  return null
}

export function isHudZapAuthorizationValid(
  authorization: HudZapAuthorization,
  input: HudZapAuthorizationInput
): boolean {
  return getHudZapAuthorizationRejection(authorization, input) === null
}
