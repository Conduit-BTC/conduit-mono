import { NDKEvent } from "@nostr-dev-kit/ndk"
import { cacheParsedOrderMessage } from "./commerce"
import { EVENT_KINDS } from "./kinds"
import { getNdk } from "./ndk"
import { appendConduitClientTag } from "./nip89"
import { parseOrderMessageRumorEvent } from "./orders"
import { publishPrivateMessage } from "./messaging"

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

export async function publishMerchantOrderMessage(
  input: PublishMerchantOrderMessageInput
): Promise<void> {
  const ndk = getNdk()
  if (!ndk.signer) throw new Error("Signer not connected")

  const rumor = new NDKEvent(ndk)
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

  const recipientPubkey =
    input.delivery === "self_only" ? input.merchantPubkey : input.buyerPubkey
  const { selfCopyError } = await publishPrivateMessage({
    rumor,
    senderPubkey: input.merchantPubkey,
    recipientPubkey,
    signer: ndk.signer,
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: input.delivery === "buyer_and_self",
  })
  if (selfCopyError) {
    console.warn("Merchant order self-copy publish failed", selfCopyError)
  }

  const parsed = parseOrderMessageRumorEvent(rumor)
  await cacheParsedOrderMessage(parsed)
}
