import { getEventHash } from "nostr-tools"
import { type PrivateMessageEvent } from "./messaging"
import { cacheParsedOrderMessage } from "./commerce"
import { getCommerceInbox, type CommerceInbox } from "./commerce-inbox"
import { EVENT_KINDS } from "./kinds"
import {
  createAcceptedInboxSendCheckpoint,
  type AccountInboxSendResult,
} from "./inbox-send"
import { getAccountSigner } from "./session-signer"
import { appendConduitClientTag } from "./nip89"
import { parseOrderMessageRumorEvent, type ParsedOrderMessage } from "./orders"
import {
  createValidatedOrderRouteScope,
  publishPrivateMessage,
} from "./messaging"
import type { PrivateMessageDeliveryRoute } from "./private-message-routing"

export type MerchantOrderDelivery = "buyer_and_self" | "self_only"

export interface PublishMerchantOrderMessageInput {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
  type:
    | "payment_request"
    | "status_update"
    | "shipping_update"
    | "receipt"
    | "message"
  payload: Record<string, unknown>
  tags?: string[][]
  delivery: MerchantOrderDelivery
  /** Active authenticated account; never inferred from merchantPubkey. */
  authenticatedPubkey?: string | null
  /** Live account session authority for declaration reads and relay writes. */
  shouldContinue?: () => boolean
  /** Background automation skips foreground-only interactive coordination. */
  signerInteraction?: "external" | "background_external"
}

export function getMerchantOrderDeliveryRecipients(
  input: Pick<
    PublishMerchantOrderMessageInput,
    "merchantPubkey" | "buyerPubkey" | "delivery"
  >
): string[] {
  return input.delivery === "self_only"
    ? [input.merchantPubkey]
    : [input.buyerPubkey, input.merchantPubkey]
}

export function buildMerchantOrderRumorTags(
  input: Pick<
    PublishMerchantOrderMessageInput,
    "buyerPubkey" | "orderId" | "type" | "tags"
  >
): string[][] {
  return appendConduitClientTag(
    [
      ["p", input.buyerPubkey],
      ["type", input.type],
      ["order", input.orderId],
      ...(input.tags ?? []),
    ],
    "merchant"
  )
}

export async function cachePublishedMerchantOrderMessage(
  message: ParsedOrderMessage,
  owner: CommerceInbox,
  cacheMessage: typeof cacheParsedOrderMessage = cacheParsedOrderMessage
): Promise<boolean> {
  try {
    await cacheMessage(message, owner)
    return true
  } catch {
    console.warn("Published merchant order message could not be cached locally")
    return false
  }
}

function prepareMerchantRumor(
  rumor: PrivateMessageEvent,
  merchantPubkey: string
): void {
  rumor.pubkey = merchantPubkey
  if (!rumor.id)
    rumor.id = getEventHash({
      ...rumor,
      kind: rumor.kind!,
      created_at: rumor.created_at!,
    })
}

export interface PublishMerchantOrderMessageResult extends AccountInboxSendResult {
  /** Lane used for the critical recipient leg (route-lane provenance). */
  deliveryRoute: Exclude<PrivateMessageDeliveryRoute, "blocked">
}

export function getMerchantOrderPublishTarget(
  input: Pick<
    PublishMerchantOrderMessageInput,
    "merchantPubkey" | "buyerPubkey" | "orderId" | "delivery"
  >,
  rumor: PrivateMessageEvent
) {
  const recipientPubkey =
    input.delivery === "self_only" ? input.merchantPubkey : input.buyerPubkey
  return {
    recipientPubkey,
    selfCopy: input.delivery === "buyer_and_self",
    validatedOrderScope: createValidatedOrderRouteScope({
      rumor,
      orderId: input.orderId,
      senderPubkey: input.merchantPubkey,
      recipientPubkey,
      rumorRecipientPubkey: input.buyerPubkey,
    }),
  }
}

export async function publishMerchantOrderMessage(
  input: PublishMerchantOrderMessageInput
): Promise<PublishMerchantOrderMessageResult> {
  const signer = getAccountSigner()
  if (!signer) throw new Error("Signer not connected")
  let accountOwner: CommerceInbox | null = null
  try {
    accountOwner = getCommerceInbox(input.merchantPubkey)
  } catch {
    // Recipient delivery remains available; local history is reported after ACK.
  }

  const rumor = {
    id: "",
    pubkey: input.merchantPubkey,
    kind: 16,
    tags: [],
    content: "",
  } as PrivateMessageEvent
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = Math.floor(Date.now() / 1000)
  rumor.tags = buildMerchantOrderRumorTags(input)
  rumor.content = JSON.stringify({
    ...input.payload,
    orderId: input.orderId,
    merchantPubkey: input.merchantPubkey,
    buyerPubkey: input.buyerPubkey,
    createdAt: Date.now(),
  })
  prepareMerchantRumor(rumor, input.merchantPubkey)
  const parsed = parseOrderMessageRumorEvent(rumor)
  const checkpoint = createAcceptedInboxSendCheckpoint(async () => {
    if (!accountOwner) throw new Error("Local order history unavailable")
    if (!(await cachePublishedMerchantOrderMessage(parsed, accountOwner)))
      throw new Error("Local order history unavailable")
  })

  const target = getMerchantOrderPublishTarget(input, rumor)
  const sent = await publishPrivateMessage({
    rumor,
    senderPubkey: input.merchantPubkey,
    accountPubkey: input.merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    recipientPubkey: target.recipientPubkey,
    signer,
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: target.selfCopy,
    signerInteraction: input.signerInteraction ?? "background_external",
    onRecipientAccepted: checkpoint.onRecipientAccepted,
    // Merchant replies, invoices, and proofs belong to a validated inbound
    // order lifecycle, so they qualify for compatibility routing (CND-208).
    validatedOrderScope: target.validatedOrderScope,
    telemetryApp: "merchant",
  })
  if (sent.selfCopyError) {
    console.warn("Merchant order self-copy publish failed")
  }

  return {
    ...(await checkpoint.complete(sent, target.selfCopy)),
    deliveryRoute: sent.deliveryRoute,
  }
}
