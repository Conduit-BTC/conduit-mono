import {
  decodeProductReference,
  encodeProductNaddr,
} from "./protocol/product-reference"

export const CHECKOUT_INTENT_MAX_FRAGMENT_BYTES = 8 * 1024
export const CHECKOUT_INTENT_MAX_JSON_BYTES = 6 * 1024
export const CHECKOUT_INTENT_MAX_ITEMS = 20
export const CHECKOUT_INTENT_MAX_UNITS = 100

export type CheckoutIntentItem = {
  product: string
  coordinate: string
  quantity: number
}

export type CheckoutIntent = {
  v: 1
  mode: "buy" | "cart"
  items: CheckoutIntentItem[]
  /** A syntactically valid claim. Registration is checked separately. */
  partner?: string
}

export type CheckoutIntentError = "invalid_intent" | "unsupported_version"
export type CheckoutIntentParseResult =
  | { status: "valid"; intent: CheckoutIntent }
  | { status: "invalid"; error: CheckoutIntentError }

export function isCheckoutPartnerCode(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{2,63}$/.test(value)
}

function validEncodedParameters(fragment: string): boolean {
  try {
    for (const component of fragment.split(/[&=]/))
      decodeURIComponent(component)
    return true
  } catch {
    return false
  }
}

function parseProduct(
  value: unknown,
  quantity: unknown
): CheckoutIntentItem | null {
  if (
    typeof value !== "string" ||
    !/^naddr1[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(value)
  )
    return null
  const reference = decodeProductReference(value)
  if (
    !reference ||
    !Number.isInteger(quantity) ||
    (quantity as number) < 1 ||
    (quantity as number) > 99
  )
    return null
  try {
    return {
      product: encodeProductNaddr(value),
      coordinate: reference.addressId,
      quantity: quantity as number,
    }
  } catch {
    return null
  }
}

/** Parse the public fragment without reading relays or changing the cart. */
export function parseCheckoutIntentFragment(
  fragment: string
): CheckoutIntentParseResult {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment
  if (
    !raw ||
    new TextEncoder().encode(raw).byteLength >
      CHECKOUT_INTENT_MAX_FRAGMENT_BYTES ||
    !validEncodedParameters(raw)
  ) {
    return { status: "invalid", error: "invalid_intent" }
  }
  const params = new URLSearchParams(raw)
  if (
    [...params.keys()].some(
      (key) => !["buy", "cart", "qty", "partner"].includes(key)
    ) ||
    ["buy", "cart", "qty", "partner"].some(
      (key) => params.getAll(key).length > 1
    ) ||
    params.has("buy") === params.has("cart") ||
    (params.has("qty") && !params.has("buy"))
  ) {
    return { status: "invalid", error: "invalid_intent" }
  }
  const partnerValue = params.get("partner")
  const partner =
    partnerValue && isCheckoutPartnerCode(partnerValue)
      ? partnerValue
      : undefined
  let items: CheckoutIntentItem[]
  let mode: "buy" | "cart"
  if (params.has("buy")) {
    mode = "buy"
    const qty = params.get("qty")
    const quantity =
      qty === null ? 1 : /^[1-9][0-9]?$/.test(qty) ? Number(qty) : NaN
    const item = parseProduct(params.get("buy"), quantity)
    if (!item) return { status: "invalid", error: "invalid_intent" }
    items = [item]
  } else {
    mode = "cart"
    const json = params.get("cart") ?? ""
    if (
      new TextEncoder().encode(json).byteLength > CHECKOUT_INTENT_MAX_JSON_BYTES
    ) {
      return { status: "invalid", error: "invalid_intent" }
    }
    let envelope: unknown
    try {
      envelope = JSON.parse(json)
    } catch {
      return { status: "invalid", error: "invalid_intent" }
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
      return { status: "invalid", error: "invalid_intent" }
    const body = envelope as Record<string, unknown>
    if (body.v !== 1)
      return {
        status: "invalid",
        error: body.v === undefined ? "invalid_intent" : "unsupported_version",
      }
    if (
      Object.keys(body).some((key) => !["v", "items"].includes(key)) ||
      !Array.isArray(body.items) ||
      body.items.length < 1 ||
      body.items.length > CHECKOUT_INTENT_MAX_ITEMS
    ) {
      return { status: "invalid", error: "invalid_intent" }
    }
    items = []
    for (const row of body.items) {
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).some((key) => !["product", "quantity"].includes(key))
      )
        return { status: "invalid", error: "invalid_intent" }
      const item = parseProduct(row.product, row.quantity)
      if (!item) return { status: "invalid", error: "invalid_intent" }
      items.push(item)
    }
  }
  if (
    new Set(items.map((item) => item.coordinate)).size !== items.length ||
    items.reduce((total, item) => total + item.quantity, 0) >
      CHECKOUT_INTENT_MAX_UNITS
  ) {
    return { status: "invalid", error: "invalid_intent" }
  }
  return {
    status: "valid",
    intent: { v: 1, mode, items, ...(partner ? { partner } : {}) },
  }
}
