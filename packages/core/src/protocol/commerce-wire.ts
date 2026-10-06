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
