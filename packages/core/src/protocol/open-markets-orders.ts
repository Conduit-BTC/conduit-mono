import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import {
  decodeLightningInvoiceAmount,
  decodeLightningInvoicePaymentHash,
} from "./lightning"
import type { ParsedOrderMessage } from "./orders"

type Rumor = {
  id: string
  pubkey: string
  kind?: number
  created_at?: number
  tags: string[][]
  content: string
}

const HEX = /^[0-9a-f]{64}$/
const SINGLETONS = [
  "p",
  "subject",
  "type",
  "order",
  "amount",
  "shipping",
  "address",
  "email",
  "phone",
  "status",
  "carrier",
  "tracking",
  "eta",
  "expiration",
]

/** Device-domain correlation alias; the signed wire order ID is never changed. */
export function openMarketsLocalOrderId(
  orderId: string,
  author: string,
  recipient: string
): string {
  return `open-markets:${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([[author, recipient].sort(), orderId]))))}`
}

export function hasConflictingOpenMarketsOrders(
  messages: readonly ParsedOrderMessage[]
): boolean {
  const terms = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== "order" || message.wireFormat !== "open_markets")
      continue
    const value = JSON.stringify([
      message.senderPubkey,
      message.recipientPubkey,
      message.payload.items,
      message.payload.subtotal,
      message.payload.currency,
      message.payload.openMarkets,
    ])
    const previous = terms.get(message.orderId)
    if (previous !== undefined && previous !== value) return true
    terms.set(message.orderId, value)
  }
  return false
}

/** Aggregate retained logical history only; no identifiers or content leave this boundary. */
export function getOrderAdapterCounts(messages: readonly ParsedOrderMessage[]) {
  const canonical = new Set<string>()
  const compatible = new Map<string, ParsedOrderMessage[]>()
  let replies = 0
  for (const message of messages) {
    if (message.wireFormat !== "open_markets") {
      if (message.type === "order") canonical.add(message.orderId)
      continue
    }
    if (message.type !== "order") {
      replies++
      continue
    }
    const orders = compatible.get(message.orderId) ?? []
    orders.push(message)
    compatible.set(message.orderId, orders)
  }
  return {
    canonicalOrders: canonical.size,
    compatibleOrders: compatible.size,
    compatibleReplies: replies,
    conflictingOrders: [...compatible.values()].filter(
      hasConflictingOpenMarketsOrders
    ).length,
  }
}

function single(rumor: Rumor, name: string): string | undefined {
  return rumor.tags.find((tag) => tag[0] === name)?.[1]
}

function integer(value: string | undefined, positive = false): number {
  if (!value || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error("Invalid commerce integer")
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0))
    throw new Error("Invalid commerce integer")
  return number
}

function coordinate(value: string, kind: number, merchant: string): boolean {
  const [eventKind, author, ...identifier] = value.split(":")
  return (
    eventKind === String(kind) &&
    author === merchant &&
    HEX.test(author) &&
    identifier.join(":").length > 0 &&
    value.length <= 512
  )
}

/** Authenticated wire shape only. Adoption, invoicing and settlement keep their domain gates. */
export function parseOpenMarketsOrderMessage(
  rumor: Rumor
): ParsedOrderMessage | null {
  const type = single(rumor, "type")
  if (
    rumor.kind !== 17 &&
    !(rumor.kind === 16 && ["1", "2", "3", "4"].includes(type ?? ""))
  )
    return null
  if (rumor.tags.some((tag) => tag[0] === "version" || tag[0] === "conduit"))
    throw new Error("Unsupported commerce version")
  for (const key of SINGLETONS) {
    const tags = rumor.tags.filter((tag) => tag[0] === key)
    if (
      tags.length > 1 ||
      tags.some(
        (tag) => tag.length !== 2 || !tag[1]?.trim() || tag[1].length > 4000
      )
    )
      throw new Error("Ambiguous commerce field")
  }
  const recipient = single(rumor, "p") ?? ""
  const orderId = single(rumor, "order") ?? ""
  if (
    !HEX.test(rumor.pubkey) ||
    !HEX.test(recipient) ||
    recipient === rumor.pubkey ||
    !orderId ||
    orderId.length > 128 ||
    !single(rumor, "subject") ||
    !Number.isSafeInteger(rumor.created_at) ||
    rumor.created_at! < 0 ||
    !Number.isSafeInteger(rumor.created_at! * 1000) ||
    rumor.content.length > 4000
  )
    throw new Error("Invalid commerce identity")
  const localOrderId = openMarketsLocalOrderId(orderId, rumor.pubkey, recipient)
  const base = {
    id: rumor.id,
    orderId: localOrderId,
    wireOrderId: orderId,
    createdAt: rumor.created_at! * 1000,
    senderPubkey: rumor.pubkey,
    recipientPubkey: recipient,
    rawContent: rumor.content,
    wireFormat: "open_markets" as const,
  }
  if (rumor.kind === 16 && type === "1") {
    const itemTags = rumor.tags.filter((tag) => tag[0] === "item")
    if (
      !itemTags.length ||
      itemTags.length > 128 ||
      new Set(itemTags.map((tag) => tag[1])).size !== itemTags.length ||
      itemTags.some(
        (tag) => tag.length !== 3 || !coordinate(tag[1] ?? "", 30402, recipient)
      )
    )
      throw new Error("Invalid commerce items")
    const shipping = single(rumor, "shipping")
    if (shipping && !coordinate(shipping, 30406, recipient))
      throw new Error("Invalid commerce shipping")
    return {
      ...base,
      type: "order",
      payload: {
        id: localOrderId,
        buyerPubkey: rumor.pubkey,
        merchantPubkey: recipient,
        items: itemTags.map((tag) => ({
          productId: tag[1]!,
          quantity: integer(tag[2], true),
          currency: "SATS",
        })),
        subtotal: integer(single(rumor, "amount")),
        currency: "SATS",
        createdAt: base.createdAt,
        note: rumor.content || undefined,
        openMarkets: {
          address: single(rumor, "address"),
          email: single(rumor, "email"),
          phone: single(rumor, "phone"),
          shippingCoordinate: shipping,
        },
      },
    }
  }
  if (rumor.kind === 16 && type === "3") {
    const statuses: Record<string, string> = {
      pending: "pending",
      confirmed: "payment_reported",
      processing: "processing",
      completed: "fulfillment_reported",
      cancelled: "cancellation_requested",
    }
    const status = statuses[single(rumor, "status") ?? ""]
    if (!status) throw new Error("Unsupported commerce status")
    return {
      ...base,
      type: "status_update",
      payload: { status, note: rumor.content || undefined },
    }
  }
  if (rumor.kind === 16 && type === "4") {
    if (single(rumor, "status") !== "shipped")
      throw new Error("Unsupported shipping status")
    return {
      ...base,
      type: "shipping_update",
      payload: {
        carrier: single(rumor, "carrier"),
        trackingNumber: single(rumor, "tracking"),
        note: rumor.content || undefined,
      },
    }
  }
  const payments = rumor.tags.filter((tag) => tag[0] === "payment")
  if (
    payments.length !== 1 ||
    payments[0]?.[1] !== "lightning" ||
    payments[0].length !== (rumor.kind === 17 ? 4 : 3)
  )
    throw new Error("Unsupported commerce payment")
  const invoice = payments[0][2]!
  const amount = integer(single(rumor, "amount"), true)
  const decoded = decodeLightningInvoiceAmount(invoice)
  const paymentHash = decodeLightningInvoicePaymentHash(invoice)
  if (
    !paymentHash ||
    decoded.msats !== amount * 1000 ||
    !Number.isSafeInteger(amount * 1000)
  )
    throw new Error("Commerce invoice amount mismatch")
  if (rumor.kind === 16)
    return {
      ...base,
      type: "payment_request",
      payload: {
        invoice,
        amount,
        currency: "SATS",
        note: rumor.content || undefined,
      },
    }
  const preimage = payments[0][3]!
  if (
    !HEX.test(preimage) ||
    bytesToHex(sha256(hexToBytes(preimage))) !== paymentHash
  )
    throw new Error("Invalid commerce payment proof")
  return {
    ...base,
    type: "payment_proof",
    payload: {
      orderId: localOrderId,
      rail: "lightning",
      invoice,
      preimage,
      paymentHash,
      amount,
      amountMsats: decoded.msats,
      currency: "SATS",
      source: "external",
      verification: { state: "unverified", checks: [] },
    },
  }
}

export function openMarketsStatus(status: string): string {
  return (
    (
      {
        accepted: "pending",
        invoiced: "pending",
        paid: "confirmed",
        complete: "completed",
        delivered: "completed",
        shipped: "processing",
      } as Record<string, string>
    )[status] ?? status
  )
}
