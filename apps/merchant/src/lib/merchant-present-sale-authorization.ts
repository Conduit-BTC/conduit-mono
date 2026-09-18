import type { NDKSigner } from "@nostr-dev-kit/ndk"

import {
  EVENT_KINDS,
  buildMerchantPresentSaleAuthorization,
  buildMerchantPresentSaleAuthorizationRumor,
  cachePublishedMerchantOrderMessage,
  createMerchantPresentSaleAuthorizationNonce,
  createValidatedOrderRouteScope,
  orderSchema,
  parseOrderMessageRumorEvent,
  prepareMerchantPresentSaleDirectWrap,
  publishPrivateMessage,
  type MerchantPresentSaleAuthorizationSchema,
  type OrderSchema,
  type SignedPublicNostrEvent,
} from "@conduit/core"

export type MerchantPresentSaleDeliveryMode =
  "signed_in_private" | "guest_direct"

export type MerchantPresentSaleDeliveryResult =
  | {
      mode: "signed_in_private"
      expiresAt: number
      deliveryRoute: "declared_inbox" | "compatibility_order"
      deliveryStatus: "full_success" | "partial_success"
      selfCopyError: string | null
    }
  | {
      mode: "guest_direct"
      expiresAt: number
      transferValue: string
      wrap: SignedPublicNostrEvent
    }

function assertMerchantPresentOrder(
  input: OrderSchema,
  merchantPubkey: string
): {
  order: OrderSchema
  mode: MerchantPresentSaleDeliveryMode
} {
  const order = orderSchema.parse(input)
  const normalizedMerchant = merchantPubkey.trim().toLowerCase()
  if (
    !normalizedMerchant ||
    order.merchantPubkey.toLowerCase() !== normalizedMerchant ||
    order.purchaseContext?.type !== "merchant_present" ||
    order.purchaseContext.merchantPubkey.toLowerCase() !== normalizedMerchant
  ) {
    throw new Error(
      "Only an authenticated merchant-present order for this merchant can be confirmed at the booth."
    )
  }
  if (order.buyerIdentityKind === "guest_ephemeral") {
    return { order, mode: "guest_direct" }
  }
  if (order.buyerIdentityKind === "signed_in") {
    return { order, mode: "signed_in_private" }
  }
  throw new Error(
    "The buyer identity for this booth order is missing. Ask the buyer to restart the booth checkout."
  )
}

export function getMerchantPresentSaleDeliveryMode(
  input: OrderSchema,
  merchantPubkey: string
): MerchantPresentSaleDeliveryMode | null {
  try {
    return assertMerchantPresentOrder(input, merchantPubkey).mode
  } catch {
    return null
  }
}

export interface PrepareMerchantPresentSaleAuthorizationInput {
  order: OrderSchema
  merchantPubkey: string
  previous?: MerchantPresentSaleAuthorizationSchema | null
  now?: number
  createNonce?: () => string
}

/**
 * Reuse one exact nonce across a delivery retry. A changed order, expired
 * authorization, or different merchant always produces a new capability.
 */
export function prepareMerchantPresentSaleAuthorization(
  input: PrepareMerchantPresentSaleAuthorizationInput
): MerchantPresentSaleAuthorizationSchema {
  const { order } = assertMerchantPresentOrder(
    input.order,
    input.merchantPubkey
  )
  const now = input.now ?? Math.floor(Date.now() / 1_000)
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Merchant-present authorization clock is invalid.")
  }

  if (input.previous && input.previous.expiresAt > now) {
    try {
      const rebuilt = buildMerchantPresentSaleAuthorization({
        order,
        nonce: input.previous.nonce,
        issuedAt: input.previous.issuedAt,
        expiresAt: input.previous.expiresAt,
      })
      if (JSON.stringify(rebuilt) === JSON.stringify(input.previous)) {
        return input.previous
      }
    } catch {
      // A stale or malformed prior capability is replaced below.
    }
  }

  return buildMerchantPresentSaleAuthorization({
    order,
    nonce:
      input.createNonce?.() ?? createMerchantPresentSaleAuthorizationNonce(),
    issuedAt: now,
  })
}

export function serializeMerchantPresentSaleDirectWrap(
  wrap: SignedPublicNostrEvent
): string {
  return JSON.stringify(wrap)
}

// Version 40-L carries at most 2,953 bytes in byte mode. Leave headroom for
// encoder mode/version selection instead of letting an oversized wrap crash
// the order surface. The exact copy/manual transfer remains available.
const MAX_SINGLE_QR_TRANSFER_BYTES = 2_800

export function canRenderMerchantPresentSaleDirectWrapQr(
  transferValue: string
): boolean {
  return (
    new TextEncoder().encode(transferValue).byteLength <=
    MAX_SINGLE_QR_TRANSFER_BYTES
  )
}

export interface DeliverMerchantPresentSaleAuthorizationInput {
  authorization: MerchantPresentSaleAuthorizationSchema
  order: OrderSchema
  merchantPubkey: string
  signer: NDKSigner
  authenticatedPubkey: string | null
  shouldContinue: () => boolean
}

export interface MerchantPresentSaleDeliveryDependencies {
  prepareGuestWrap: typeof prepareMerchantPresentSaleDirectWrap
  publishSignedIn: (
    input: DeliverMerchantPresentSaleAuthorizationInput & { order: OrderSchema }
  ) => Promise<{
    deliveryRoute: "declared_inbox" | "compatibility_order"
    deliveryStatus: "full_success" | "partial_success"
    selfCopyError: string | null
  }>
}

async function publishSignedInMerchantPresentSaleAuthorization(
  input: DeliverMerchantPresentSaleAuthorizationInput & { order: OrderSchema }
): Promise<{
  deliveryRoute: "declared_inbox" | "compatibility_order"
  deliveryStatus: "full_success" | "partial_success"
  selfCopyError: string | null
}> {
  const rumor = buildMerchantPresentSaleAuthorizationRumor(input.authorization)
  const validatedOrderScope = createValidatedOrderRouteScope({
    rumor,
    orderId: input.order.id,
    senderPubkey: input.order.merchantPubkey,
    recipientPubkey: input.order.buyerPubkey,
  })
  const delivery = await publishPrivateMessage({
    rumor,
    senderPubkey: input.order.merchantPubkey,
    recipientPubkey: input.order.buyerPubkey,
    accountPubkey: input.order.merchantPubkey,
    authenticatedPubkey: input.authenticatedPubkey,
    shouldContinue: input.shouldContinue,
    signer: input.signer,
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: true,
    signerInteraction: "external",
    validatedOrderScope,
  })
  await cachePublishedMerchantOrderMessage(parseOrderMessageRumorEvent(rumor))
  return {
    deliveryRoute: delivery.deliveryRoute,
    deliveryStatus: delivery.deliveryStatus,
    selfCopyError: delivery.selfCopyError,
  }
}

const DEFAULT_DELIVERY_DEPENDENCIES: MerchantPresentSaleDeliveryDependencies = {
  prepareGuestWrap: prepareMerchantPresentSaleDirectWrap,
  publishSignedIn: publishSignedInMerchantPresentSaleAuthorization,
}

/**
 * Deliver the booth capability through exactly one identity-appropriate lane.
 * Signed-in buyers use their private order channel; guests receive one exact
 * NIP-59 wrap for direct in-person transfer and never gain an inbox.
 */
export async function deliverMerchantPresentSaleAuthorization(
  input: DeliverMerchantPresentSaleAuthorizationInput,
  dependencies: MerchantPresentSaleDeliveryDependencies = DEFAULT_DELIVERY_DEPENDENCIES
): Promise<MerchantPresentSaleDeliveryResult> {
  const { order, mode } = assertMerchantPresentOrder(
    input.order,
    input.merchantPubkey
  )
  if (
    input.authorization.orderId !== order.id ||
    input.authorization.merchantPubkey.toLowerCase() !==
      order.merchantPubkey.toLowerCase() ||
    input.authorization.buyerPubkey.toLowerCase() !==
      order.buyerPubkey.toLowerCase()
  ) {
    throw new Error(
      "The booth authorization does not match the selected authenticated order."
    )
  }

  if (mode === "guest_direct") {
    const wrap = await dependencies.prepareGuestWrap({
      authorization: input.authorization,
      merchantSigner: input.signer,
    })
    return {
      mode,
      expiresAt: input.authorization.expiresAt,
      transferValue: serializeMerchantPresentSaleDirectWrap(wrap),
      wrap,
    }
  }

  const delivery = await dependencies.publishSignedIn({ ...input, order })
  return {
    mode,
    expiresAt: input.authorization.expiresAt,
    deliveryRoute: delivery.deliveryRoute,
    deliveryStatus: delivery.deliveryStatus,
    selfCopyError: delivery.selfCopyError,
  }
}
