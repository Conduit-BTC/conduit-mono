import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  cacheParsedOrderMessage,
  createOrderCompanionNotificationRumor,
  createOrderLifecycle,
  createValidatedGuestOrderCompanion,
  createValidatedOrderRouteScope,
  getNdk,
  getOrderRelayDeliveryStatus,
  parseOrderMessageRumorEvent,
  publishPrivateMessage,
  recordOrderRelayDeliveryUpdate,
  type CreateOrderLifecycleInput,
  type OrderDeliveryRoute,
  type OrderDeliveryStatus,
  type OrderRelayDeliveryRecord,
  type PreparedPrivateMessageWraps,
} from "@conduit/core"

import { inferMerchantOrigin } from "./merchant-links"

/**
 * Shared buyer order-message publishing (extracted from `checkout.tsx` so the
 * route and the route-independent payment service publish identically).
 *
 * These helpers have no React dependencies: they gift-wrap a kind-16 order
 * rumor to the merchant and, for authenticated buyers, a buyer self-copy. Guest
 * orders are merchant-only and keep only the redacted local lifecycle record.
 */

export type BuyerMessageDeliveryResult = {
  buyerSelfCopyError: string | null
  localCacheError: string | null
  /** Write lane that delivered the merchant leg (CND-208). */
  deliveryRoute: OrderDeliveryRoute
  /** Exact encrypted recipient wrap + per-relay outcomes for bounded retry. */
  orderRelayDelivery?: OrderRelayDeliveryRecord
  /** Non-blocking, content-free outcome for the advisory notification. */
  companionNotification: Promise<OrderCompanionNotificationStatus>
}

export type OrderCompanionNotificationStatus =
  | "sent"
  | "skipped_non_declared_route"
  | "skipped_non_order"
  | "skipped_order_pending"
  | "failed"

export type BuyerOrderSigningIdentity =
  | {
      kind: "guest_ephemeral"
      pubkey: string
      signer: NDKSigner
      orderId: string
      merchantPubkey: string
    }
  | {
      kind?: "signed_in"
      pubkey: string
      signer?: NDKSigner
      orderId?: never
      merchantPubkey?: never
    }

type BuyerOrderIdentityInput = string | BuyerOrderSigningIdentity

type BuyerOrderPublishDependencies = {
  publishPrivateMessageFn?: typeof publishPrivateMessage
  cacheBuyerOrderRumorFn?: typeof cacheBuyerOrderRumor
  signerInteraction?: "external" | "background_external"
  onWrapped?: (prepared: PreparedPrivateMessageWraps) => void | Promise<void>
  onOrderRelayDeliveryUpdated?: (
    delivery: OrderRelayDeliveryRecord
  ) => void | Promise<void>
}

type BuyerOrderLifecycleDraft = Omit<
  CreateOrderLifecycleInput,
  "orderDeliveryStatus" | "orderDeliveryRoute" | "orderRelayDelivery"
>

export type SubmitBuyerOrderMessageInput = {
  rumor: NDKEvent
  ndk: ReturnType<typeof getNdk>
  merchantPubkey: string
  buyer: BuyerOrderIdentityInput
  lifecycle: BuyerOrderLifecycleDraft
  /**
   * Local cleanup that becomes safe only after the exact signed wrap and relay
   * plan are durable. This is awaited before first-attempt relay I/O, so closing
   * the document cannot leave the submitted cart live.
   */
  onLifecycleCheckpointed?: (
    prepared: PreparedPrivateMessageWraps
  ) => void | Promise<void>
  /**
   * Runs only after a first-attempt relay outcome has committed to the durable
   * lifecycle. Callers may retire order-scoped recovery state here without
   * racing a later route transition or mistaking an in-memory ACK for truth.
   */
  onOrderDeliveryCommitted?: (input: {
    delivery: OrderRelayDeliveryRecord
    orderDeliveryStatus: Extract<
      OrderDeliveryStatus,
      "pending" | "sent" | "failed"
    >
  }) => void | Promise<void>
}

type SubmitBuyerOrderMessageDependencies = BuyerOrderPublishDependencies & {
  createOrderLifecycleFn?: typeof createOrderLifecycle
  recordOrderRelayDeliveryUpdateFn?: typeof recordOrderRelayDeliveryUpdate
}

export type SubmitBuyerOrderMessageResult = BuyerMessageDeliveryResult & {
  orderDeliveryStatus: Extract<
    OrderDeliveryStatus,
    "pending" | "sent" | "failed"
  >
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function resolveBuyerOrderSigningIdentity(
  ndk: ReturnType<typeof getNdk>,
  buyer: BuyerOrderIdentityInput
): BuyerOrderSigningIdentity & { signer: NDKSigner } {
  const identity =
    typeof buyer === "string" ? { pubkey: buyer, signer: ndk.signer } : buyer
  const signer = identity.signer ?? ndk.signer
  if (!signer) throw new Error("Buyer order signer is not connected.")
  if (signer.pubkey && signer.pubkey !== identity.pubkey) {
    throw new Error("Buyer order signer does not match its declared pubkey.")
  }

  return { ...identity, signer }
}

function assertBuyerOrderScope(
  rumor: NDKEvent,
  merchantPubkey: string,
  identity: BuyerOrderSigningIdentity
): void {
  if (identity.kind !== "guest_ephemeral") return
  const tags = rumor.tags ?? []
  const rumorOrderId = tags.find((tag) => tag[0] === "order")?.[1]
  const rumorRecipient = tags.find((tag) => tag[0] === "p")?.[1]
  const rumorType = tags.find((tag) => tag[0] === "type")?.[1]
  if (
    rumor.kind !== EVENT_KINDS.ORDER ||
    (rumorType !== "order" && rumorType !== "payment_proof") ||
    rumorOrderId !== identity.orderId ||
    rumorRecipient !== merchantPubkey ||
    merchantPubkey !== identity.merchantPubkey
  ) {
    throw new Error("Guest order message is outside its signer scope.")
  }
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

/**
 * Build the advisory kind-14 rumor from the authoritative order identity.
 * Reusing the order id and timestamp keeps the inner rumor stable if a caller
 * legitimately reconstructs it, while NIP-59 still randomizes each outer wrap.
 */
export function buildOrderCompanionNotificationRumor(
  authoritativeOrder: NDKEvent,
  buyerPubkey: string,
  merchantPubkey: string,
  merchantOrigin = inferMerchantOrigin()
): NDKEvent {
  return createOrderCompanionNotificationRumor({
    authoritativeOrder,
    senderPubkey: buyerPubkey,
    recipientPubkey: merchantPubkey,
    buyerIdentityKind: "signed_in",
    merchantOrigin,
  })
}

async function publishOrderCompanionNotification(input: {
  authoritativeOrder: NDKEvent
  buyerIdentity: BuyerOrderSigningIdentity & { signer: NDKSigner }
  merchantPubkey: string
  deliveryRoute: OrderDeliveryRoute
  publish: typeof publishPrivateMessage
}): Promise<OrderCompanionNotificationStatus> {
  const messageType = input.authoritativeOrder.tags.find(
    (tag) => tag[0] === "type"
  )?.[1]
  if (messageType !== "order") return "skipped_non_order"
  if (input.deliveryRoute !== "declared_inbox") {
    return "skipped_non_declared_route"
  }

  try {
    const guestCompanion =
      input.buyerIdentity.kind === "guest_ephemeral"
        ? createValidatedGuestOrderCompanion({
            authoritativeOrder: input.authoritativeOrder,
            senderPubkey: input.buyerIdentity.pubkey,
            recipientPubkey: input.merchantPubkey,
            merchantOrigin: inferMerchantOrigin(),
          })
        : undefined
    const companion =
      guestCompanion?.companion ??
      buildOrderCompanionNotificationRumor(
        input.authoritativeOrder,
        input.buyerIdentity.pubkey,
        input.merchantPubkey
      )
    await input.publish({
      rumor: companion,
      senderPubkey: input.buyerIdentity.pubkey,
      recipientPubkey: input.merchantPubkey,
      signer: input.buyerIdentity.signer,
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      selfCopy: false,
      signerInteraction:
        input.buyerIdentity.kind === "guest_ephemeral"
          ? "application_owned"
          : "background_external",
      ...(guestCompanion
        ? { validatedGuestOrderCompanionScope: guestCompanion.scope }
        : {}),
    })
    return "sent"
  } catch {
    // The companion is advisory. Its content and failure details must not enter
    // checkout delivery state, relay retry records, or buyer-facing errors.
    return "failed"
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

/**
 * Translate a delivery result into a buyer-facing notice when a non-critical
 * leg (local cache or buyer self-copy) needs retry, or when every immutable
 * merchant target returned a terminal rejection.
 */
export function getDeliveryNotice(
  delivery: BuyerMessageDeliveryResult & {
    orderDeliveryStatus?: Extract<
      OrderDeliveryStatus,
      "pending" | "sent" | "failed"
    >
  },
  label: string
): string | null {
  if (delivery.orderDeliveryStatus === "pending") {
    return `${label} is saved on this device and queued for relay delivery.`
  }
  if (delivery.orderDeliveryStatus === "failed") {
    return `${label} is saved on this device, but every planned relay permanently rejected its immutable message. Review it in Orders before placing another order.`
  }
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

export async function publishBuyerOrderMessage(
  rumor: NDKEvent,
  ndk: ReturnType<typeof getNdk>,
  merchantPubkey: string,
  buyer: BuyerOrderIdentityInput,
  dependencies: BuyerOrderPublishDependencies = {}
): Promise<BuyerMessageDeliveryResult> {
  const buyerIdentity = resolveBuyerOrderSigningIdentity(ndk, buyer)
  assertBuyerOrderScope(rumor, merchantPubkey, buyerIdentity)
  prepareBuyerRumor(rumor, buyerIdentity.pubkey)

  const publish = dependencies.publishPrivateMessageFn ?? publishPrivateMessage
  const {
    selfCopyError: buyerSelfCopyError,
    deliveryRoute,
    orderRelayDelivery,
  } = await publish({
    rumor,
    senderPubkey: buyerIdentity.pubkey,
    recipientPubkey: merchantPubkey,
    signer: buyerIdentity.signer,
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: buyerIdentity.kind !== "guest_ephemeral",
    signerInteraction:
      buyerIdentity.kind === "guest_ephemeral"
        ? "application_owned"
        : (dependencies.signerInteraction ?? "external"),
    // Checkout-created kind-16 orders are locally validated, so the merchant
    // leg may use the bounded compatibility route when the merchant has
    // no usable NIP-17 declaration (CND-208). Guest orders gain no reply
    // promise from this.
    validatedOrderScope: createValidatedOrderRouteScope({
      rumor,
      orderId: rumor.tags.find((tag) => tag[0] === "order")?.[1] ?? "",
      senderPubkey: buyerIdentity.pubkey,
      recipientPubkey: merchantPubkey,
    }),
    onWrapped: dependencies.onWrapped,
    onOrderRelayDeliveryUpdated: dependencies.onOrderRelayDeliveryUpdated,
  })

  const localCacheError =
    buyerIdentity.kind === "guest_ephemeral"
      ? null
      : await (dependencies.cacheBuyerOrderRumorFn ?? cacheBuyerOrderRumor)(
          rumor
        )
  // Start the advisory attempt only after the authoritative order has a relay
  // ACK and any signed-in local recovery copy is committed. Do not await it:
  // a slow or unavailable notification path must never keep checkout in a
  // retryable state after the order itself was accepted.
  const companionNotification = publishOrderCompanionNotification({
    authoritativeOrder: rumor,
    buyerIdentity,
    merchantPubkey,
    deliveryRoute,
    publish,
  })
  return {
    buyerSelfCopyError,
    localCacheError,
    deliveryRoute,
    companionNotification,
    ...(orderRelayDelivery ? { orderRelayDelivery } : {}),
  }
}

/**
 * Submit one initial order through a durable pre-publish checkpoint. Once the
 * exact encrypted wrap and bounded plan are stored, zero-ACK transport failure
 * becomes a locally queued order instead of an unrepeatable checkout error.
 */
export async function submitBuyerOrderMessage(
  input: SubmitBuyerOrderMessageInput,
  dependencies: SubmitBuyerOrderMessageDependencies = {}
): Promise<SubmitBuyerOrderMessageResult> {
  const rumorOrderId = input.rumor.tags.find((tag) => tag[0] === "order")?.[1]
  const buyerPubkey =
    typeof input.buyer === "string" ? input.buyer : input.buyer.pubkey
  const buyerIdentityKind =
    typeof input.buyer !== "string" && input.buyer.kind === "guest_ephemeral"
      ? "guest_ephemeral"
      : "signed_in"
  if (
    rumorOrderId !== input.lifecycle.orderId ||
    input.lifecycle.buyerPubkey !== buyerPubkey ||
    input.lifecycle.merchantPubkey !== input.merchantPubkey ||
    input.lifecycle.buyerIdentityKind !== buyerIdentityKind
  ) {
    throw new Error(
      "Order lifecycle identity does not match the order submission."
    )
  }

  const createLifecycle =
    dependencies.createOrderLifecycleFn ?? createOrderLifecycle
  const recordDelivery =
    dependencies.recordOrderRelayDeliveryUpdateFn ??
    recordOrderRelayDeliveryUpdate
  let checkpointPersisted = false
  let latestDelivery: OrderRelayDeliveryRecord | undefined

  try {
    const result = await publishBuyerOrderMessage(
      input.rumor,
      input.ndk,
      input.merchantPubkey,
      input.buyer,
      {
        ...dependencies,
        onWrapped: async (prepared) => {
          const delivery = prepared.orderRelayDelivery
          if (!delivery) {
            throw new Error("Initial order wrap could not be staged.")
          }
          await createLifecycle({
            ...input.lifecycle,
            orderDeliveryStatus: "pending",
            orderDeliveryRoute: delivery.route,
            orderRelayDelivery: delivery,
          })
          latestDelivery = delivery
          checkpointPersisted = true
          await input.onLifecycleCheckpointed?.(prepared)
          await dependencies.onWrapped?.(prepared)
        },
        onOrderRelayDeliveryUpdated: async (delivery) => {
          await recordDelivery(input.lifecycle.orderId, delivery)
          latestDelivery = delivery
          await input.onOrderDeliveryCommitted?.({
            delivery,
            orderDeliveryStatus: getOrderRelayDeliveryStatus(delivery),
          })
          await dependencies.onOrderRelayDeliveryUpdated?.(delivery)
        },
      }
    )
    return {
      ...result,
      orderDeliveryStatus: result.orderRelayDelivery
        ? getOrderRelayDeliveryStatus(result.orderRelayDelivery)
        : "failed",
    }
  } catch (error) {
    if (!checkpointPersisted || !latestDelivery) throw error
    return {
      buyerSelfCopyError: null,
      localCacheError: null,
      deliveryRoute: latestDelivery.route,
      orderRelayDelivery: latestDelivery,
      companionNotification: Promise.resolve("skipped_order_pending"),
      orderDeliveryStatus: getOrderRelayDeliveryStatus(latestDelivery),
    }
  }
}

/** Build the kind-16 payment-proof rumor for an order. */
export function buildPaymentProofRumor(params: {
  merchantPubkey: string
  orderId: string
  amountSats: number
  currency: string
  content: string
  createdAt?: number
}): NDKEvent {
  const ndk = getNdk()
  const rumor = new NDKEvent(ndk)
  rumor.kind = EVENT_KINDS.ORDER
  rumor.created_at = params.createdAt ?? Math.floor(Date.now() / 1000)
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
