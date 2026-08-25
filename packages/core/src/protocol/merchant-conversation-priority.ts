import {
  getAppliedMerchantOrderMessages,
  getEffectiveMerchantOrderStatus,
  isMerchantOrderAccepted,
  isMerchantOrderPaid,
} from "./order-status"
import { isExternalPaymentReportMessage } from "./order-summary"
import {
  isPaymentProofEvidenceMessage,
  type ParsedOrderMessage,
} from "./orders"

export type MerchantOrderPriorityBucket =
  | "paid_fulfill"
  | "verify_payment"
  | "unpaid_review"
  | "shipped"
  | "waiting_payment"
  | "closed"

export interface MerchantConversationPriorityInput {
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
  latestAt: number
  status: string | null
  messages?: ParsedOrderMessage[]
}

export interface MerchantConversationPriority {
  bucket: MerchantOrderPriorityBucket
  rank: number
  taskAt: number
  orderCreatedAt: number
}

const CLOSED_STATUSES = new Set([
  "cancelled",
  "complete",
  "delivered",
  "refund_requested",
])

const PRIORITY_RANK: Record<MerchantOrderPriorityBucket, number> = {
  paid_fulfill: 0,
  verify_payment: 1,
  unpaid_review: 2,
  shipped: 3,
  waiting_payment: 4,
  closed: 5,
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareNumberAscending(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareNumberDescending(left: number, right: number): number {
  return left > right ? -1 : left < right ? 1 : 0
}

function safeTimestamp(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function compareMessages(
  left: ParsedOrderMessage,
  right: ParsedOrderMessage
): number {
  return (
    compareNumberAscending(
      safeTimestamp(left.createdAt),
      safeTimestamp(right.createdAt)
    ) || compareText(left.id, right.id)
  )
}

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? "pending").trim().toLowerCase()
}

/**
 * Project a conversation into the merchant's default all-orders work queue.
 *
 * The projection intentionally consumes prepared conversation history rather
 * than UI labels. Actionable buckets use the time at which the current task
 * first appeared; closed work uses its latest terminal transition. Explicit
 * guest orders accept merchant-addressed self-copy records, matching the
 * guest operational-history contract without changing their priority.
 */
export function deriveMerchantConversationPriority(
  conversation: MerchantConversationPriorityInput
): MerchantConversationPriority {
  const allMessages = [...(conversation.messages ?? [])].sort(compareMessages)
  const fallbackAt = safeTimestamp(conversation.latestAt)
  const orderMessage = allMessages.find(
    (message) =>
      message.type === "order" &&
      message.senderPubkey === conversation.buyerPubkey &&
      message.recipientPubkey === conversation.merchantPubkey
  )
  const orderCreatedAt = safeTimestamp(
    orderMessage?.createdAt ?? allMessages[0]?.createdAt ?? fallbackAt,
    fallbackAt
  )
  const guestOrder =
    orderMessage?.type === "order" &&
    orderMessage.payload.buyerIdentityKind === "guest_ephemeral"
  const isBuyerToMerchant = (message: ParsedOrderMessage) =>
    message.senderPubkey === conversation.buyerPubkey &&
    message.recipientPubkey === conversation.merchantPubkey
  const isMerchantRecord = (message: ParsedOrderMessage) =>
    message.senderPubkey === conversation.merchantPubkey &&
    (message.recipientPubkey === conversation.buyerPubkey ||
      (guestOrder && message.recipientPubkey === conversation.merchantPubkey))
  const effective = getEffectiveMerchantOrderStatus(
    allMessages,
    {
      buyerPubkey: conversation.buyerPubkey,
      merchantPubkey: conversation.merchantPubkey,
    },
    conversation.status
  )
  const messages = getAppliedMerchantOrderMessages(
    allMessages,
    {
      buyerPubkey: conversation.buyerPubkey,
      merchantPubkey: conversation.merchantPubkey,
    },
    conversation.status
  ).sort(compareMessages)
  const appliedStatusEventIds = new Set(effective.appliedStatusEventIds)
  const merchantStatuses = messages.filter(
    (
      message
    ): message is Extract<ParsedOrderMessage, { type: "status_update" }> =>
      message.type === "status_update" &&
      isMerchantRecord(message) &&
      appliedStatusEventIds.has(message.id)
  )
  const effectiveStatus = normalizeStatus(effective.status)
  const effectiveTerminal = [...merchantStatuses]
    .reverse()
    .find(
      (message) =>
        CLOSED_STATUSES.has(normalizeStatus(message.payload.status)) &&
        normalizeStatus(message.payload.status) === effectiveStatus
    )
  const latestReopen = [...merchantStatuses]
    .reverse()
    .find((message) => Boolean(message.payload.reopens))
  const reopenedAt = latestReopen?.createdAt

  if (CLOSED_STATUSES.has(effectiveStatus)) {
    return {
      bucket: "closed",
      rank: PRIORITY_RANK.closed,
      taskAt: safeTimestamp(
        effectiveTerminal?.createdAt ?? fallbackAt,
        orderCreatedAt
      ),
      orderCreatedAt,
    }
  }

  const shippingMessage = messages.find(
    (message) =>
      isMerchantRecord(message) &&
      (message.type === "shipping_update" ||
        (message.type === "status_update" &&
          appliedStatusEventIds.has(message.id) &&
          normalizeStatus(message.payload.status) === "shipped"))
  )
  if (shippingMessage || effectiveStatus === "shipped") {
    return {
      bucket: "shipped",
      rank: PRIORITY_RANK.shipped,
      taskAt: safeTimestamp(
        reopenedAt ?? shippingMessage?.createdAt ?? fallbackAt,
        orderCreatedAt
      ),
      orderCreatedAt,
    }
  }

  const paidMessage = merchantStatuses.find((message) =>
    isMerchantOrderPaid({ status: normalizeStatus(message.payload.status) })
  )
  if (paidMessage || isMerchantOrderPaid({ status: effectiveStatus })) {
    return {
      bucket: "paid_fulfill",
      rank: PRIORITY_RANK.paid_fulfill,
      taskAt: safeTimestamp(
        reopenedAt ?? paidMessage?.createdAt ?? fallbackAt,
        orderCreatedAt
      ),
      orderCreatedAt,
    }
  }

  const paymentEvidence = messages.find(
    (message) =>
      isBuyerToMerchant(message) &&
      (isPaymentProofEvidenceMessage(message) ||
        isExternalPaymentReportMessage(message))
  )
  if (paymentEvidence) {
    return {
      bucket: "verify_payment",
      rank: PRIORITY_RANK.verify_payment,
      taskAt: safeTimestamp(
        reopenedAt ?? paymentEvidence.createdAt,
        orderCreatedAt
      ),
      orderCreatedAt,
    }
  }

  const waitingMessage = messages.find(
    (message) =>
      isMerchantRecord(message) &&
      (message.type === "payment_request" ||
        (message.type === "status_update" &&
          appliedStatusEventIds.has(message.id) &&
          (normalizeStatus(message.payload.status) === "invoiced" ||
            isMerchantOrderAccepted({
              status: normalizeStatus(message.payload.status),
            }))))
  )
  if (
    waitingMessage ||
    effectiveStatus === "invoiced" ||
    isMerchantOrderAccepted({ status: effectiveStatus })
  ) {
    return {
      bucket: "waiting_payment",
      rank: PRIORITY_RANK.waiting_payment,
      taskAt: safeTimestamp(
        reopenedAt ?? waitingMessage?.createdAt ?? fallbackAt,
        orderCreatedAt
      ),
      orderCreatedAt,
    }
  }

  return {
    bucket: "unpaid_review",
    rank: PRIORITY_RANK.unpaid_review,
    taskAt: safeTimestamp(reopenedAt ?? orderCreatedAt, orderCreatedAt),
    orderCreatedAt,
  }
}

export function compareMerchantConversationsByPriority(
  left: MerchantConversationPriorityInput,
  right: MerchantConversationPriorityInput
): number {
  const leftPriority = deriveMerchantConversationPriority(left)
  const rightPriority = deriveMerchantConversationPriority(right)
  const rankComparison = compareNumberAscending(
    leftPriority.rank,
    rightPriority.rank
  )
  if (rankComparison !== 0) return rankComparison

  const taskComparison =
    leftPriority.bucket === "closed"
      ? compareNumberDescending(leftPriority.taskAt, rightPriority.taskAt)
      : compareNumberAscending(leftPriority.taskAt, rightPriority.taskAt)
  if (taskComparison !== 0) return taskComparison

  return (
    compareNumberAscending(
      leftPriority.orderCreatedAt,
      rightPriority.orderCreatedAt
    ) || compareText(left.orderId, right.orderId)
  )
}
