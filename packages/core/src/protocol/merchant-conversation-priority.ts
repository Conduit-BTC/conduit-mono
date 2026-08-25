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
function deriveMerchantConversationPriorityInternal(
  conversation: MerchantConversationPriorityInput,
  useReopenClock: boolean
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
  const latestReopenIndex = latestReopen
    ? allMessages.findIndex((message) => message.id === latestReopen.id)
    : -1
  const reopenRestoredBucket =
    useReopenClock && latestReopen && latestReopenIndex >= 0
      ? deriveMerchantConversationPriorityInternal(
          {
            ...conversation,
            latestAt: latestReopen.createdAt,
            status: null,
            messages: allMessages.slice(0, latestReopenIndex + 1),
          },
          false
        ).bucket
      : undefined
  const taskAtForBucket = (
    bucket: MerchantOrderPriorityBucket,
    candidates: readonly ParsedOrderMessage[],
    fallback: number
  ): number => {
    if (latestReopen && reopenRestoredBucket === bucket) {
      return safeTimestamp(reopenedAt ?? fallback, orderCreatedAt)
    }
    const candidate = latestReopen
      ? candidates.find((message) => compareMessages(message, latestReopen) > 0)
      : candidates[0]
    return safeTimestamp(candidate?.createdAt ?? fallback, orderCreatedAt)
  }

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

  const shippingMessages = messages.filter(
    (message) =>
      isMerchantRecord(message) &&
      (message.type === "shipping_update" ||
        (message.type === "status_update" &&
          appliedStatusEventIds.has(message.id) &&
          normalizeStatus(message.payload.status) === "shipped"))
  )
  if (shippingMessages.length > 0 || effectiveStatus === "shipped") {
    return {
      bucket: "shipped",
      rank: PRIORITY_RANK.shipped,
      taskAt: taskAtForBucket("shipped", shippingMessages, fallbackAt),
      orderCreatedAt,
    }
  }

  const paidMessages = merchantStatuses.filter((message) =>
    isMerchantOrderPaid({ status: normalizeStatus(message.payload.status) })
  )
  if (
    paidMessages.length > 0 ||
    isMerchantOrderPaid({ status: effectiveStatus })
  ) {
    return {
      bucket: "paid_fulfill",
      rank: PRIORITY_RANK.paid_fulfill,
      taskAt: taskAtForBucket("paid_fulfill", paidMessages, fallbackAt),
      orderCreatedAt,
    }
  }

  const paymentEvidenceMessages = messages.filter(
    (message) =>
      isBuyerToMerchant(message) &&
      (isPaymentProofEvidenceMessage(message) ||
        isExternalPaymentReportMessage(message))
  )
  if (paymentEvidenceMessages.length > 0) {
    return {
      bucket: "verify_payment",
      rank: PRIORITY_RANK.verify_payment,
      taskAt: taskAtForBucket(
        "verify_payment",
        paymentEvidenceMessages,
        fallbackAt
      ),
      orderCreatedAt,
    }
  }

  const waitingMessages = messages.filter(
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
    waitingMessages.length > 0 ||
    effectiveStatus === "invoiced" ||
    isMerchantOrderAccepted({ status: effectiveStatus })
  ) {
    return {
      bucket: "waiting_payment",
      rank: PRIORITY_RANK.waiting_payment,
      taskAt: taskAtForBucket("waiting_payment", waitingMessages, fallbackAt),
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

export function deriveMerchantConversationPriority(
  conversation: MerchantConversationPriorityInput
): MerchantConversationPriority {
  return deriveMerchantConversationPriorityInternal(conversation, true)
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
