import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  beginOrderRelayDeliveryAttempt,
  cacheParsedOrderMessage,
  createOrderCompanionNotificationRumor,
  createValidatedGuestOrderCompanion,
  createValidatedOrderRouteScope,
  getOrderLifecycle,
  getNdk,
  parseOrderMessageRumorEvent,
  publishPrivateMessage,
  recordOrderRelayDeliveryOutcomes,
  stageOrderRelayDelivery,
  type OrderDeliveryRoute,
  type OrderLifecycleItem,
  type OrderRelayDeliveryRepository,
  type OrderRelayDeliveryRecord,
  type SignedPublicNostrEvent,
  type StagedOrderLifecycleInput,
} from "@conduit/core"

import { rememberCheckoutOrderAttempt } from "./checkout-order-attempt"
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
  | "skipped_session_changed"
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
  accountPubkey?: string | null
  authenticatedPubkey?: string | null
  relayAuthMethod?: "nip07" | "nip46"
  shouldContinue?: () => boolean
  /** Initial order snapshot persisted with the exact recipient wrap pre-send. */
  orderLifecycle?: StagedOrderLifecycleInput
  /** Focused test seam; production uses the transactional Dexie repository. */
  orderRelayDeliveryRepository?: OrderRelayDeliveryRepository
  getOrderLifecycleFn?: typeof getOrderLifecycle
  rememberCheckoutOrderAttemptFn?: typeof rememberCheckoutOrderAttempt
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function canonicalizeOrderSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeOrderSnapshot)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeOrderSnapshot(entry)])
  )
}

function sameOrderSnapshot(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalizeOrderSnapshot(left)) ===
    JSON.stringify(canonicalizeOrderSnapshot(right))
  )
}

/** Bind the local payment/recovery snapshot to the exact plaintext order. */
export function assertStagedOrderLifecycleMatchesRumor(
  lifecycle: StagedOrderLifecycleInput,
  rumor: NDKEvent,
  buyerPubkey: string,
  merchantPubkey: string
): void {
  let parsed: ReturnType<typeof parseOrderMessageRumorEvent>
  try {
    parsed = parseOrderMessageRumorEvent(rumor)
  } catch {
    throw new Error("Cannot stage an invalid order rumor.")
  }
  const orderTags = rumor.tags.filter((tag) => tag[0] === "order")
  const recipientTags = rumor.tags.filter((tag) => tag[0] === "p")
  const typeTags = rumor.tags.filter((tag) => tag[0] === "type")
  const amountTags = rumor.tags.filter((tag) => tag[0] === "amount")
  const currencyTags = rumor.tags.filter((tag) => tag[0] === "currency")
  if (
    parsed.type !== "order" ||
    rumor.kind !== EVENT_KINDS.ORDER ||
    orderTags.length !== 1 ||
    recipientTags.length !== 1 ||
    typeTags.length !== 1 ||
    amountTags.length !== 1 ||
    currencyTags.length !== 1 ||
    typeTags[0]?.[1] !== "order"
  ) {
    throw new Error("Order rumor tags do not match the staged order.")
  }

  const payload = parsed.payload
  const normalizedBuyer = buyerPubkey.trim().toLowerCase()
  const normalizedMerchant = merchantPubkey.trim().toLowerCase()
  const projectedItems: OrderLifecycleItem[] = payload.items.map((item) => ({
    productId: item.productId,
    familyProductId: item.familyProductId,
    selectedSpecifications: item.selectedSpecifications?.map(
      (specification) => ({ ...specification })
    ),
    title: item.title,
    format: item.format,
    fulfillment: item.fulfillment,
    quantity: item.quantity,
    priceAtPurchase: item.priceAtPurchase,
    currency: item.currency,
    shippingCostSats: item.shippingCostSats,
    sourceShippingCost: item.sourceShippingCost
      ? { ...item.sourceShippingCost }
      : undefined,
    shippingOptionId: item.shippingOptionId,
    shippingOptionDTag: item.shippingOptionDTag,
    shippingCountryRules: item.shippingCountryRules?.map((rule) => ({
      code: rule.code,
      restrictTo: [...rule.restrictTo],
      exclude: [...rule.exclude],
    })),
    sourcePrice: item.sourcePrice ? { ...item.sourcePrice } : undefined,
  }))
  const shippingCostMatches =
    payload.shippingCostStatus === "manual"
      ? payload.shippingCostSats === undefined &&
        lifecycle.shippingCostSats === 0
      : (payload.shippingCostSats ?? 0) === lifecycle.shippingCostSats
  const computedItemSubtotal = lifecycle.items.reduce(
    (subtotal, item) => subtotal + item.priceAtPurchase * item.quantity,
    0
  )
  const computedTotal = lifecycle.itemSubtotalSats + lifecycle.shippingCostSats
  const privateSnapshotMatches =
    lifecycle.buyerIdentityKind === "signed_in"
      ? sameOrderSnapshot(lifecycle.shippingAddress, payload.shippingAddress) &&
        lifecycle.contactNote === payload.note &&
        lifecycle.guestContact === undefined &&
        payload.guestContact === undefined
      : lifecycle.shippingAddress === undefined &&
        lifecycle.contactNote === undefined &&
        lifecycle.guestContact === undefined

  if (
    rumor.pubkey.trim().toLowerCase() !== normalizedBuyer ||
    parsed.senderPubkey.trim().toLowerCase() !== normalizedBuyer ||
    payload.buyerPubkey.trim().toLowerCase() !== normalizedBuyer ||
    lifecycle.buyerPubkey.trim().toLowerCase() !== normalizedBuyer ||
    recipientTags[0]?.[1]?.trim().toLowerCase() !== normalizedMerchant ||
    parsed.recipientPubkey.trim().toLowerCase() !== normalizedMerchant ||
    payload.merchantPubkey.trim().toLowerCase() !== normalizedMerchant ||
    lifecycle.merchantPubkey.trim().toLowerCase() !== normalizedMerchant ||
    orderTags[0]?.[1] !== lifecycle.orderId ||
    parsed.orderId !== lifecycle.orderId ||
    payload.id !== lifecycle.orderId ||
    payload.buyerIdentityKind !== lifecycle.buyerIdentityKind ||
    payload.createdAt !== lifecycle.createdAt ||
    payload.currency !== lifecycle.currency ||
    currencyTags[0]?.[1] !== lifecycle.currency ||
    payload.subtotal !== lifecycle.totalSats ||
    amountTags[0]?.[1] !== String(lifecycle.totalSats) ||
    lifecycle.totalMsats !== lifecycle.totalSats * 1_000 ||
    lifecycle.itemSubtotalSats !== computedItemSubtotal ||
    lifecycle.totalSats !== computedTotal ||
    !shippingCostMatches ||
    !sameOrderSnapshot(projectedItems, lifecycle.items) ||
    !privateSnapshotMatches
  ) {
    throw new Error("Order rumor does not match its staged lifecycle snapshot.")
  }
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
  let derivedId: string
  try {
    derivedId = rumor.getEventHash()
  } catch {
    throw new Error("Failed to derive buyer order rumor id.")
  }
  if (rumor.id && rumor.id !== derivedId) {
    throw new Error("Buyer order rumor id does not match its content.")
  }
  rumor.id = derivedId
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
  accountPubkey: string | null
  authenticatedPubkey: string | null
  shouldContinue?: () => boolean
}): Promise<OrderCompanionNotificationStatus> {
  const messageType = input.authoritativeOrder.tags.find(
    (tag) => tag[0] === "type"
  )?.[1]
  if (messageType !== "order") return "skipped_non_order"
  if (input.deliveryRoute !== "declared_inbox") {
    return "skipped_non_declared_route"
  }
  // The merchant already ACKed the authoritative order. Do not construct or
  // wrap the advisory companion with a stale signed-in session.
  if (input.shouldContinue?.() === false) {
    return "skipped_session_changed"
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
      accountPubkey: input.accountPubkey,
      authenticatedPubkey: input.authenticatedPubkey,
      shouldContinue: input.shouldContinue,
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
 * leg (local cache or buyer self-copy) needs retry. The merchant copy is always
 * critical and throws on failure, so reaching here means at least one intended
 * delivery relay accepted the merchant leg for pickup.
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
  if (dependencies.orderLifecycle) {
    assertStagedOrderLifecycleMatchesRumor(
      dependencies.orderLifecycle,
      rumor,
      buyerIdentity.pubkey,
      merchantPubkey
    )
  }
  const accountPubkey =
    buyerIdentity.kind === "guest_ephemeral"
      ? null
      : (dependencies.accountPubkey ?? null)
  const shouldContinue =
    buyerIdentity.kind === "guest_ephemeral"
      ? dependencies.shouldContinue
      : () =>
          (dependencies.shouldContinue?.() ?? true) &&
          ndk.signer === buyerIdentity.signer

  const publish = dependencies.publishPrivateMessageFn ?? publishPrivateMessage
  const orderDeliveryLeaseOwner =
    globalThis.crypto?.randomUUID?.() ??
    `order-delivery-${Date.now()}-${Math.random()}`
  let orderDeliveryGenerations: Readonly<Record<string, number>> | null = null
  let orderDeliveryWrapId: string | null = null
  const stagedOrderId = dependencies.orderLifecycle?.orderId ?? null
  const orderRelayDeliveryOptions = dependencies.orderRelayDeliveryRepository
    ? { repository: dependencies.orderRelayDeliveryRepository }
    : undefined
  const rememberAttempt =
    dependencies.rememberCheckoutOrderAttemptFn ?? rememberCheckoutOrderAttempt
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
    accountPubkey,
    authenticatedPubkey:
      buyerIdentity.kind === "guest_ephemeral"
        ? null
        : dependencies.authenticatedPubkey,
    shouldContinue,
    signerInteraction:
      buyerIdentity.kind === "guest_ephemeral"
        ? "application_owned"
        : (dependencies.signerInteraction ?? "external"),
    ...(buyerIdentity.kind !== "guest_ephemeral" &&
    (dependencies.signerInteraction ?? "external") === "external" &&
    dependencies.relayAuthMethod
      ? { relayAuthMethod: dependencies.relayAuthMethod }
      : {}),
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
    telemetryApp: "market",
    ...(dependencies.orderLifecycle
      ? {
          onRecipientPrepared: async (prepared) => {
            const staged = await stageOrderRelayDelivery(
              {
                lifecycle: dependencies.orderLifecycle!,
                leaseOwner: orderDeliveryLeaseOwner,
                prepared: {
                  rumorId: prepared.rumorId,
                  signedRecipientWrap:
                    prepared.wrappedToRecipient.rawEvent() as SignedPublicNostrEvent,
                  route: prepared.deliveryRoute,
                  ...(prepared.routingAuthority
                    ? { routingAuthority: prepared.routingAuthority }
                    : {}),
                  ...(prepared.compatibilityPlan
                    ? { compatibilityPlan: prepared.compatibilityPlan }
                    : {}),
                  relayPlan: prepared.relayPlan,
                },
              },
              orderRelayDeliveryOptions
            )
            const expiresAt = staged.lifecycle.orderRelayDelivery?.expiresAt
            if (expiresAt !== undefined) {
              rememberAttempt(staged.lifecycle.orderId, expiresAt)
            }
          },
          onRecipientPublishStarting: async (prepared) => {
            const begun = await beginOrderRelayDeliveryAttempt(
              {
                orderId: dependencies.orderLifecycle!.orderId,
                buyerPubkey: buyerIdentity.pubkey,
                leaseOwner: orderDeliveryLeaseOwner,
                relayUrls: prepared.relayPlan.map(({ relayUrl }) => relayUrl),
                shouldContinue,
              },
              orderRelayDeliveryOptions
            )
            orderDeliveryGenerations = begun.generationsByRelay
            orderDeliveryWrapId = begun.wrapId
          },
          onRecipientPublishSettled: async (recipientDelivery) => {
            if (
              orderDeliveryGenerations === null ||
              orderDeliveryWrapId === null
            ) {
              throw new Error("Order delivery outcomes arrived before staging.")
            }
            const successful = new Set(
              recipientDelivery?.successfulRelayUrls ?? []
            )
            const rejected = new Set(recipientDelivery?.rejectedRelayUrls ?? [])
            await recordOrderRelayDeliveryOutcomes(
              {
                orderId: dependencies.orderLifecycle!.orderId,
                buyerPubkey: buyerIdentity.pubkey,
                leaseOwner: orderDeliveryLeaseOwner,
                wrapId: orderDeliveryWrapId,
                outcomes: Object.entries(orderDeliveryGenerations).map(
                  ([relayUrl, generation]) => ({
                    relayUrl,
                    status: successful.has(relayUrl)
                      ? ("acked" as const)
                      : rejected.has(relayUrl)
                        ? ("rejected" as const)
                        : ("timed_out" as const),
                    generation,
                  })
                ),
                releaseLease: true,
              },
              orderRelayDeliveryOptions
            )
          },
        }
      : {}),
  })

  const stagedLifecycle = stagedOrderId
    ? await (
        dependencies.getOrderLifecycleFn ??
        dependencies.orderRelayDeliveryRepository?.get.bind(
          dependencies.orderRelayDeliveryRepository
        ) ??
        getOrderLifecycle
      )(stagedOrderId)
    : undefined
  if (
    dependencies.orderLifecycle &&
    stagedLifecycle?.orderDeliveryStatus !== "sent"
  ) {
    throw new Error(
      "Recipient relay acceptance was not committed to the staged order."
    )
  }

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
    accountPubkey,
    authenticatedPubkey:
      buyerIdentity.kind === "guest_ephemeral"
        ? null
        : (dependencies.authenticatedPubkey ?? null),
    shouldContinue,
  })
  return {
    buyerSelfCopyError,
    localCacheError,
    deliveryRoute,
    companionNotification,
    ...(stagedLifecycle?.orderRelayDelivery
      ? { orderRelayDelivery: stagedLifecycle.orderRelayDelivery }
      : orderRelayDelivery
        ? { orderRelayDelivery }
        : {}),
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
