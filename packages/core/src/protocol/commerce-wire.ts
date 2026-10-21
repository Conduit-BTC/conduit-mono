import { assertCommerceSupport } from "./commerce-capabilities"
/** Open Markets common fields plus versioned complete-order extensions.
 * The extension carries existing signed listing/fulfillment terms without
 * inventing those fields for independent-client records that lack them.
 */
import { MAX_RELAY_MESSAGE_CHARS } from "./relay-wire-limits"
import { openMarketsStatus } from "./open-markets-orders"
import { decodeLightningInvoiceMetadata } from "./lightning"

export const MAX_CONDUIT_COMMERCE_EXTENSION_LENGTH = 32_768

export const MAX_COMMERCE_EXTENSION_BYTES = MAX_RELAY_MESSAGE_CHARS
export type CommerceExtensionVersion = 1 | 2
const extensionSize = (text: string, version: string) =>
  version === "1"
    ? text.length <= MAX_CONDUIT_COMMERCE_EXTENSION_LENGTH
    : new TextEncoder().encode(text).length <= MAX_COMMERCE_EXTENSION_BYTES

function encodeExtension(
  rumor: WireRumor,
  payload: Record<string, unknown>,
  type: string,
  version: CommerceExtensionVersion
): string[] {
  const content = JSON.stringify(
    version === 1 ? payload : { payload, tags: rumor.tags }
  )
  if (!extensionSize(content, String(version)))
    throw new Error("Commerce message exceeds its evidence budget")
  return ["conduit", String(version), type, content]
}

const numericTypes: Record<string, string> = {
  order: "1",
  payment_request: "2",
  status_update: "3",
  shipping_update: "4",
}
interface WireRumor {
  kind?: number
  tags: string[][]
  content: string
}
/** Reject conflicting common/extension identities before domain validation. */
export function decodeConduitCommerceExtension<T extends WireRumor>(
  rumor: T
): T {
  const extensions = rumor.tags.filter((tag) => tag[0] === "conduit")
  if (!extensions.length) return rumor
  const extension = extensions[0]!
  const type = extension[2]
  if (
    extensions.length !== 1 ||
    extension.length !== 4 ||
    !["1", "2"].includes(extension[1]!) ||
    !type ||
    numericTypes[type] !== rumor.tags.find((tag) => tag[0] === "type")?.[1] ||
    !extensionSize(extension[3]!, extension[1]!)
  )
    throw new Error("Unsupported or conflicting commerce extension")
  const decoded = JSON.parse(extension[3]!) as Record<string, unknown>
  const payload = (extension[1] === "2" ? decoded.payload : decoded) as Record<
    string,
    unknown
  >
  let originalTags: string[][] | undefined
  if (extension[1] === "2") {
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !Array.isArray(decoded.tags) ||
      decoded.tags.length > 4096 ||
      decoded.tags.some(
        (tag) => !Array.isArray(tag) || tag.some((v) => typeof v !== "string")
      )
    )
      throw new Error("Invalid complete commerce evidence")
    originalTags = decoded.tags as string[][]
    if (originalTags.some((tag) => tag[0] === "conduit"))
      throw new Error("Nested commerce extension")
    for (const name of ["p", "order", "amount", "currency", "item"]) {
      const expected = originalTags.filter((tag) => tag[0] === name)
      const actual = rumor.tags.filter((tag) => tag[0] === name)
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        throw new Error("Commerce extension tag mismatch")
    }
    const types = originalTags.filter((tag) => tag[0] === "type")
    if (types.length !== 1 || types[0]?.length !== 2 || types[0]?.[1] !== type)
      throw new Error("Commerce extension type mismatch")
  }
  const tag = (name: string) =>
    rumor.tags.find((value) => value[0] === name)?.[1]
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload.orderId !== undefined && payload.orderId !== tag("order")) ||
    (payload.id !== undefined &&
      type === "order" &&
      payload.id !== tag("order"))
  )
    throw new Error("Commerce extension correlation mismatch")
  if (type === "order") {
    const items = payload.items as Array<{
      productId: string
      quantity: number
    }>
    const itemTags = rumor.tags.filter((value) => value[0] === "item")
    if (
      !Array.isArray(items) ||
      items.length !== itemTags.length ||
      items.some(
        (item, i) =>
          item.productId !== itemTags[i]?.[1] ||
          String(item.quantity) !== itemTags[i]?.[2]
      ) ||
      String(payload.subtotal) !== tag("amount")
    )
      throw new Error("Commerce extension terms mismatch")
  }
  if (type === "order" && originalTags)
    assertCommerceSupport(
      payload as unknown as Parameters<typeof assertCommerceSupport>[0],
      originalTags
    )
  if (
    type === "payment_request" &&
    (String(payload.amount) !== tag("amount") ||
      !rumor.tags.some(
        (value) =>
          value[0] === "payment" &&
          value[1] === "lightning" &&
          value[2] === payload.invoice
      ))
  )
    throw new Error("Commerce extension invoice mismatch")
  if (type === "status_update" && originalTags) {
    const commonStatuses = rumor.tags.filter((value) => value[0] === "status")
    const restoredStatuses = originalTags.filter(
      (value) => value[0] === "status"
    )
    // Restored tags take precedence over JSON in the domain parser. They may
    // retain the richer named status, but cannot change its payment authority.
    if (
      typeof payload.status !== "string" ||
      commonStatuses.length !== 1 ||
      commonStatuses[0]!.length !== 2 ||
      commonStatuses[0]![1] !== openMarketsStatus(payload.status) ||
      restoredStatuses.length > 1 ||
      restoredStatuses.some(
        (value) => value.length !== 2 || value[1] !== payload.status
      )
    )
      throw new Error("Commerce extension status mismatch")
  }
  if (
    type === "status_update" &&
    payload.status !== tag("status") &&
    openMarketsStatus(String(payload.status)) !== tag("status")
  )
    throw new Error("Commerce extension status mismatch")
  if (type === "shipping_update" && originalTags) {
    for (const [name, value] of [
      ["carrier", payload.carrier],
      ["tracking", payload.trackingNumber],
    ] as const) {
      const common = rumor.tags.filter((tag) => tag[0] === name)
      const restored = originalTags.filter((tag) => tag[0] === name)
      if (
        common.length !== (value === undefined ? 0 : 1) ||
        restored.length > 1 ||
        [...common, ...restored].some(
          (tag) => tag.length !== 2 || tag[1] !== value
        )
      )
        throw new Error("Commerce extension shipping mismatch")
    }
  }
  if (
    type === "shipping_update" &&
    ((payload.carrier && payload.carrier !== tag("carrier")) ||
      (payload.trackingNumber && payload.trackingNumber !== tag("tracking")))
  )
    throw new Error("Commerce extension shipping mismatch")
  return {
    ...rumor,
    tags:
      originalTags ??
      rumor.tags
        .filter((value) => !["type", "conduit"].includes(value[0] ?? ""))
        .map((value) =>
          type === "status_update" && value[0] === "status"
            ? ["status", String(payload.status)]
            : value
        )
        .concat([["type", type]]),
    content: extension[1] === "1" ? extension[3]! : JSON.stringify(payload),
  }
}

/** A reply uses common numeric fields; the optional extension preserves our richer local history. */
export function encodeOpenMarketsMerchantReply<T extends WireRumor>(
  rumor: T,
  wireOrderId: string,
  version: CommerceExtensionVersion = 1
): T {
  const payload = JSON.parse(rumor.content) as Record<string, unknown>
  const type = rumor.tags.find((tag) => tag[0] === "type")?.[1] ?? ""
  const recipient = rumor.tags.find((tag) => tag[0] === "p")?.[1] ?? ""
  const note = typeof payload.note === "string" ? payload.note : ""
  if (type === "message" || type === "receipt") {
    return {
      ...rumor,
      kind: 14,
      tags: [
        ["p", recipient],
        ["subject", wireOrderId],
        ["order", wireOrderId],
      ],
      content: note || "Order update",
    }
  }
  if (!["payment_request", "status_update", "shipping_update"].includes(type))
    throw new Error("Unsupported commerce reply")
  const tags: string[][] = [
    ["p", recipient],
    ["subject", type],
    ["type", numericTypes[type]!],
    ["order", wireOrderId],
  ]
  if (type === "payment_request") {
    if (
      typeof payload.amount !== "number" ||
      !Number.isSafeInteger(payload.amount) ||
      payload.amount <= 0 ||
      !["SAT", "SATS"].includes(String(payload.currency).toUpperCase()) ||
      typeof payload.invoice !== "string"
    )
      throw new Error("Unsupported commerce invoice")
    tags.push(
      ["amount", String(payload.amount)],
      ["payment", "lightning", payload.invoice]
    )
    const { expiresAt } = decodeLightningInvoiceMetadata(payload.invoice)
    if (expiresAt !== null) tags.push(["expiration", String(expiresAt)])
  } else if (type === "status_update") {
    const status = openMarketsStatus(String(payload.status))
    if (
      ![
        "pending",
        "confirmed",
        "processing",
        "completed",
        "cancelled",
      ].includes(status)
    )
      throw new Error("Unsupported commerce status")
    tags.push(["status", status])
  } else {
    tags.push(["status", "shipped"])
    if (typeof payload.carrier === "string")
      tags.push(["carrier", payload.carrier])
    if (typeof payload.trackingNumber === "string")
      tags.push(["tracking", payload.trackingNumber])
  }
  const original = {
    ...rumor,
    tags: rumor.tags.map((tag) =>
      tag[0] === "order" ? ["order", wireOrderId] : tag
    ),
  }
  // Common reply fields are canonical; original lifecycle tags remain in the extension.
  for (const name of ["amount", "currency", "item"]) {
    original.tags = original.tags
      .filter((tag) => tag[0] !== name)
      .concat(tags.filter((tag) => tag[0] === name))
  }
  tags.push(
    encodeExtension(
      original,
      { ...payload, orderId: wireOrderId },
      type,
      version
    )
  )
  return { ...rumor, tags, content: note }
}

/**
 * Pure encoding of the existing, buyer-approved checkout payload for its exact
 * original merchant. No I/O, discovery or recipient expansion. The publisher
 * validates the canonical payload against its staged snapshot before this call.
 */
export function encodeOpenMarketsBuyerMessage<
  T extends WireRumor & { pubkey: string },
>(
  rumor: T,
  scope: { buyerPubkey: string; merchantPubkey: string; orderId: string },
  version: CommerceExtensionVersion = 1
): T {
  const single = (name: string) => {
    const rows = rumor.tags.filter((value) => value[0] === name)
    if (rows.length !== 1 || rows[0]!.length !== 2)
      throw new Error("Ambiguous buyer order scope")
    return rows[0]![1]!
  }
  if (
    rumor.pubkey !== scope.buyerPubkey ||
    single("p") !== scope.merchantPubkey ||
    single("order") !== scope.orderId
  )
    throw new Error(
      "Numeric encoding cannot change the approved order recipient"
    )
  const payload = JSON.parse(rumor.content) as Record<string, unknown>
  const type = single("type")
  const note = typeof payload.note === "string" ? payload.note : ""
  const recipient = scope.merchantPubkey
  const orderId = scope.orderId
  if (payload.orderId !== undefined && payload.orderId !== orderId)
    throw new Error("Numeric encoding cannot change the approved order")
  if (type === "message")
    return {
      ...rumor,
      kind: 14,
      tags: [
        ["p", recipient],
        ["subject", orderId],
        ["order", orderId],
      ],
      content: note,
    }
  if (type === "payment_proof") {
    const invoice = typeof payload.invoice === "string" ? payload.invoice : ""
    const { sats, msats } = decodeLightningInvoiceMetadata(invoice)
    if (
      !invoice ||
      sats === null ||
      !Number.isSafeInteger(sats) ||
      sats <= 0 ||
      (payload.amountMsats !== undefined && payload.amountMsats !== msats)
    )
      throw new Error(
        "Numeric payment reports require an exact Lightning invoice"
      )
    const payment = ["payment", "lightning", invoice]
    if (typeof payload.preimage === "string") payment.push(payload.preimage)
    return {
      ...rumor,
      kind: 17,
      tags: [
        ["p", recipient],
        ["subject", "order-receipt"],
        ["order", orderId],
        ["amount", String(sats)],
        payment,
      ],
      content: note,
    }
  }
  if (
    type !== "order" ||
    payload.id !== orderId ||
    payload.buyerPubkey !== scope.buyerPubkey ||
    payload.merchantPubkey !== recipient
  )
    throw new Error(
      "Numeric encoding requires the same approved buyer, merchant and order"
    )
  if (
    payload.currency !== "SATS" ||
    !Number.isSafeInteger(payload.subtotal) ||
    typeof payload.subtotal !== "number" ||
    payload.subtotal < 0 ||
    !Array.isArray(payload.items)
  )
    throw new Error("Numeric orders require an aggregate sats total")
  const tags: string[][] = [
    ["p", recipient],
    ["subject", `Order ${orderId}`],
    ["type", "1"],
    ["order", orderId],
    ["amount", String(payload.subtotal)],
    ["currency", "SATS"],
  ]
  const shipping = new Set<string>()
  for (const item of payload.items as Array<Record<string, unknown>>) {
    if (
      version === 1 &&
      (item.fulfillment as { type?: unknown } | undefined)?.type ===
        "event_market_pickup"
    )
      throw new Error("Event pickup requires Conduit order compatibility")
    if (
      typeof item.productId !== "string" ||
      !item.productId.startsWith(`30402:${recipient}:`) ||
      !Number.isSafeInteger(item.quantity) ||
      typeof item.quantity !== "number" ||
      item.quantity <= 0
    )
      throw new Error("Unsupported numeric order item")
    tags.push(["item", item.productId, String(item.quantity)])
    if (typeof item.shippingOptionId === "string")
      shipping.add(item.shippingOptionId)
  }
  if (version === 1 && shipping.size > 1)
    throw new Error("Numeric orders require one shared delivery option")
  for (const value of shipping.size === 1 ? shipping : []) {
    if (!value.startsWith(`30406:${recipient}:`))
      throw new Error("Unsupported numeric delivery option")
    tags.push(["shipping", value])
  }
  // These are only the details already present in this merchant's validated
  // checkout payload. They remain inside the existing recipient's NIP-59 wrap.
  const address = payload.shippingAddress as Record<string, unknown> | undefined
  if (address)
    tags.push([
      "address",
      [
        address.name,
        address.street,
        address.city,
        address.state,
        address.postalCode,
        address.country,
      ]
        .filter((value) => typeof value === "string" && value.trim())
        .join("\n"),
    ])
  const contact = payload.guestContact as Record<string, unknown> | undefined
  for (const field of ["email", "phone"] as const)
    if (typeof contact?.[field] === "string" && contact[field])
      tags.push([field, contact[field]])
  if (version === 2)
    assertCommerceSupport(
      payload as unknown as Parameters<typeof assertCommerceSupport>[0],
      rumor.tags
    )
  const original = {
    ...rumor,
    tags: rumor.tags
      .filter((tag) => !["amount", "currency", "item"].includes(tag[0] ?? ""))
      .concat(
        tags.filter((tag) =>
          ["amount", "currency", "item"].includes(tag[0] ?? "")
        )
      ),
  }
  tags.push(encodeExtension(original, payload, "order", version))
  return { ...rumor, kind: 16, tags, content: note }
}
