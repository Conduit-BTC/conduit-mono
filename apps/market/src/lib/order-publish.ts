import { NDKEvent, NDKUser, giftWrap, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  cacheParsedOrderMessage,
  getNdk,
  withTransientNip07Retry,
  parseOrderMessageRumorEvent,
  publishWithPlanner,
  type TransientNip07RetryOptions,
} from "@conduit/core"

/**
 * Shared buyer order-message publishing (extracted from `checkout.tsx` so the
 * route and the route-independent payment service publish identically).
 *
 * These helpers have no React dependencies: they gift-wrap a kind-16 order
 * rumor to the merchant and a buyer self-copy, publish both via the relay
 * planner, and cache the rumor locally for instant order-history readback.
 */

export type BuyerMessageDeliveryResult = {
  buyerSelfCopyError: string | null
  localCacheError: string | null
}

export interface BuyerOrderSigningIdentity {
  pubkey: string
  signer?: NDKSigner
}

type BuyerOrderIdentityInput = string | BuyerOrderSigningIdentity

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function resolveBuyerOrderSigningIdentity(
  ndk: ReturnType<typeof getNdk>,
  buyer: BuyerOrderIdentityInput
): Required<BuyerOrderSigningIdentity> {
  const identity =
    typeof buyer === "string" ? { pubkey: buyer, signer: ndk.signer } : buyer
  const signer = identity.signer ?? ndk.signer
  if (!signer) throw new Error("Buyer order signer is not connected.")

  return { pubkey: identity.pubkey, signer }
}

/** Stamp the buyer pubkey + derive the rumor id (so it can be cached/wrapped). */
export function prepareBuyerRumor(rumor: NDKEvent, buyerPubkey: string): void {
  rumor.pubkey = buyerPubkey
  if (rumor.id) return
  try {
    rumor.id = rumor.getEventHash()
  } catch (error) {
    console.warn("Failed to derive buyer order rumor id", error)
  }
}

async function cacheBuyerOrderRumor(rumor: NDKEvent): Promise<string | null> {
  try {
    if (!rumor.id) throw new Error("Missing buyer order rumor id")
    const parsed = parseOrderMessageRumorEvent(rumor)
    await cacheParsedOrderMessage(parsed)
    return null
  } catch (error) {
    console.warn("Failed to cache buyer order message", error)
    return getErrorMessage(error, "Failed to cache buyer order message")
  }
}

type GiftWrapDependency = typeof giftWrap

export async function createBuyerGiftWrapsForMerchantAndSelf(
  rumor: NDKEvent,
  ndk: ReturnType<typeof getNdk>,
  merchantPubkey: string,
  buyer: BuyerOrderIdentityInput,
  options: TransientNip07RetryOptions & {
    giftWrapFn?: GiftWrapDependency
  } = {}
): Promise<{
  wrappedToMerchant: NDKEvent
  wrappedToSelf: NDKEvent
}> {
  const giftWrapFn = options.giftWrapFn ?? giftWrap
  const buyerIdentity = resolveBuyerOrderSigningIdentity(ndk, buyer)
  const merchantUser = new NDKUser({ pubkey: merchantPubkey })
  const buyerUser = new NDKUser({ pubkey: buyerIdentity.pubkey })
  const wrapParams = { rumorKind: EVENT_KINDS.ORDER }

  const wrappedToMerchant = await withTransientNip07Retry(
    () => giftWrapFn(rumor, merchantUser, buyerIdentity.signer, wrapParams),
    options
  )
  const wrappedToSelf = await withTransientNip07Retry(
    () => giftWrapFn(rumor, buyerUser, buyerIdentity.signer, wrapParams),
    options
  )

  return { wrappedToMerchant, wrappedToSelf }
}

/**
 * Translate a delivery result into a buyer-facing notice when a non-critical
 * leg (local cache or buyer self-copy) needs retry. The merchant copy is always
 * critical and throws on failure, so reaching here means the merchant has it.
 */
export function getDeliveryNotice(
  delivery: BuyerMessageDeliveryResult,
  label: string
): string | null {
  if (delivery.localCacheError && delivery.buyerSelfCopyError) {
    return `${label} was accepted by Nostr delivery relays for merchant pickup, but order history recovery needs retry.`
  }
  if (delivery.localCacheError) {
    return `${label} was accepted by Nostr delivery relays for merchant pickup. Order history may update after relay sync.`
  }
  if (delivery.buyerSelfCopyError) {
    return `${label} was accepted by Nostr delivery relays for merchant pickup and saved locally. Buyer relay backup needs retry.`
  }
  return null
}

export async function publishWrappedToMerchantAndSelf(
  rumor: NDKEvent,
  ndk: ReturnType<typeof getNdk>,
  merchantPubkey: string,
  buyer: BuyerOrderIdentityInput
): Promise<BuyerMessageDeliveryResult> {
  const buyerIdentity = resolveBuyerOrderSigningIdentity(ndk, buyer)
  prepareBuyerRumor(rumor, buyerIdentity.pubkey)

  const { wrappedToMerchant, wrappedToSelf } =
    await createBuyerGiftWrapsForMerchantAndSelf(
      rumor,
      ndk,
      merchantPubkey,
      buyerIdentity
    )

  await publishWithPlanner(wrappedToMerchant, {
    intent: "recipient_event",
    authorPubkey: buyerIdentity.pubkey,
    authenticatedPubkey: buyerIdentity.pubkey,
    recipientPubkeys: [merchantPubkey],
    refreshRelayLists: true,
    deliveryMode: "critical",
  })

  let buyerSelfCopyError: string | null = null
  try {
    await publishWithPlanner(wrappedToSelf, {
      intent: "recipient_event",
      authorPubkey: buyerIdentity.pubkey,
      authenticatedPubkey: buyerIdentity.pubkey,
      recipientPubkeys: [buyerIdentity.pubkey],
      refreshRelayLists: true,
      deliveryMode: "critical",
    })
  } catch (selfCopyError) {
    console.warn("Buyer self-copy publish failed", selfCopyError)
    buyerSelfCopyError = getErrorMessage(
      selfCopyError,
      "Buyer self-copy publish failed"
    )
  }

  const localCacheError = await cacheBuyerOrderRumor(rumor)
  return { buyerSelfCopyError, localCacheError }
}

/** Build the kind-16 payment-proof rumor for an order. */
export function buildPaymentProofRumor(params: {
  merchantPubkey: string
  orderId: string
  amountSats: number
  currency: string
  content: string
}): NDKEvent {
  const ndk = getNdk()
  const rumor = new NDKEvent(ndk)
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = Math.floor(Date.now() / 1000)
  rumor.tags = appendConduitClientTag(
    [
      ["p", params.merchantPubkey],
      ["type", "payment_proof"],
      ["order", params.orderId],
      ["amount", String(params.amountSats)],
      ["currency", params.currency],
      ["rail", "lightning"],
    ],
    "market"
  )
  rumor.content = params.content
  return rumor
}
