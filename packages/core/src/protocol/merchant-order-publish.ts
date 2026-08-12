import { NDKEvent } from "@nostr-dev-kit/ndk"
import { cacheParsedOrderMessage } from "./commerce"
import { EVENT_KINDS } from "./kinds"
import { getNdk } from "./ndk"
import { appendConduitClientTag } from "./nip89"
import { parseOrderMessageRumorEvent, type ParsedOrderMessage } from "./orders"
import {
  createValidatedInboundOrderLifecycleAnchor,
  createValidatedOrderRouteScope,
  createValidatedOrderSelfRecordRouteScope,
  publishPrivateMessage,
} from "./messaging"
import type { PrivateMessageDeliveryRoute } from "./private-message-routing"

export type MerchantOrderDelivery = "buyer_and_self" | "self_only"

type ParsedInboundOrder = Extract<ParsedOrderMessage, { type: "order" }>

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
  /** Required provenance for merchant-only compatibility records. */
  inboundOrder?: ParsedInboundOrder
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

function prepareMerchantRumor(rumor: NDKEvent, merchantPubkey: string): void {
  rumor.pubkey = merchantPubkey
  if (!rumor.id) rumor.id = rumor.getEventHash()
}

export interface PublishMerchantOrderMessageResult {
  /** Lane used for the critical recipient leg (route-lane provenance). */
  deliveryRoute: Exclude<PrivateMessageDeliveryRoute, "blocked">
}

export interface MerchantOrderPublishDependencies {
  getNdk?: typeof getNdk
  publishPrivateMessage?: typeof publishPrivateMessage
  cacheParsedOrderMessage?: typeof cacheParsedOrderMessage
  now?: () => number
}

export async function publishMerchantOrderMessage(
  input: PublishMerchantOrderMessageInput,
  dependencies: MerchantOrderPublishDependencies = {}
): Promise<PublishMerchantOrderMessageResult> {
  const ndk = (dependencies.getNdk ?? getNdk)()
  if (!ndk.signer) throw new Error("Signer not connected")
  const now = dependencies.now ?? Date.now
  const createdAt = now()

  const rumor = new NDKEvent(ndk)
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = Math.floor(createdAt / 1000)
  rumor.tags = buildMerchantOrderRumorTags(input)
  rumor.content = JSON.stringify({
    ...input.payload,
    orderId: input.orderId,
    merchantPubkey: input.merchantPubkey,
    buyerPubkey: input.buyerPubkey,
    createdAt,
  })
  prepareMerchantRumor(rumor, input.merchantPubkey)

  const recipientPubkey =
    input.delivery === "self_only" ? input.merchantPubkey : input.buyerPubkey
  const validatedOrderScope =
    input.delivery === "buyer_and_self"
      ? createValidatedOrderRouteScope({
          rumor,
          orderId: input.orderId,
          senderPubkey: input.merchantPubkey,
          recipientPubkey,
        })
      : undefined
  let validatedOrderSelfRecordScope:
    ReturnType<typeof createValidatedOrderSelfRecordRouteScope> | undefined
  if (input.delivery === "self_only") {
    if (!input.inboundOrder) {
      throw new Error("Cannot publish a self-record without an inbound order.")
    }
    const inboundOrderLifecycleAnchor =
      createValidatedInboundOrderLifecycleAnchor({
        order: input.inboundOrder,
        orderId: input.orderId,
        buyerPubkey: input.buyerPubkey,
        merchantPubkey: input.merchantPubkey,
      })
    validatedOrderSelfRecordScope = createValidatedOrderSelfRecordRouteScope({
      rumor,
      orderId: input.orderId,
      senderPubkey: input.merchantPubkey,
      recipientPubkey,
      counterpartyPubkey: input.buyerPubkey,
      anchor: inboundOrderLifecycleAnchor,
    })
  }
  const publishMessage =
    dependencies.publishPrivateMessage ?? publishPrivateMessage
  const { selfCopyError, deliveryRoute } = await publishMessage({
    rumor,
    senderPubkey: input.merchantPubkey,
    recipientPubkey,
    signer: ndk.signer,
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: input.delivery === "buyer_and_self",
    // Merchant replies and self-addressed guest records belong to a validated
    // inbound order lifecycle, but use distinct one-use capabilities because a
    // self-record keeps its inner p tag bound to the buyer counterparty.
    validatedOrderScope,
    validatedOrderSelfRecordScope,
  })
  if (selfCopyError) {
    console.warn("Merchant order self-copy publish failed", selfCopyError)
  }

  const parsed = parseOrderMessageRumorEvent(rumor)
  const cacheMessage =
    dependencies.cacheParsedOrderMessage ?? cacheParsedOrderMessage
  await cacheMessage(parsed)
  return { deliveryRoute }
}
