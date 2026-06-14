import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { z } from "zod"
import {
  conversationMessageSchema,
  orderMessageTypeSchema,
  orderSchema,
  paymentProofActionSchema,
  paymentProofDeliveryStatusSchema,
  paymentProofMessageSchema,
  paymentProofSourceSchema,
  paymentRequestMessageSchema,
  receiptMessageSchema,
  shippingUpdateMessageSchema,
  statusUpdateMessageSchema,
  type ConversationMessageSchema,
  type OrderMessageTypeSchema,
  type OrderSchema,
  type PaymentProofMessageSchema,
  type PaymentProofActionSchema,
  type PaymentProofDeliveryStatusSchema,
  type PaymentProofSourceSchema,
  type PaymentRequestMessageSchema,
  type ReceiptMessageSchema,
  type ShippingUpdateMessageSchema,
  type StatusUpdateMessageSchema,
} from "../schemas"

/**
 * Parse a Conduit MVP order rumor event (kind 16) from its JSON content.
 */
export function parseOrderRumorEvent(
  event: Pick<NDKEvent, "content">
): OrderSchema {
  const parsed = JSON.parse(event.content || "{}") as unknown
  return orderSchema.parse(parsed)
}

type OrderRumorEvent = Pick<
  NDKEvent,
  "id" | "created_at" | "content" | "tags" | "pubkey"
>

type ParsedOrderMessageBase = {
  id: string
  orderId: string
  type: OrderMessageTypeSchema
  createdAt: number
  senderPubkey: string
  recipientPubkey: string
  rawContent: string
}

export type ParsedOrderMessage =
  | (ParsedOrderMessageBase & { type: "order"; payload: OrderSchema })
  | (ParsedOrderMessageBase & {
      type: "payment_request"
      payload: PaymentRequestMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "status_update"
      payload: StatusUpdateMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "shipping_update"
      payload: ShippingUpdateMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "receipt"
      payload: ReceiptMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "message"
      payload: ConversationMessageSchema
    })
  | (ParsedOrderMessageBase & {
      type: "payment_proof"
      payload: PaymentProofMessageSchema
    })

export type OrderPaymentState =
  | "awaiting_invoice"
  | "invoice_available"
  | "payment_in_progress"
  | "payment_sent"
  | "proof_sending"
  | "proof_sent"
  | "proof_delivery_failed"
  | "awaiting_merchant_confirmation"
  | "merchant_confirmed_paid"
  | "payment_failed"
  | "proof_disputed"

const lightningPaymentProofInputSchema = z
  .object({
    orderId: z.string().min(1),
    action: paymentProofActionSchema,
    amount: z.number().int().min(0),
    amountMsats: z.number().int().min(0),
    currency: z.string().min(1),
    invoice: z.string().min(1),
    preimage: z.string().min(1),
    paymentHash: z.string().min(1).optional(),
    feeMsats: z.number().int().min(0).optional(),
    zapRequestId: z.string().min(1).optional(),
    zapReceiptId: z.string().min(1).optional(),
    source: paymentProofSourceSchema,
    proofDeliveryStatus: paymentProofDeliveryStatusSchema.optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action === "zap" && !input.zapRequestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["zapRequestId"],
        message: "Public zap proofs must include the zap request id.",
      })
    }

    if (input.amountMsats !== input.amount * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountMsats"],
        message: "Proof amountMsats must match amount in sats.",
      })
    }
  })

export type BuildLightningPaymentProofMessageInput = z.input<
  typeof lightningPaymentProofInputSchema
>

function getTagValue(
  tags: string[][] | undefined,
  name: string
): string | null {
  for (const tag of tags ?? []) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1]
  }
  return null
}

function parseNumericTag(
  tags: string[][] | undefined,
  name: string
): number | undefined {
  const value = getTagValue(tags, name)
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function getNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined
  return Number.isFinite(value) ? value : undefined
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter(
    (item): item is string => typeof item === "string"
  )
  return strings.length === value.length ? strings : undefined
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function normalizePaymentProofVerification(
  value: unknown
): Record<string, unknown> | undefined {
  const object = parseObject(value)
  if (!object) return undefined

  const normalized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(object)) {
    if (key === "state" || key === "checkedAt" || key === "checks") continue
    normalized[key] = item
  }

  const state = getString(object.state)
  if (state) normalized.state = state

  const checkedAt = getNumber(object.checkedAt)
  if (checkedAt !== undefined) normalized.checkedAt = checkedAt

  const checks = getStringArray(object.checks)
  if (checks) normalized.checks = checks

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function messageBase<TType extends OrderMessageTypeSchema>(
  event: OrderRumorEvent,
  type: TType,
  orderId: string
): ParsedOrderMessageBase & { type: TType } {
  return {
    id: event.id,
    orderId,
    type,
    createdAt: (event.created_at ?? 0) * 1000,
    senderPubkey: event.pubkey,
    recipientPubkey: getTagValue(event.tags ?? [], "p") ?? "",
    rawContent: event.content ?? "",
  }
}

/**
 * Parse an unwrapped kind-16 rumor into a typed order-conversation message.
 *
 * This parser is intentionally permissive for non-`order` message types so
 * MVP clients can handle mixed sender implementations while remaining
 * conservative in what we emit.
 */
export function parseOrderMessageRumorEvent(
  event: OrderRumorEvent
): ParsedOrderMessage {
  const type = orderMessageTypeSchema.parse(
    getTagValue(event.tags ?? [], "type") ?? "order"
  )
  const json = parseJsonObject(event.content ?? "")

  if (type === "order") {
    const payload = parseOrderRumorEvent(event)
    const orderId = getTagValue(event.tags ?? [], "order") ?? payload.id
    return { ...messageBase(event, type, orderId), payload }
  }

  const orderId =
    getTagValue(event.tags ?? [], "order") ??
    getString(json?.orderId) ??
    getString(json?.id) ??
    event.id

  if (type === "payment_request") {
    const payload = paymentRequestMessageSchema.parse({
      invoice: getString(json?.invoice) ?? event.content.trim(),
      amount:
        parseNumericTag(event.tags ?? [], "amount") ?? getNumber(json?.amount),
      currency:
        getTagValue(event.tags ?? [], "currency") ?? getString(json?.currency),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "status_update") {
    const payload = statusUpdateMessageSchema.parse({
      status:
        getTagValue(event.tags ?? [], "status") ?? getString(json?.status),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "shipping_update") {
    const payload = shippingUpdateMessageSchema.parse({
      carrier:
        getTagValue(event.tags ?? [], "carrier") ?? getString(json?.carrier),
      trackingNumber:
        getTagValue(event.tags ?? [], "tracking") ??
        getString(json?.trackingNumber),
      trackingUrl: getString(json?.trackingUrl),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "receipt") {
    const payload = receiptMessageSchema.parse({
      note:
        getString(json?.note) ??
        (json ? undefined : event.content.trim() || undefined),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "message") {
    const payload = conversationMessageSchema.parse({
      note: getString(json?.note) ?? event.content.trim(),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  if (type === "payment_proof") {
    const payload = paymentProofMessageSchema.parse({
      ...(json ?? {}),
      version: getNumber(json?.version),
      orderId,
      rail: getTagValue(event.tags ?? [], "rail") ?? getString(json?.rail),
      action: getString(json?.action),
      amount:
        parseNumericTag(event.tags ?? [], "amount") ?? getNumber(json?.amount),
      amountMsats: getNumber(json?.amountMsats),
      currency:
        getTagValue(event.tags ?? [], "currency") ?? getString(json?.currency),
      invoice: getString(json?.invoice),
      preimage: getString(json?.preimage),
      paymentHash: getString(json?.paymentHash),
      feeMsats: getNumber(json?.feeMsats),
      zapRequestId: getString(json?.zapRequestId),
      zapReceiptId: getString(json?.zapReceiptId),
      source: getString(json?.source),
      proofDeliveryStatus: getString(json?.proofDeliveryStatus),
      verification: normalizePaymentProofVerification(json?.verification),
      note: getString(json?.note),
    })
    return { ...messageBase(event, type, orderId), payload }
  }

  return {
    ...messageBase(event, type, orderId),
    payload: json ?? { raw: event.content.trim() },
  }
}

export function buildLightningPaymentProofMessage(
  input: BuildLightningPaymentProofMessageInput
): PaymentProofMessageSchema & {
  version: 1
  rail: "lightning"
  action: PaymentProofActionSchema
  amount: number
  amountMsats: number
  currency: string
  invoice: string
  preimage: string
  source: PaymentProofSourceSchema
  proofDeliveryStatus?: PaymentProofDeliveryStatusSchema
} {
  const proof = lightningPaymentProofInputSchema.parse(input)
  return paymentProofMessageSchema.parse({
    version: 1,
    rail: "lightning",
    verification: {
      state: "buyer_evidence_received",
      checkedAt: Math.floor(Date.now() / 1000),
      checks: [],
    },
    ...proof,
  }) as PaymentProofMessageSchema & {
    version: 1
    rail: "lightning"
    action: PaymentProofActionSchema
    amount: number
    amountMsats: number
    currency: string
    invoice: string
    preimage: string
    source: PaymentProofSourceSchema
    proofDeliveryStatus?: PaymentProofDeliveryStatusSchema
  }
}

function getLatestMessage<TType extends ParsedOrderMessage["type"]>(
  messages: readonly ParsedOrderMessage[],
  type: TType
): Extract<ParsedOrderMessage, { type: TType }> | undefined {
  return [...messages]
    .filter(
      (message): message is Extract<ParsedOrderMessage, { type: TType }> =>
        message.type === type
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

export function deriveOrderPaymentState(
  messages: readonly ParsedOrderMessage[]
): OrderPaymentState {
  const latestStatus = getLatestMessage(messages, "status_update")
  if (latestStatus?.payload.status === "paid") {
    return "merchant_confirmed_paid"
  }

  const latestProof = getLatestMessage(messages, "payment_proof")
  if (latestProof) {
    const verificationState = latestProof.payload.verification?.state
    if (verificationState === "disputed") return "proof_disputed"
    if (verificationState === "verification_failed") return "payment_failed"
    if (verificationState === "verified") return "merchant_confirmed_paid"

    if (latestProof.payload.proofDeliveryStatus === "retry_needed") {
      return "proof_delivery_failed"
    }

    if (latestProof.payload.proofDeliveryStatus === "pending") {
      return "proof_sending"
    }

    return "proof_sent"
  }

  if (messages.some((message) => message.type === "payment_request")) {
    return "invoice_available"
  }

  return messages.some((message) => message.type === "order")
    ? "awaiting_invoice"
    : "awaiting_invoice"
}
