import { db, type OrderLifecycle, type OrderRelayDeliveryStatus } from "../db"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import { EVENT_KINDS } from "./kinds"
import {
  filterEligibleAccountRelayUrls,
  orderEquivalentAccountRelayOperations,
  type AccountNetworkLocalStateRepository,
} from "./account-network-local-state"
import {
  GUEST_ORDER_LOCAL_RETENTION_MS,
  deriveOrderLifecyclePhase,
} from "./order-lifecycle"
import { publishSignedEventToRelay } from "./relay-publish"
import {
  isApprovedCompatibilityOrderRelayPlan,
  MAX_DECLARED_INBOX_WRITE_RELAYS,
} from "./private-message-routing"
import {
  normalizeSecureOrIsolatedE2eRelayUrls,
  tryNormalizeRelayUrl,
} from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const RETRY_DELAY_MS = 60_000
const FOREGROUND_RETRY_DELAY_MS = 15_000
export const ORDER_RELAY_DELIVERY_LEASE_MS = 30_000

export type PreparedOrderRelayDelivery = {
  rumorId: string
  signedRecipientWrap: SignedPublicNostrEvent
  route: "declared_inbox" | "compatibility_order"
  routingAuthority?: NonNullable<
    NonNullable<OrderLifecycle["orderRelayDelivery"]>["routingAuthority"]
  >
  compatibilityPlan?: NonNullable<
    NonNullable<OrderLifecycle["orderRelayDelivery"]>["compatibilityPlan"]
  >
  relayPlan: Array<{
    relayUrl: string
    source: "declared" | "recipient_nip65" | "compatibility_registry"
  }>
}

export type StagedOrderLifecycleInput = Pick<
  OrderLifecycle,
  | "orderId"
  | "claimedReferralSource"
  | "buyerPubkey"
  | "buyerIdentityKind"
  | "merchantPubkey"
  | "checkoutMode"
  | "publicZapSigner"
  | "publicZapFallback"
  | "merchantLightningAddress"
  | "paymentTarget"
  | "items"
  | "itemSubtotalSats"
  | "shippingCostSats"
  | "totalSats"
  | "totalMsats"
  | "currency"
  | "pricingQuote"
  | "zapContent"
  | "shippingAddress"
  | "contactNote"
  | "guestContact"
  | "addressValidity"
  | "shippingZoneEligibility"
  | "createdAt"
>

export type OrderRelayDeliveryStageResult = {
  lifecycle: OrderLifecycle
  inserted: boolean
}

export interface OrderRelayDeliveryRepository {
  get(orderId: string): Promise<OrderLifecycle | undefined>
  list(buyerPubkey: string): Promise<OrderLifecycle[]>
  update(
    orderId: string,
    updater: (current: OrderLifecycle) => OrderLifecycle
  ): Promise<OrderLifecycle | undefined>
  stage?(
    record: OrderLifecycle,
    assertCompatible: (current: OrderLifecycle) => void
  ): Promise<OrderRelayDeliveryStageResult>
}

export type OrderRelayDeliveryPublisher = (input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
  accountPubkey: string
  appRelayUrls?: readonly string[]
  personalRelayUrls?: readonly string[]
  independentRelayUrls?: readonly string[]
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  shouldContinue?: () => boolean
}) => Promise<OrderRelayDeliveryStatus>

export interface RetryOrderRelayDeliveryOptions {
  repository?: OrderRelayDeliveryRepository
  publisher?: OrderRelayDeliveryPublisher
  now?: () => number
  leaseOwner?: string
  accountNetworkLocalStateRepository?: Pick<
    AccountNetworkLocalStateRepository,
    "get"
  >
  /** Explicit foreground recovery may replay a same-session guest wrap. */
  allowGuest?: boolean
  /** Live account/session guard checked before every new relay write. */
  shouldContinue?: () => boolean
}

const dexieRepository: OrderRelayDeliveryRepository = {
  get: async (orderId) => db.orderLifecycles.get(orderId),
  list: async (buyerPubkey) =>
    db.orderLifecycles.where("buyerPubkey").equals(buyerPubkey).toArray(),
  update: async (orderId, updater) =>
    db.transaction("rw", db.orderLifecycles, async () => {
      const current = await db.orderLifecycles.get(orderId)
      if (!current) return undefined
      const next = updater(current)
      await db.orderLifecycles.put(next)
      return next
    }),
  stage: async (record, assertCompatible) =>
    db.transaction("rw", db.orderLifecycles, async () => {
      const current = await db.orderLifecycles.get(record.orderId)
      if (current) {
        assertCompatible(current)
        return { lifecycle: current, inserted: false }
      }
      await db.orderLifecycles.put(record)
      return { lifecycle: record, inserted: true }
    }),
}

async function defaultPublisher(
  input: Parameters<OrderRelayDeliveryPublisher>[0]
): Promise<OrderRelayDeliveryStatus> {
  return await publishSignedEventToRelay({
    signedEvent: input.signedEvent,
    relayUrl: input.relayUrl,
    authorPubkey: input.signedEvent.pubkey,
    accountPubkey: input.accountPubkey,
    appRelayUrls: input.appRelayUrls,
    personalRelayUrls: input.personalRelayUrls,
    independentRelayUrls: input.independentRelayUrls,
    accountNetworkLocalStateRepository:
      input.accountNetworkLocalStateRepository,
    shouldContinue: input.shouldContinue,
  })
}

function nextLeaseOwner(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `order-delivery-${Date.now()}-${Math.random()}`
  )
}

function hasRetryablePublicTarget(
  delivery: NonNullable<OrderLifecycle["orderRelayDelivery"]>
): boolean {
  return delivery.relayDelivery.some(
    (target) =>
      target.status !== "acked" &&
      normalizePublicWebSocketUrl(target.relayUrl) !== null
  )
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function sameValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right))
  )
}

function immutableLifecycleSnapshot(
  lifecycle: OrderLifecycle | StagedOrderLifecycleInput
): unknown {
  return {
    orderId: lifecycle.orderId,
    claimedReferralSource: lifecycle.claimedReferralSource,
    buyerPubkey: lifecycle.buyerPubkey,
    buyerIdentityKind: lifecycle.buyerIdentityKind,
    merchantPubkey: lifecycle.merchantPubkey,
    checkoutMode: lifecycle.checkoutMode,
    publicZapSigner: lifecycle.publicZapSigner,
    publicZapFallback: lifecycle.publicZapFallback,
    merchantLightningAddress: lifecycle.merchantLightningAddress,
    paymentTarget: lifecycle.paymentTarget,
    walletPaymentAttemptId:
      "walletPaymentAttemptId" in lifecycle
        ? lifecycle.walletPaymentAttemptId
        : undefined,
    items: lifecycle.items,
    itemSubtotalSats: lifecycle.itemSubtotalSats,
    shippingCostSats: lifecycle.shippingCostSats,
    totalSats: lifecycle.totalSats,
    totalMsats: lifecycle.totalMsats,
    currency: lifecycle.currency,
    pricingQuote: lifecycle.pricingQuote,
    zapContent: lifecycle.zapContent,
    shippingAddress: lifecycle.shippingAddress,
    contactNote: lifecycle.contactNote,
    guestContact: lifecycle.guestContact,
    addressValidity: lifecycle.addressValidity,
    shippingZoneEligibility: lifecycle.shippingZoneEligibility,
    createdAt: lifecycle.createdAt,
  }
}

function immutableRelayPlan(
  delivery: NonNullable<OrderLifecycle["orderRelayDelivery"]>
): unknown {
  return {
    rumorId: delivery.rumorId,
    signedRecipientWrap: delivery.signedRecipientWrap,
    route: delivery.route,
    routingAuthority: delivery.routingAuthority,
    compatibilityPlan: delivery.compatibilityPlan,
    relayPlan: delivery.relayDelivery.map(({ relayUrl, source }) => ({
      relayUrl,
      source,
    })),
  }
}

function hasValidOrderRelayRoutingAuthority(
  delivery: NonNullable<OrderLifecycle["orderRelayDelivery"]>,
  merchantPubkey: string
): boolean {
  // Records staged before routingAuthority and compatibilityPlan were stored
  // retain only their original exact relay list. Accept that historical shape
  // for bounded retry, never as authority to discover or add a new target.
  if (
    delivery.routingAuthority === undefined &&
    delivery.compatibilityPlan === undefined
  ) {
    const relayUrls = delivery.relayDelivery.map(({ relayUrl }) => relayUrl)
    const recipients = delivery.signedRecipientWrap.tags.filter(
      (tag) => tag[0] === "p" && typeof tag[1] === "string"
    )
    return (
      isValidSignedPublicNostrEvent(delivery.signedRecipientWrap) &&
      delivery.signedRecipientWrap.kind === EVENT_KINDS.GIFT_WRAP &&
      recipients.length === 1 &&
      recipients[0]![1]!.trim().toLowerCase() ===
        merchantPubkey.trim().toLowerCase() &&
      relayUrls.length > 0 &&
      relayUrls.length <= MAX_DECLARED_INBOX_WRITE_RELAYS &&
      new Set(relayUrls).size === relayUrls.length &&
      sameValue(normalizeSecureOrIsolatedE2eRelayUrls(relayUrls), relayUrls) &&
      (delivery.route === "declared_inbox"
        ? delivery.relayDelivery.every(({ source }) => source === "declared")
        : delivery.route === "compatibility_order" &&
          isApprovedCompatibilityOrderRelayPlan(relayUrls) &&
          delivery.relayDelivery.every(
            ({ source }) =>
              source === "recipient_nip65" ||
              source === "compatibility_registry"
          ))
    )
  }
  if (delivery.route === "compatibility_order") {
    const relayUrls = delivery.relayDelivery.map(({ relayUrl }) => relayUrl)
    return (
      !delivery.routingAuthority &&
      !!delivery.compatibilityPlan &&
      sameValue(delivery.compatibilityPlan.relayUrls, relayUrls) &&
      isApprovedCompatibilityOrderRelayPlan(relayUrls) &&
      delivery.relayDelivery.every(
        ({ source }) =>
          source === "recipient_nip65" || source === "compatibility_registry"
      )
    )
  }
  const authority = delivery.routingAuthority
  if (
    delivery.route !== "declared_inbox" ||
    delivery.compatibilityPlan !== undefined ||
    !authority ||
    authority.kind !== EVENT_KINDS.PRIVATE_MESSAGE_RELAYS ||
    !/^[0-9a-f]{64}$/.test(authority.eventId) ||
    !Number.isSafeInteger(authority.eventCreatedAt) ||
    authority.eventCreatedAt < 0 ||
    authority.pubkey !== merchantPubkey.trim().toLowerCase() ||
    authority.relayUrls.length === 0
  ) {
    return false
  }
  return sameValue(
    authority.relayUrls,
    delivery.relayDelivery.map(({ relayUrl }) => relayUrl)
  )
}

export class OrderRelayDeliveryStageConflictError extends Error {
  constructor() {
    super("Order delivery staging conflicts with an existing order snapshot.")
    this.name = "OrderRelayDeliveryStageConflictError"
  }
}

export async function stageOrderRelayDelivery(
  input: {
    lifecycle: StagedOrderLifecycleInput
    prepared: PreparedOrderRelayDelivery
    leaseOwner: string
  },
  options: {
    repository?: OrderRelayDeliveryRepository
    now?: () => number
  } = {}
): Promise<OrderRelayDeliveryStageResult> {
  const merchantPubkey = input.lifecycle.merchantPubkey.trim().toLowerCase()
  const authority = input.prepared.routingAuthority
  const compatibilityPlan = input.prepared.compatibilityPlan
  const declared =
    input.prepared.route === "declared_inbox" &&
    !compatibilityPlan &&
    authority?.kind === EVENT_KINDS.PRIVATE_MESSAGE_RELAYS &&
    /^[0-9a-f]{64}$/.test(authority.eventId) &&
    Number.isSafeInteger(authority.eventCreatedAt) &&
    authority.eventCreatedAt >= 0 &&
    authority.pubkey === merchantPubkey
  const compatibility =
    input.prepared.route === "compatibility_order" &&
    !authority &&
    !!compatibilityPlan &&
    isApprovedCompatibilityOrderRelayPlan(compatibilityPlan.relayUrls)
  if (
    !/^[0-9a-f]{64}$/i.test(input.prepared.rumorId) ||
    input.leaseOwner.trim().length === 0 ||
    (input.lifecycle.buyerIdentityKind !== "signed_in" &&
      input.lifecycle.buyerIdentityKind !== "guest_ephemeral") ||
    (!declared && !compatibility)
  ) {
    throw new Error(
      "Cannot stage order delivery without a validated relay plan."
    )
  }
  if (!isValidSignedPublicNostrEvent(input.prepared.signedRecipientWrap)) {
    throw new Error("Cannot stage an invalid signed recipient wrap.")
  }
  const outerRecipients = input.prepared.signedRecipientWrap.tags.filter(
    (tag) => tag[0] === "p" && typeof tag[1] === "string"
  )
  if (
    input.prepared.signedRecipientWrap.kind !== EVENT_KINDS.GIFT_WRAP ||
    outerRecipients.length !== 1 ||
    outerRecipients[0]![1]!.trim().toLowerCase() !== merchantPubkey
  ) {
    throw new Error("Cannot stage a recipient wrap outside the order scope.")
  }
  if (
    input.lifecycle.buyerIdentityKind === "guest_ephemeral" &&
    (input.lifecycle.shippingAddress !== undefined ||
      input.lifecycle.contactNote !== undefined ||
      input.lifecycle.guestContact !== undefined)
  ) {
    throw new Error("Cannot stage plaintext guest fulfillment data.")
  }

  const relayUrls = input.prepared.relayPlan.map(({ relayUrl }) => relayUrl)
  const normalizedRelayUrls = relayUrls.map((relayUrl) =>
    tryNormalizeRelayUrl(relayUrl)
  )
  const approvedRelayUrls = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(relayUrls)
  )
  if (
    relayUrls.length === 0 ||
    input.prepared.relayPlan.some(({ source }) =>
      declared
        ? source !== "declared"
        : source !== "recipient_nip65" && source !== "compatibility_registry"
    ) ||
    normalizedRelayUrls.some(
      (normalized, index) =>
        !normalized.ok ||
        normalized.url !== relayUrls[index] ||
        !approvedRelayUrls.has(normalized.url)
    ) ||
    new Set(
      normalizedRelayUrls.flatMap((normalized) =>
        normalized.ok ? [normalized.url] : []
      )
    ).size !== relayUrls.length ||
    !(declared
      ? sameValue(authority?.relayUrls, relayUrls)
      : sameValue(compatibilityPlan?.relayUrls, relayUrls))
  ) {
    throw new Error("Cannot stage an invalid order relay plan.")
  }

  const repository = options.repository ?? dexieRepository
  if (!repository.stage) {
    throw new Error("Order relay delivery repository cannot stage records.")
  }
  const timestamp = (options.now ?? Date.now)()
  const createdAt = input.lifecycle.createdAt ?? timestamp
  const delivery: NonNullable<OrderLifecycle["orderRelayDelivery"]> = {
    rumorId: input.prepared.rumorId.toLowerCase(),
    signedRecipientWrap: structuredClone(input.prepared.signedRecipientWrap),
    route: input.prepared.route,
    ...(authority ? { routingAuthority: structuredClone(authority) } : {}),
    ...(compatibilityPlan
      ? { compatibilityPlan: structuredClone(compatibilityPlan) }
      : {}),
    relayDelivery: input.prepared.relayPlan.map(({ relayUrl, source }) => ({
      relayUrl,
      source,
      status: "pending",
      attemptCount: 0,
      attemptGeneration: 0,
    })),
    deliveryAttemptCount: 0,
    deliveryAttemptGeneration: 0,
    retryCount: 0,
    deliveryLeaseOwner: input.leaseOwner,
    deliveryLeaseExpiresAt: timestamp + ORDER_RELAY_DELIVERY_LEASE_MS,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: createdAt + GUEST_ORDER_LOCAL_RETENTION_MS,
  }
  const stagedBase = {
    ...input.lifecycle,
    createdAt,
    updatedAt: timestamp,
    orderDeliveryStatus: "pending" as const,
    orderDeliveryRoute: input.prepared.route,
    orderRelayDelivery: delivery,
    checkoutRecoveryPending: true,
    invoiceStatus: "not_requested" as const,
    paymentStatus: "not_started" as const,
    proofDeliveryStatus: "not_started" as const,
    zapReceiptStatus: "not_applicable" as const,
  }
  const record: OrderLifecycle = { ...stagedBase, phase: "pending" }

  return await repository.stage(record, (current) => {
    if (
      !sameValue(
        immutableLifecycleSnapshot(current),
        immutableLifecycleSnapshot(record)
      ) ||
      !current.orderRelayDelivery ||
      !sameValue(
        immutableRelayPlan(current.orderRelayDelivery),
        immutableRelayPlan(delivery)
      )
    ) {
      throw new OrderRelayDeliveryStageConflictError()
    }
  })
}

export type BegunOrderRelayDeliveryAttempt = {
  lifecycle: OrderLifecycle
  generationsByRelay: Readonly<Record<string, number>>
  wrapId: string
}

export async function beginOrderRelayDeliveryAttempt(
  input: {
    orderId: string
    buyerPubkey: string
    leaseOwner: string
    relayUrls: readonly string[]
    shouldContinue?: () => boolean
  },
  options: {
    repository?: OrderRelayDeliveryRepository
    now?: () => number
  } = {}
): Promise<BegunOrderRelayDeliveryAttempt> {
  if (input.shouldContinue?.() === false) {
    throw new Error("Order delivery cancelled because the session changed.")
  }
  const repository = options.repository ?? dexieRepository
  const timestamp = (options.now ?? Date.now)()
  const relayUrls = [...new Set(input.relayUrls)]
  let acquired = false
  let skippedAcknowledgedTargets = false
  const generationsByRelay: Record<string, number> = {}
  const lifecycle = await repository.update(input.orderId, (current) => {
    const delivery = current.orderRelayDelivery
    const activeOtherLease =
      delivery?.deliveryLeaseOwner &&
      delivery.deliveryLeaseOwner !== input.leaseOwner &&
      (delivery.deliveryLeaseExpiresAt ?? 0) > timestamp
    if (
      !delivery ||
      !hasValidOrderRelayRoutingAuthority(delivery, current.merchantPubkey) ||
      input.shouldContinue?.() === false ||
      current.buyerPubkey !== input.buyerPubkey ||
      activeOtherLease ||
      delivery.expiresAt <= timestamp ||
      relayUrls.length === 0 ||
      relayUrls.some(
        (relayUrl) =>
          !delivery.relayDelivery.some((target) => target.relayUrl === relayUrl)
      )
    ) {
      return current
    }

    const outstandingRelayUrls = relayUrls.filter((relayUrl) =>
      delivery.relayDelivery.some(
        (target) => target.relayUrl === relayUrl && target.status !== "acked"
      )
    )
    if (outstandingRelayUrls.length === 0) {
      skippedAcknowledgedTargets = true
      return current
    }
    const outstandingRelayUrlSet = new Set(outstandingRelayUrls)

    acquired = true
    const batchGeneration = (delivery.deliveryAttemptGeneration ?? 0) + 1
    const relayDelivery = delivery.relayDelivery.map((target) => {
      if (
        !outstandingRelayUrlSet.has(target.relayUrl) ||
        target.status === "acked"
      ) {
        return target
      }
      const targetGeneration = (target.attemptGeneration ?? 0) + 1
      generationsByRelay[target.relayUrl] = targetGeneration
      const rest = { ...target }
      delete rest.acknowledgedAt
      delete rest.rejectedAt
      delete rest.timedOutAt
      return {
        ...rest,
        status: "pending" as const,
        attemptCount: target.attemptCount + 1,
        attemptGeneration: targetGeneration,
        lastAttemptAt: timestamp,
      }
    })
    return {
      ...current,
      orderDeliveryStatus:
        current.orderDeliveryStatus === "sent" ? "sent" : "pending",
      orderRelayDelivery: {
        ...delivery,
        relayDelivery,
        deliveryAttemptCount: delivery.deliveryAttemptCount + 1,
        deliveryAttemptGeneration: batchGeneration,
        deliveryLeaseOwner: input.leaseOwner,
        deliveryLeaseExpiresAt: timestamp + ORDER_RELAY_DELIVERY_LEASE_MS,
        nextRetryAt: undefined,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    }
  })

  if (
    !lifecycle?.orderRelayDelivery ||
    (!acquired && !skippedAcknowledgedTargets)
  ) {
    throw new Error(
      "Order delivery attempt could not acquire its staged relay plan."
    )
  }
  return {
    lifecycle,
    generationsByRelay,
    wrapId: lifecycle.orderRelayDelivery.signedRecipientWrap.id,
  }
}

export async function recordOrderRelayDeliveryOutcomes(
  input: {
    orderId: string
    buyerPubkey: string
    leaseOwner: string
    wrapId: string
    outcomes: ReadonlyArray<{
      relayUrl: string
      status: Exclude<OrderRelayDeliveryStatus, "pending">
      generation: number
    }>
    releaseLease?: boolean
    retryDelayMs?: number
  },
  options: {
    repository?: OrderRelayDeliveryRepository
    now?: () => number
  } = {}
): Promise<OrderLifecycle | undefined> {
  const repository = options.repository ?? dexieRepository
  const timestamp = (options.now ?? Date.now)()
  return await repository.update(input.orderId, (current) => {
    const delivery = current.orderRelayDelivery
    if (
      !delivery ||
      !hasValidOrderRelayRoutingAuthority(delivery, current.merchantPubkey) ||
      current.buyerPubkey !== input.buyerPubkey ||
      delivery.signedRecipientWrap.id !== input.wrapId
    ) {
      return current
    }
    const outcomes = new Map<string, (typeof input.outcomes)[number]>()
    for (const outcome of input.outcomes) {
      const currentOutcome = outcomes.get(outcome.relayUrl)
      if (currentOutcome?.status === "acked") continue
      if (!currentOutcome || outcome.status === "acked") {
        outcomes.set(outcome.relayUrl, outcome)
      }
    }
    const relayDelivery = delivery.relayDelivery.map((target) => {
      const outcome = outcomes.get(target.relayUrl)
      if (!outcome || target.status === "acked") return target
      const latestGeneration = target.attemptGeneration ?? 0
      if (
        target.attemptCount <= 0 ||
        !Number.isSafeInteger(outcome.generation) ||
        outcome.generation <= 0 ||
        outcome.generation > latestGeneration ||
        (outcome.status !== "acked" &&
          (outcome.generation !== latestGeneration ||
            delivery.deliveryLeaseOwner !== input.leaseOwner))
      ) {
        return target
      }
      return {
        ...target,
        status: outcome.status,
        ...(outcome.status === "acked" ? { acknowledgedAt: timestamp } : {}),
        ...(outcome.status === "rejected" ? { rejectedAt: timestamp } : {}),
        ...(outcome.status === "timed_out" ? { timedOutAt: timestamp } : {}),
      }
    })
    const anyAcked = relayDelivery.some((target) => target.status === "acked")
    const allAcked = relayDelivery.every((target) => target.status === "acked")
    let nextDelivery = {
      ...delivery,
      relayDelivery,
      nextRetryAt: allAcked
        ? undefined
        : timestamp + (input.retryDelayMs ?? FOREGROUND_RETRY_DELAY_MS),
      updatedAt: timestamp,
    }
    if (
      input.releaseLease &&
      nextDelivery.deliveryLeaseOwner === input.leaseOwner
    ) {
      const released = { ...nextDelivery }
      delete released.deliveryLeaseOwner
      delete released.deliveryLeaseExpiresAt
      nextDelivery = released
    }
    const next = {
      ...current,
      orderDeliveryStatus: anyAcked ? ("sent" as const) : ("pending" as const),
      // Relay acceptance commits delivery, not checkout completion. The
      // caller clears this fence only after cart or payment recovery finishes.
      checkoutRecoveryPending: current.checkoutRecoveryPending,
      orderRelayDelivery: nextDelivery,
      updatedAt: timestamp,
    }
    return { ...next, phase: deriveOrderLifecyclePhase(next) }
  })
}

export async function retryOrderRelayDelivery(
  orderId: string,
  activeBuyerPubkey: string,
  options: RetryOrderRelayDeliveryOptions = {}
): Promise<OrderLifecycle | undefined> {
  const repository = options.repository ?? dexieRepository
  const publisher = options.publisher ?? defaultPublisher
  const now = options.now ?? Date.now
  const leaseOwner = options.leaseOwner ?? nextLeaseOwner()
  const timestamp = now()

  if (options.shouldContinue?.() === false) {
    return await repository.get(orderId)
  }

  const claimed = await repository.update(orderId, (current) => {
    const delivery = current.orderRelayDelivery
    if (
      !delivery ||
      !hasValidOrderRelayRoutingAuthority(delivery, current.merchantPubkey) ||
      (current.buyerIdentityKind === "guest_ephemeral" &&
        !options.allowGuest) ||
      current.buyerPubkey !== activeBuyerPubkey ||
      delivery.expiresAt <= timestamp ||
      !hasRetryablePublicTarget(delivery) ||
      (delivery.deliveryLeaseOwner &&
        delivery.deliveryLeaseOwner !== leaseOwner &&
        (delivery.deliveryLeaseExpiresAt ?? 0) > timestamp)
    ) {
      return current
    }
    return {
      ...current,
      orderRelayDelivery: {
        ...delivery,
        deliveryLeaseOwner: leaseOwner,
        deliveryLeaseExpiresAt: timestamp + ORDER_RELAY_DELIVERY_LEASE_MS,
        retryCount: delivery.retryCount + 1,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    }
  })

  if (
    !claimed?.orderRelayDelivery ||
    claimed.orderRelayDelivery.deliveryLeaseOwner !== leaseOwner
  ) {
    return claimed
  }

  try {
    const signedEvent = claimed.orderRelayDelivery.signedRecipientWrap
    const outstanding = claimed.orderRelayDelivery.relayDelivery.filter(
      (target) =>
        target.status !== "acked" &&
        normalizePublicWebSocketUrl(target.relayUrl) !== null
    )
    const orderedOutstanding = await orderEquivalentAccountRelayOperations({
      accountPubkey: claimed.buyerPubkey,
      operations: outstanding.map((target) => ({
        relayUrl: target.relayUrl,
        equivalenceKey: "exact-order-delivery-retry",
        value: target,
      })),
      repository: options.accountNetworkLocalStateRepository,
    })

    for (const { value: target } of orderedOutstanding) {
      if (options.shouldContinue?.() === false) break
      const appRelayUrls =
        claimed.orderRelayDelivery.route === "compatibility_order"
          ? [target.relayUrl]
          : []
      const independentRelayUrls =
        claimed.orderRelayDelivery.route === "declared_inbox"
          ? [target.relayUrl]
          : []
      const eligibleRelayUrls = await filterEligibleAccountRelayUrls({
        accountPubkey: claimed.buyerPubkey,
        candidateRelayUrls: [target.relayUrl],
        appRelayUrls,
        personalRelayUrls: [],
        independentRelayUrls,
        repository: options.accountNetworkLocalStateRepository,
      })
      if (options.shouldContinue?.() === false) break
      if (eligibleRelayUrls.length === 0) continue

      const begun = await beginOrderRelayDeliveryAttempt(
        {
          orderId,
          buyerPubkey: claimed.buyerPubkey,
          leaseOwner,
          relayUrls: [target.relayUrl],
          shouldContinue: options.shouldContinue,
        },
        { repository, now }
      )
      const generation = begun.generationsByRelay[target.relayUrl]
      if (generation === undefined) continue
      if (options.shouldContinue?.() === false) break

      let outcome: OrderRelayDeliveryStatus
      try {
        outcome = await publisher({
          relayUrl: target.relayUrl,
          signedEvent,
          accountPubkey: claimed.buyerPubkey,
          appRelayUrls,
          personalRelayUrls: [],
          independentRelayUrls,
          accountNetworkLocalStateRepository:
            options.accountNetworkLocalStateRepository,
          shouldContinue: options.shouldContinue,
        })
      } catch {
        if (options.shouldContinue?.() === false) break
        outcome = "timed_out"
      }
      if (outcome === "pending") outcome = "timed_out"

      await recordOrderRelayDeliveryOutcomes(
        {
          orderId,
          buyerPubkey: claimed.buyerPubkey,
          leaseOwner,
          wrapId: begun.wrapId,
          outcomes: [
            {
              relayUrl: target.relayUrl,
              status: outcome,
              generation,
            },
          ],
          retryDelayMs: RETRY_DELAY_MS,
        },
        { repository, now }
      )
    }
  } finally {
    await repository.update(orderId, (current) => {
      const delivery = current.orderRelayDelivery
      if (!delivery || delivery.deliveryLeaseOwner !== leaseOwner)
        return current
      const released = { ...delivery }
      delete released.deliveryLeaseOwner
      delete released.deliveryLeaseExpiresAt
      if (
        released.nextRetryAt === undefined &&
        released.relayDelivery.some((target) => target.status !== "acked")
      ) {
        released.nextRetryAt = now() + RETRY_DELAY_MS
      }
      return { ...current, orderRelayDelivery: released, updatedAt: now() }
    })
  }

  return await repository.get(orderId)
}

export async function resumePendingOrderRelayDeliveries(
  activeBuyerPubkey: string,
  options: RetryOrderRelayDeliveryOptions = {}
): Promise<void> {
  const repository = options.repository ?? dexieRepository
  const now = options.now ?? Date.now
  const timestamp = now()
  const lifecycles = await repository.list(activeBuyerPubkey)
  for (const lifecycle of lifecycles) {
    const delivery = lifecycle.orderRelayDelivery
    if (
      !delivery ||
      lifecycle.buyerIdentityKind === "guest_ephemeral" ||
      !hasValidOrderRelayRoutingAuthority(delivery, lifecycle.merchantPubkey) ||
      delivery.expiresAt <= timestamp ||
      (delivery.nextRetryAt ?? 0) > timestamp ||
      !hasRetryablePublicTarget(delivery)
    ) {
      continue
    }
    await retryOrderRelayDelivery(lifecycle.orderId, activeBuyerPubkey, {
      ...options,
      repository,
    }).catch(() => {
      // The exact encrypted wrap and per-relay state remain available for a
      // later bounded retry. One failed order must not starve other retries.
    })
  }
}
