import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  appendConduitClientTag,
  beginOrderRelayDeliveryAttempt,
  cacheParsedOrderMessage,
  createOrderCompanionNotificationRumor,
  createValidatedGuestOrderCompanion,
  createValidatedOrderRouteScope,
  getNdk,
  parseOrderMessageRumorEvent,
  patchOrderLifecycle,
  publishPrivateMessage,
  recordOrderRelayDeliveryOutcomes,
  stageOrderRelayDelivery,
  type OrderDeliveryRoute,
  type OrderLifecycle,
  type OrderLifecycleItem,
  type OrderRelayDeliveryRecord,
  type PrivateMessagePostAcceptanceResult,
  type ProgressivePublishSnapshot,
  type PublishWithPlannerResult,
  type SignedPublicNostrEvent,
  type StagedOrderLifecycleInput,
} from "@conduit/core"

import { inferMerchantOrigin } from "./merchant-links"
import { rememberCheckoutOrderAttempt } from "./checkout-order-attempt"

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
  /** Memoized recovery work that the owning checkout starts at a safe time. */
  startPostAcceptanceWork?: () => Promise<BuyerPostAcceptanceResult>
}

export type BuyerPostAcceptanceResult = {
  buyerSelfCopyError: string | null
  localCacheError: string | null
  companionNotification: OrderCompanionNotificationStatus
}

export type BuyerOrderPublishPhase =
  "not_staged" | "staged" | "write_started" | "accepted_committed"

export class BuyerOrderPublishError extends Error {
  readonly phase: BuyerOrderPublishPhase
  readonly cause: unknown

  constructor(message: string, phase: BuyerOrderPublishPhase, cause: unknown) {
    super(message)
    this.name = "BuyerOrderPublishError"
    this.phase = phase
    this.cause = cause
  }
}

export function shouldPreserveCheckoutOrderAttempt(error: unknown): boolean {
  return error instanceof BuyerOrderPublishError && error.phase !== "not_staged"
}

export type OrderCompanionNotificationStatus =
  "sent" | "skipped_non_declared_route" | "skipped_non_order" | "failed"

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
  shouldContinue?: () => boolean
  /** Initial order snapshot persisted with the exact recipient wrap pre-send. */
  orderLifecycle?: StagedOrderLifecycleInput
  /** Deterministic durable-boundary seams for focused checkout tests. */
  stageOrderRelayDeliveryFn?: typeof stageOrderRelayDelivery
  beginOrderRelayDeliveryAttemptFn?: typeof beginOrderRelayDeliveryAttempt
  recordOrderRelayDeliveryOutcomesFn?: typeof recordOrderRelayDeliveryOutcomes
  patchOrderLifecycleFn?: typeof patchOrderLifecycle
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
  const signedInPrivateSnapshotMatches =
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
    !signedInPrivateSnapshotMatches
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

function clonePreparedBuyerRumor(rumor: NDKEvent): NDKEvent {
  return new NDKEvent(rumor.ndk, {
    kind: rumor.kind,
    id: rumor.id,
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    tags: rumor.tags.map((tag) => [...tag]),
    content: rumor.content,
    sig: "",
  })
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
  if (input.shouldContinue?.() === false) return "failed"
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
    if (input.shouldContinue?.() === false) return "failed"
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
  let publishPhase: BuyerOrderPublishPhase = "not_staged"
  let acceptedLifecycle: OrderLifecycle | undefined
  const stageDelivery =
    dependencies.stageOrderRelayDeliveryFn ?? stageOrderRelayDelivery
  const beginDeliveryAttempt =
    dependencies.beginOrderRelayDeliveryAttemptFn ??
    beginOrderRelayDeliveryAttempt
  const recordDeliveryOutcomes =
    dependencies.recordOrderRelayDeliveryOutcomesFn ??
    recordOrderRelayDeliveryOutcomes
  const patchLifecycle =
    dependencies.patchOrderLifecycleFn ?? patchOrderLifecycle

  const persistOrderRelayOutcomes = async (
    recipientDelivery: PublishWithPlannerResult | ProgressivePublishSnapshot,
    options: { ackOnly: boolean; releaseLease: boolean }
  ) => {
    if (orderDeliveryGenerations === null || orderDeliveryWrapId === null) {
      throw new Error("Order delivery outcomes arrived before staging.")
    }
    const successful = new Set(recipientDelivery.successfulRelayUrls ?? [])
    const pending = new Set(
      "pendingRelayUrls" in recipientDelivery
        ? recipientDelivery.pendingRelayUrls
        : []
    )
    const rejected = new Set(
      "rejectedRelayUrls" in recipientDelivery
        ? recipientDelivery.rejectedRelayUrls
        : []
    )
    const failures = recipientDelivery.relayFailureMessages ?? {}
    const persisted = await recordDeliveryOutcomes({
      orderId: dependencies.orderLifecycle!.orderId,
      buyerPubkey: buyerIdentity.pubkey,
      leaseOwner: orderDeliveryLeaseOwner,
      wrapId: orderDeliveryWrapId,
      outcomes: recipientDelivery.attemptedRelayUrls.flatMap((relayUrl) => {
        const generation = orderDeliveryGenerations?.[relayUrl]
        if (
          generation === undefined ||
          pending.has(relayUrl) ||
          (options.ackOnly && !successful.has(relayUrl))
        ) {
          return []
        }
        return [
          {
            relayUrl,
            status: successful.has(relayUrl)
              ? ("acked" as const)
              : rejected.has(relayUrl) ||
                  /^(?:pow|blocked|rate-limited|invalid|restricted|mute|error):/i.test(
                    failures[relayUrl]?.trim() ?? ""
                  )
                ? ("rejected" as const)
                : ("timed_out" as const),
            generation,
          },
        ]
      }),
      releaseLease: options.releaseLease,
    })
    if (persisted?.orderDeliveryStatus === "sent") {
      publishPhase = "accepted_committed"
      acceptedLifecycle = persisted
    }
    return persisted
  }

  let publishedMessage: Awaited<ReturnType<typeof publish>>
  try {
    publishedMessage = await publish({
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
      ...(dependencies.orderLifecycle
        ? {
            recipientDeliveryBoundary: "accepted" as const,
            onRecipientPrepared: async (prepared) => {
              rememberCheckoutOrderAttempt(dependencies.orderLifecycle!.orderId)
              const staged = await stageDelivery({
                lifecycle: dependencies.orderLifecycle!,
                leaseOwner: orderDeliveryLeaseOwner,
                prepared: {
                  rumorId: prepared.rumorId,
                  signedRecipientWrap:
                    prepared.wrappedToRecipient.rawEvent() as SignedPublicNostrEvent,
                  route: prepared.deliveryRoute,
                  relayPlan: prepared.relayPlan,
                },
              })
              publishPhase = "staged"
              const expiresAt = staged.lifecycle.orderRelayDelivery?.expiresAt
              if (expiresAt !== undefined) {
                rememberCheckoutOrderAttempt(
                  staged.lifecycle.orderId,
                  expiresAt
                )
              }
            },
            onRecipientPublishStarting: async (prepared) => {
              const begun = await beginDeliveryAttempt({
                orderId: dependencies.orderLifecycle!.orderId,
                buyerPubkey: buyerIdentity.pubkey,
                leaseOwner: orderDeliveryLeaseOwner,
                relayUrls: prepared.relayPlan.map(({ relayUrl }) => relayUrl),
                shouldContinue,
              })
              orderDeliveryGenerations = begun.generationsByRelay
              orderDeliveryWrapId = begun.wrapId
              publishPhase = "write_started"
            },
            onRecipientPublishAccepted: async (recipientDelivery) => {
              const persisted = await persistOrderRelayOutcomes(
                recipientDelivery,
                { ackOnly: true, releaseLease: false }
              )
              if (persisted?.orderDeliveryStatus !== "sent") {
                throw new Error(
                  "Recipient relay acceptance was not committed to the staged order."
                )
              }
            },
            onRecipientPublishSettled: async (recipientDelivery) => {
              await persistOrderRelayOutcomes(recipientDelivery, {
                ackOnly: false,
                releaseLease: true,
              })
            },
          }
        : {}),
    })
  } catch (error) {
    if (!dependencies.orderLifecycle) throw error
    throw new BuyerOrderPublishError(
      getErrorMessage(error, "Order delivery failed."),
      publishPhase,
      error
    )
  }
  const {
    selfCopyError: buyerSelfCopyError,
    deliveryRoute,
    orderRelayDelivery,
    startPostAcceptanceWork: startPrivateMessagePostAcceptanceWork,
  } = publishedMessage

  if (dependencies.orderLifecycle) {
    const committedLifecycle = acceptedLifecycle
    if (committedLifecycle?.orderDeliveryStatus !== "sent") {
      throw new BuyerOrderPublishError(
        "Recipient relay acceptance was not committed to the staged order.",
        publishPhase,
        null
      )
    }

    const stableRumor = clonePreparedBuyerRumor(rumor)
    let resolveCompanionNotification!: (
      status: OrderCompanionNotificationStatus
    ) => void
    const companionNotification = new Promise<OrderCompanionNotificationStatus>(
      (resolve) => {
        resolveCompanionNotification = resolve
      }
    )
    let postAcceptanceWork: Promise<BuyerPostAcceptanceResult> | null = null
    const startPostAcceptanceWork = () => {
      postAcceptanceWork ??= (async () => {
        let selfResult: PrivateMessagePostAcceptanceResult = {
          wrappedToSelf: null,
          selfDelivery: null,
          selfDeliveryStatus: null,
          selfCopyError: null,
        }
        if (startPrivateMessagePostAcceptanceWork) {
          try {
            selfResult = await startPrivateMessagePostAcceptanceWork()
          } catch (error) {
            selfResult = {
              wrappedToSelf: null,
              selfDelivery: null,
              selfDeliveryStatus: null,
              selfCopyError: getErrorMessage(error, "Self-copy failed"),
            }
          }
        }

        let localCacheError: string | null = null
        if (
          buyerIdentity.kind !== "guest_ephemeral" &&
          (shouldContinue?.() ?? true)
        ) {
          try {
            localCacheError = await (
              dependencies.cacheBuyerOrderRumorFn ?? cacheBuyerOrderRumor
            )(stableRumor)
          } catch (error) {
            localCacheError = getErrorMessage(
              error,
              "Failed to cache buyer order message"
            )
          }
        }

        const companionStatus = await publishOrderCompanionNotification({
          authoritativeOrder: stableRumor,
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
        resolveCompanionNotification(companionStatus)

        const backgroundResult: BuyerPostAcceptanceResult = {
          buyerSelfCopyError: selfResult.selfCopyError,
          localCacheError,
          companionNotification: companionStatus,
        }
        const deliveryNotice = getDeliveryNotice(
          {
            ...backgroundResult,
            deliveryRoute,
            companionNotification: Promise.resolve(companionStatus),
          },
          "Order"
        )
        if (deliveryNotice && (shouldContinue?.() ?? true)) {
          try {
            await patchLifecycle(committedLifecycle.orderId, {
              deliveryNotice,
            })
          } catch {
            console.warn("Failed to persist background order recovery notice")
          }
        }
        return backgroundResult
      })()
      return postAcceptanceWork
    }

    return {
      buyerSelfCopyError: null,
      localCacheError: null,
      deliveryRoute,
      companionNotification,
      startPostAcceptanceWork,
      ...(committedLifecycle.orderRelayDelivery
        ? { orderRelayDelivery: committedLifecycle.orderRelayDelivery }
        : orderRelayDelivery
          ? { orderRelayDelivery }
          : {}),
    }
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
    ...(orderRelayDelivery ? { orderRelayDelivery } : {}),
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
