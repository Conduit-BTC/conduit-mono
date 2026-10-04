/** Current Open Markets common fields plus a bounded Conduit v1 extension.
 * The extension carries existing signed listing/fulfillment terms without
 * inventing those fields for independent-client records that lack them.
 */
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
export function encodeCommonCommerceWire<T extends WireRumor>(rumor: T): T {
  const type = rumor.tags.find((tag) => tag[0] === "type")?.[1] ?? ""
  if (!numericTypes[type]) return rumor
  const value: unknown = JSON.parse(rumor.content)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid commerce content")
  const payload = value as Record<string, unknown>
  const currency =
    rumor.tags.find((tag) => tag[0] === "currency")?.[1] ?? payload.currency
  // Non-satoshi pricing and Conduit-specific transitions retain the bounded
  // legacy representation until their common fields can be stated exactly.
  if ((type === "order" || type === "payment_request") && currency !== "SATS")
    return rumor
  const status = payload.status as string | undefined
  if (
    type === "status_update" &&
    !["pending", "confirmed", "processing", "completed", "cancelled"].includes(
      status ?? ""
    )
  )
    return rumor
  // Retain the established representation for large signed order snapshots.
  // The optional interoperability extension must not shrink supported orders.
  if (rumor.content.length > 32_768) return rumor
  const tags = rumor.tags
    .filter(
      (tag) =>
        !["type", "subject", "item", "payment", "conduit"].includes(
          tag[0] ?? ""
        )
    )
    .map((tag) => [...tag])
  tags.push(
    ["type", numericTypes[type]!],
    ["subject", type.replaceAll("_", " ")],
    ["conduit", "1", type, rumor.content]
  )
  if (type === "order") {
    const items = payload.items as
      Array<{ productId: string; quantity: number }> | undefined
    if (
      !items?.length ||
      items.some(
        (item) =>
          !item.productId.startsWith("30402:") ||
          !Number.isSafeInteger(item.quantity) ||
          item.quantity < 1
      )
    )
      return rumor
    for (const item of items)
      tags.push(["item", item.productId, String(item.quantity)])
  }
  if (type === "payment_request") {
    if (
      typeof payload.amount !== "number" ||
      !Number.isSafeInteger(payload.amount) ||
      payload.amount < 0 ||
      typeof payload.invoice !== "string"
    )
      return rumor
    if (!tags.some((tag) => tag[0] === "amount"))
      tags.push(["amount", String(payload.amount)])
    tags.push(["payment", "lightning", payload.invoice])
  }
  if (type === "status_update" && !tags.some((tag) => tag[0] === "status"))
    tags.push(["status", status!])
  if (type === "shipping_update") {
    tags.push(["status", "shipped"])
    if (payload.carrier && !tags.some((tag) => tag[0] === "carrier"))
      tags.push(["carrier", String(payload.carrier)])
    if (payload.trackingNumber && !tags.some((tag) => tag[0] === "tracking"))
      tags.push(["tracking", String(payload.trackingNumber)])
  }
  return {
    ...rumor,
    tags,
    content: typeof payload.note === "string" ? payload.note : "",
  }
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
    extension[3]!.length > 32_768
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
  if (type === "status_update" && payload.status !== tag("status"))
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
      .concat([["type", type]]),
    content: extension[3]!,
  }
}
