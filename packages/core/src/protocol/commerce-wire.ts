/** Current Open Markets common fields plus a bounded Conduit v1 extension.
 * The extension carries existing signed listing/fulfillment terms without
 * inventing those fields for independent-client records that lack them.
 */
import { openMarketsStatus } from "./open-markets-orders"
import { decodeLightningInvoiceMetadata } from "./lightning"

export const MAX_CONDUIT_COMMERCE_EXTENSION_LENGTH = 32_768

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
    extension[1] !== "1" ||
    !type ||
    numericTypes[type] !== rumor.tags.find((tag) => tag[0] === "type")?.[1] ||
    extension[3]!.length > MAX_CONDUIT_COMMERCE_EXTENSION_LENGTH
  )
    throw new Error("Unsupported or conflicting commerce extension")
  const payload = JSON.parse(extension[3]!) as Record<string, unknown>
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
  if (
    type === "status_update" &&
    payload.status !== tag("status") &&
    openMarketsStatus(String(payload.status)) !== tag("status")
  )
    throw new Error("Commerce extension status mismatch")
  if (
    type === "shipping_update" &&
    ((payload.carrier && payload.carrier !== tag("carrier")) ||
      (payload.trackingNumber && payload.trackingNumber !== tag("tracking")))
  )
    throw new Error("Commerce extension shipping mismatch")
  return {
    ...rumor,
    tags: rumor.tags
      .filter((value) => !["type", "conduit"].includes(value[0] ?? ""))
      .map((value) =>
        type === "status_update" && value[0] === "status"
          ? ["status", String(payload.status)]
          : value
      )
      .concat([["type", type]]),
    content: extension[3]!,
  }
}

/** A reply uses common numeric fields; the optional extension preserves our richer local history. */
export function encodeOpenMarketsMerchantReply<T extends WireRumor>(
  rumor: T,
  wireOrderId: string
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
  const extension = JSON.stringify({ ...payload, orderId: wireOrderId })
  if (extension.length > MAX_CONDUIT_COMMERCE_EXTENSION_LENGTH)
    throw new Error("Commerce reply is too large")
  tags.push(["conduit", "1", type, extension])
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
  scope: { buyerPubkey: string; merchantPubkey: string; orderId: string }
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
  if (shipping.size > 1)
    throw new Error("Numeric orders require one shared delivery option")
  for (const value of shipping) {
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
  const extension = JSON.stringify(payload)
  if (extension.length > MAX_CONDUIT_COMMERCE_EXTENSION_LENGTH)
    throw new Error("Commerce order is too large")
  tags.push(["conduit", "1", "order", extension])
  return { ...rumor, kind: 16, tags, content: note }
}
