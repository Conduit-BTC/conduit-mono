import { parseOrderMessageRumorEvent, type ParsedOrderMessage } from "./orders"

/** An already authenticated inner NIP-17 rumor. Authentication belongs to unwrap. */
export interface CommerceRumor {
  id: string
  kind: number
  pubkey: string
  created_at?: number
  tags: string[][]
  content: string
}

export interface CommerceProvenance {
  rumorId: string
  rumorKind: number
  authorPubkey: string
  createdAt?: number
  /** Exact inner tags are retained locally; callers must never log them. */
  tags: string[][]
}

export interface CommerceFields {
  orderId?: string
  messageType?: string
  subject?: string
  amountSats?: string
  status?: string
  items?: Array<{ coordinate: string; quantity: string }>
  shippingCoordinate?: string
  paymentOptions?: Array<{ medium: string; reference: string }>
  paymentProofs?: Array<{ medium: string; reference: string; proof: string }>
  carrier?: string
  tracking?: string
  eta?: string
  expiration?: string
}

export type DecodedCommerceMessage =
  | { category: "machine"; provenance: CommerceProvenance }
  | { category: "unrelated"; provenance: CommerceProvenance }
  | {
      category: "direct"
      provenance: CommerceProvenance
      participants: string[]
      replyTo?: string
      subject?: string
      text: string
    }
  | {
      category: "file"
      provenance: CommerceProvenance
      participants: string[]
      replyTo?: string
      url: string
      mimeType?: string
      algorithm?: string
      key?: string
      nonce?: string
      encryptedSha256?: string
      originalSha256?: string
      size?: string
    }
  | {
      category: "commerce"
      provenance: CommerceProvenance
      association?: string
      protocol: "conduit" | "open_markets"
      status: "supported" | "unsupported" | "malformed"
      fields: CommerceFields
      /** Human-authored content only. Conduit JSON and recovery data never enter here. */
      text?: string
      /** Only validated Conduit messages can enter existing order actions. */
      parsedOrderMessage?: ParsedOrderMessage
    }

const CONDUIT_TYPES = new Set([
  "order",
  "payment_request",
  "status_update",
  "shipping_update",
  "receipt",
  "message",
  "payment_proof",
  "organizer_fulfillment_receipt",
  "organizer_fulfillment_revocation",
  "organizer_handoff_ack",
])
const OMF_TYPES = new Map([
  ["1", "order"],
  ["2", "payment_request"],
  ["3", "status_update"],
  ["4", "shipping_update"],
])
const ORDER_STATUSES = new Set([
  "pending",
  "confirmed",
  "processing",
  "completed",
  "cancelled",
])
const SHIPPING_STATUSES = new Set([
  "processing",
  "shipped",
  "delivered",
  "exception",
])
const MAX_TEXT_LENGTH = 4000

function values(tags: string[][], key: string): string[][] {
  return tags.filter((tag) => tag[0] === key)
}

function single(tags: string[][], key: string): string | undefined {
  const matches = values(tags, key)
  return matches.length === 1 && matches[0]?.[1]?.trim()
    ? matches[0][1]
    : undefined
}

function validSingle(tags: string[][], key: string): boolean {
  return values(tags, key).length === 1 && Boolean(single(tags, key))
}

function bounded(value: string): string {
  return value.slice(0, MAX_TEXT_LENGTH)
}

function objectContent(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function provenance(rumor: CommerceRumor): CommerceProvenance {
  return {
    rumorId: rumor.id,
    rumorKind: rumor.kind,
    authorPubkey: rumor.pubkey,
    createdAt: rumor.created_at,
    tags: rumor.tags.map((tag) => [...tag]),
  }
}

function omfFields(tags: string[][], messageType: string): CommerceFields {
  return {
    messageType,
    orderId: single(tags, "order"),
    subject: single(tags, "subject"),
    amountSats: single(tags, "amount"),
    status: single(tags, "status"),
    items: values(tags, "item").map((tag) => ({
      coordinate: tag[1] ?? "",
      quantity: tag[2] ?? "",
    })),
    shippingCoordinate: single(tags, "shipping"),
    paymentOptions: values(tags, "payment").map((tag) => ({
      medium: tag[1] ?? "",
      reference: tag[2] ?? "",
    })),
    paymentProofs:
      messageType === "payment_receipt"
        ? values(tags, "payment").map((tag) => ({
            medium: tag[1] ?? "",
            reference: tag[2] ?? "",
            proof: tag[3] ?? "",
          }))
        : undefined,
    carrier: single(tags, "carrier"),
    tracking: single(tags, "tracking"),
    eta: single(tags, "eta"),
    expiration: single(tags, "expiration"),
  }
}

function positiveInteger(value: string | undefined): boolean {
  return Boolean(value && /^[1-9]\d*$/.test(value))
}

function nonnegativeInteger(value: string | undefined): boolean {
  return Boolean(value && /^(0|[1-9]\d*)$/.test(value))
}

function validCoordinate(value: string, kind: number): boolean {
  return (
    value.startsWith(`${kind}:`) &&
    value.split(":").length >= 3 &&
    Boolean(value.split(":")[1]) &&
    Boolean(value.split(":").slice(2).join(":"))
  )
}

function isValidOpenMarkets(fields: CommerceFields, tags: string[][]): boolean {
  if (
    !validSingle(tags, "p") ||
    !validSingle(tags, "subject") ||
    !validSingle(tags, "order")
  )
    return false
  const type = fields.messageType
  if (type === "order") {
    return (
      nonnegativeInteger(fields.amountSats) &&
      Boolean(fields.items?.length) &&
      fields.items!.every(
        (item) =>
          validCoordinate(item.coordinate, 30402) &&
          positiveInteger(item.quantity)
      ) &&
      values(tags, "item").every((tag) => tag.length >= 3)
    )
  }
  if (type === "payment_request") {
    return (
      nonnegativeInteger(fields.amountSats) &&
      values(tags, "payment").every((tag) => Boolean(tag[1] && tag[2]))
    )
  }
  if (type === "status_update")
    return Boolean(fields.status && ORDER_STATUSES.has(fields.status))
  if (type === "shipping_update")
    return Boolean(fields.status && SHIPPING_STATUSES.has(fields.status))
  if (type === "payment_receipt") {
    return (
      nonnegativeInteger(fields.amountSats) &&
      Boolean(fields.paymentProofs?.length) &&
      fields.paymentProofs!.every((proof) =>
        Boolean(proof.medium && proof.reference && proof.proof)
      )
    )
  }
  return false
}

/**
 * Read only an authenticated inner rumor. The NIP-59 seal/rumor author match
 * must already have been verified. Machine recovery is excluded before any
 * display or search projection, including malformed recovery records.
 */
export function decodeCommerceMessageRumor(
  rumor: CommerceRumor
): DecodedCommerceMessage {
  const source = provenance(rumor)
  const tags = rumor.tags ?? []
  const typeTags = values(tags, "type")
  const contentObject = rumor.kind === 16 ? objectContent(rumor.content) : null
  if (
    rumor.kind === 16 &&
    (typeTags.some((tag) => tag[1] === "checkout_spark_recovery") ||
      contentObject?.type === "checkout_spark_recovery" ||
      typeTags.some(
        (tag) =>
          tag[1]?.startsWith("organizer_") ||
          [
            "future_market_ready",
            "future_market_revoked",
            "future_market_handed_out",
          ].includes(tag[1] ?? "")
      ))
  ) {
    return { category: "machine", provenance: source }
  }
  if (rumor.kind === 14) {
    return {
      category: "direct",
      provenance: source,
      participants: [
        ...new Set([
          rumor.pubkey,
          ...values(tags, "p")
            .map((tag) => tag[1])
            .filter((value): value is string => Boolean(value)),
        ]),
      ].sort(),
      replyTo: values(tags, "e").at(-1)?.[1],
      subject: single(tags, "subject"),
      text: rumor.content,
    }
  }
  if (rumor.kind === 15) {
    return {
      category: "file",
      provenance: source,
      participants: [
        ...new Set([
          rumor.pubkey,
          ...values(tags, "p")
            .map((tag) => tag[1])
            .filter((value): value is string => Boolean(value)),
        ]),
      ].sort(),
      replyTo: values(tags, "e").at(-1)?.[1],
      url: rumor.content,
      mimeType: single(tags, "file-type"),
      algorithm: single(tags, "encryption-algorithm"),
      key: single(tags, "decryption-key"),
      nonce: single(tags, "decryption-nonce"),
      encryptedSha256: single(tags, "x"),
      originalSha256: single(tags, "ox"),
      size: single(tags, "size"),
    }
  }
  if (rumor.kind === 16) {
    const type = typeTags[0]?.[1]
    const hasCommerceSignal =
      (typeTags.length > 0 &&
        (CONDUIT_TYPES.has(type ?? "") ||
          /^\d+$/.test(type ?? "") ||
          Boolean(single(tags, "order") || single(tags, "claim")))) ||
      (Boolean(single(tags, "order")) &&
        ["amount", "item", "status", "payment", "claim"].some(
          (key) => values(tags, key).length > 0
        ))
    if (!hasCommerceSignal) return { category: "unrelated", provenance: source }
    const isNumeric = Boolean(type && /^\d+$/.test(type))
    if (isNumeric) {
      const mappedType = OMF_TYPES.get(type!) ?? type!
      const fields = omfFields(tags, mappedType)
      let parsedOrderMessage: ParsedOrderMessage | undefined
      let extensionMalformed = false
      if (values(tags, "conduit").length) {
        try {
          parsedOrderMessage = parseOrderMessageRumorEvent(rumor)
        } catch {
          extensionMalformed = true
        }
      }
      return {
        category: "commerce",
        provenance: source,
        protocol: "open_markets",
        parsedOrderMessage:
          !extensionMalformed &&
          !values(tags, "version").length &&
          typeTags.length === 1 &&
          isValidOpenMarkets(fields, tags)
            ? parsedOrderMessage
            : undefined,
        status: extensionMalformed
          ? "malformed"
          : OMF_TYPES.has(type!)
            ? values(tags, "version").length > 0
              ? "unsupported"
              : typeTags.length === 1 && isValidOpenMarkets(fields, tags)
                ? "supported"
                : "malformed"
            : "unsupported",
        fields,
        text: bounded(rumor.content),
      }
    }
    const fields: CommerceFields = {
      messageType: type,
      orderId: single(tags, "order"),
      subject: single(tags, "subject"),
      amountSats: single(tags, "amount"),
      status: single(tags, "status"),
    }
    if (!type || typeTags.length !== 1 || !CONDUIT_TYPES.has(type)) {
      return {
        category: "commerce",
        provenance: source,
        protocol: "conduit",
        status: type && typeTags.length === 1 ? "unsupported" : "malformed",
        fields,
      }
    }
    if (
      !validSingle(tags, "p") ||
      (!fields.orderId && !type.startsWith("organizer_")) ||
      !contentObject
    ) {
      return {
        category: "commerce",
        provenance: source,
        protocol: "conduit",
        status: "malformed",
        fields,
      }
    }
    if (
      (typeof contentObject.version === "number" &&
        contentObject.version > 1) ||
      values(tags, "version").some((tag) => tag[1] !== "1")
    )
      return {
        category: "commerce",
        provenance: source,
        protocol: "conduit",
        status: "unsupported",
        fields,
      }
    if (
      type === "message" &&
      (typeof contentObject.note !== "string" || !contentObject.note.trim())
    )
      return {
        category: "commerce",
        provenance: source,
        protocol: "conduit",
        status: "malformed",
        fields,
      }
    try {
      const parsedOrderMessage = parseOrderMessageRumorEvent(rumor)
      if (
        parsedOrderMessage.type !== type ||
        (fields.orderId && parsedOrderMessage.orderId !== fields.orderId)
      ) {
        throw new Error("Conduit message identity mismatch")
      }
      return {
        category: "commerce",
        provenance: source,
        protocol: "conduit",
        status: "supported",
        fields,
        parsedOrderMessage,
      }
    } catch {
      return {
        category: "commerce",
        provenance: source,
        protocol: "conduit",
        status: "malformed",
        fields,
      }
    }
  }
  if (
    rumor.kind === 17 &&
    (values(tags, "payment").length > 0 ||
      (Boolean(single(tags, "order")) &&
        (values(tags, "amount").length > 0 ||
          single(tags, "subject") === "order-receipt")))
  ) {
    const fields = omfFields(tags, "payment_receipt")
    return {
      category: "commerce",
      provenance: source,
      protocol: "open_markets",
      status:
        values(tags, "version").length > 0
          ? "unsupported"
          : isValidOpenMarkets(fields, tags)
            ? "supported"
            : "malformed",
      fields,
      text: bounded(rumor.content),
    }
  }
  return { category: "unrelated", provenance: source }
}

/** Search words for a local, authenticated projection. Never indexes proof material. */
export function commerceMessageSearchText(
  message: DecodedCommerceMessage
): string {
  if (message.category === "machine" || message.category === "unrelated")
    return ""
  if (message.category === "direct") return message.text
  if (message.category === "file")
    return [message.mimeType, "attachment"].filter(Boolean).join(" ")
  const text = ["payment_request", "payment_receipt", "payment_proof"].includes(
    message.fields.messageType ?? ""
  )
    ? undefined
    : message.text
  return [
    message.fields.orderId,
    message.fields.messageType,
    message.fields.status,
    message.fields.subject,
    message.fields.amountSats,
    ...message.provenance.tags
      .filter((tag) =>
        ["a", "item", "version", "currency", "payment"].includes(tag[0] ?? "")
      )
      .map((tag) =>
        tag.slice(1, tag[0] === "payment" ? 3 : undefined).join(" ")
      ),
    message.provenance.createdAt === undefined
      ? undefined
      : new Date(message.provenance.createdAt * 1000).toISOString(),
    text,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_TEXT_LENGTH)
}

export type OpenMarketsCommerceInput =
  | {
      type: "order"
      recipientPubkey: string
      orderId: string
      subject: string
      amountSats: string
      items: Array<{ coordinate: string; quantity: string }>
      notes?: string
      shippingCoordinate?: string
      address?: string
      email?: string
      phone?: string
    }
  | {
      type: "payment_request"
      recipientPubkey: string
      orderId: string
      subject: string
      amountSats: string
      paymentOptions?: Array<{ medium: string; reference: string }>
      expiration?: string
      notes?: string
    }
  | {
      type: "status_update"
      recipientPubkey: string
      orderId: string
      subject: string
      status: string
      notes?: string
    }
  | {
      type: "shipping_update"
      recipientPubkey: string
      orderId: string
      subject: string
      status: string
      tracking?: string
      carrier?: string
      eta?: string
      notes?: string
    }
  | {
      type: "payment_receipt"
      recipientPubkey: string
      orderId: string
      subject: string
      amountSats: string
      paymentProofs: Array<{ medium: string; reference: string; proof: string }>
      notes?: string
    }

/** Build one current Open Markets inner rumor; sealing/publishing is separate. */
export function encodeOpenMarketsCommerceMessage(
  input: OpenMarketsCommerceInput
): { kind: 16 | 17; tags: string[][]; content: string } {
  if (
    !input.recipientPubkey.trim() ||
    !input.orderId.trim() ||
    !input.subject.trim()
  ) {
    throw new Error("Open Markets recipient, order, and subject are required")
  }
  const tags: string[][] = [
    ["p", input.recipientPubkey],
    ["subject", input.subject],
  ]
  if (input.type !== "payment_receipt") {
    tags.push([
      "type",
      String([...OMF_TYPES].find(([, name]) => name === input.type)?.[0]),
    ])
  }
  tags.push(["order", input.orderId])
  if (input.type === "order") {
    if (
      !nonnegativeInteger(input.amountSats) ||
      !input.items.length ||
      !input.items.every(
        (item) =>
          validCoordinate(item.coordinate, 30402) &&
          positiveInteger(item.quantity)
      )
    ) {
      throw new Error("Open Markets order amount or items are invalid")
    }
    tags.push(["amount", input.amountSats])
    input.items.forEach((item) =>
      tags.push(["item", item.coordinate, item.quantity])
    )
    if (input.shippingCoordinate) {
      if (!validCoordinate(input.shippingCoordinate, 30406))
        throw new Error("Invalid shipping coordinate")
      tags.push(["shipping", input.shippingCoordinate])
    }
    if (input.address) tags.push(["address", input.address])
    if (input.email) tags.push(["email", input.email])
    if (input.phone) tags.push(["phone", input.phone])
  } else if (input.type === "payment_request") {
    if (
      !nonnegativeInteger(input.amountSats) ||
      input.paymentOptions?.some(
        (option) => !option.medium || !option.reference
      )
    ) {
      throw new Error("Invalid payment request")
    }
    tags.push(["amount", input.amountSats])
    input.paymentOptions?.forEach((option) =>
      tags.push(["payment", option.medium, option.reference])
    )
    if (input.expiration) {
      if (!nonnegativeInteger(input.expiration))
        throw new Error("Invalid expiration")
      tags.push(["expiration", input.expiration])
    }
  } else if (
    input.type === "status_update" ||
    input.type === "shipping_update"
  ) {
    const allowed =
      input.type === "status_update" ? ORDER_STATUSES : SHIPPING_STATUSES
    if (!allowed.has(input.status)) throw new Error("Invalid status")
    tags.push(["status", input.status])
    if (input.type === "shipping_update") {
      if (input.tracking) tags.push(["tracking", input.tracking])
      if (input.carrier) tags.push(["carrier", input.carrier])
      if (input.eta) {
        if (!nonnegativeInteger(input.eta)) throw new Error("Invalid ETA")
        tags.push(["eta", input.eta])
      }
    }
  } else {
    if (
      !nonnegativeInteger(input.amountSats) ||
      !input.paymentProofs.length ||
      input.paymentProofs.some(
        (proof) => !proof.medium || !proof.reference || !proof.proof
      )
    ) {
      throw new Error("Invalid payment receipt")
    }
    input.paymentProofs.forEach((proof) =>
      tags.push(["payment", proof.medium, proof.reference, proof.proof])
    )
    tags.push(["amount", input.amountSats])
  }
  return {
    kind: input.type === "payment_receipt" ? 17 : 16,
    tags,
    content: input.notes ?? "",
  }
}

/** Authenticated incoming records reply to their author; sent records need one recipient. */
export function commerceReplyCounterparty(
  principal: string,
  provenance: CommerceProvenance
): string {
  const recipients = [
    ...new Set(
      provenance.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1] ?? "")
    ),
  ]
  const author = provenance.authorPubkey
  const counterparty =
    author === principal
      ? recipients.filter((recipient) => recipient !== principal)
      : recipients.includes(principal)
        ? [author]
        : []
  if (counterparty.length !== 1 || !/^[0-9a-f]{64}$/.test(counterparty[0]!))
    throw new Error("Commerce reply requires one authenticated counterparty")
  return counterparty[0]!
}
