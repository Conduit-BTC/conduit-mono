import {
  assertCheckoutSparkLnurlPayoutMetadata,
  assertCheckoutSparkSignedCommerceAllocations,
  calculateCheckoutSparkSettledGrossFundingSats,
  canonicalizeCheckoutSparkPlanSourceEvents,
  createCheckoutSparkSettledReconciliation,
  freezeCheckoutSparkCommerceQuote,
  freezeCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledReconciliation,
  snapshotCheckoutSparkPlanSourceEvents,
  projectProfileContent,
  resolveCheckoutSparkSignedPickup,
  DexieCheckoutSparkSettledRepository,
  type CheckoutSparkNetwork,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledRecipientInput,
  type CheckoutSparkSettledReconciliation,
  type SignedPublicNostrEvent,
  type fetchLnurlPayMetadata,
} from "@conduit/core"

import { buildCheckoutSparkCommerceEvidence } from "./checkout-spark-commerce-evidence"
import { isCurrentGuestOrderSigningIdentity } from "./guest-order-identity"
import { assertMarketCheckoutSparkDispatchPlan } from "./checkout-spark-dispatch-policy"
import { acquireCheckoutSparkWalletRetentionLock } from "./checkout-spark-wallet-retention-lock"
import type { CheckoutSparkQuoteAuthority } from "./checkout-spark-quote-authority"
import {
  getCheckoutSparkRecoveryDelivery,
  publishCheckoutSparkSettledRecoveryHandoff,
  type CheckoutSparkRecoverySigningIdentity,
} from "./checkout-spark-recovery-handoff"
import { generateSparkMnemonic } from "./spark-recovery"
import type { SparkRecoveryBundle } from "./spark-recovery-bundle"
import {
  getDefaultSparkAccountNumber,
  getSparkConfiguration,
  getSparkWalletManager,
} from "./spark-sdk"
import type {
  SparkCheckoutReceiveInput,
  SparkCheckoutReceiveRequest,
} from "./spark-wallet"

const STORAGE_KEY = "conduit:checkout-spark-settled-preparations:v3"
const MAX_STORED = 64
const HEX_64 = /^[0-9a-f]{64}$/

export type CheckoutSparkSettledPreparationStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>

export interface StoredCheckoutSparkSettledPreparation {
  schemaVersion: 3
  checkoutId: string
  planDigest: string
  /** SHA-256 of the exact cart batches that started this checkout. */
  purchaseClaimDigest?: string
  recoveryHandoffId: string | null
  fundingInvoiceExposedAt: number | null
  fundingSubmissionState: "not_started" | "provisional"
  /** Possible external payment; immutable once its invoice can leave the app. */
  externalFundingExposedAt?: number
  savedAt: number
}

export interface CheckoutSparkSettledWalletMaterial extends SparkRecoveryBundle {
  walletId: string
  network: CheckoutSparkNetwork
}

export interface PrepareCheckoutSparkSettledFundingInput {
  checkoutId: string
  orderId: string
  purchaseClaimDigest?: string
  merchantPubkey: string
  network: CheckoutSparkNetwork
  takeoverAt: number
  grossFundingSats: number
  fundingExpirySecs: number
  identity: CheckoutSparkRecoverySigningIdentity
  shouldContinue?: () => boolean
  quoteAuthority: CheckoutSparkQuoteAuthority
  sourceEvents: readonly SignedPublicNostrEvent[]
  recipients: readonly CheckoutSparkSettledRecipientInput[]
  storage?: CheckoutSparkSettledPreparationStorage | null
  recoveryStorage?: CheckoutSparkSettledPreparationStorage | null
}

export interface PreparedCheckoutSparkSettledFunding {
  readonly plan: CheckoutSparkSettledPlan
  readonly state: CheckoutSparkSettledReconciliation
  readonly fundingReceive: Readonly<SparkCheckoutReceiveRequest>
  readonly fundingInvoice: string
  readonly recoveryHandoffId: string
}

/** Metadata failed before any checkout wallet, invoice or recovery existed. */
export class CheckoutSparkSettledFundingMetadataPreflightError extends Error {
  constructor() {
    super(
      "Checkout Spark recipient payment endpoint is not ready. No checkout wallet was created."
    )
    this.name = "CheckoutSparkSettledFundingMetadataPreflightError"
  }
}

export interface CheckoutSparkSettledPreparationRepository {
  create: DexieCheckoutSparkSettledRepository["create"]
  load: DexieCheckoutSparkSettledRepository["load"]
}

export interface PrepareCheckoutSparkSettledFundingDependencies {
  now?: () => number
  fetchPayoutMetadata?: typeof fetchLnurlPayMetadata
  repository?: CheckoutSparkSettledPreparationRepository
  createWalletMaterial?: (
    network: CheckoutSparkNetwork
  ) => CheckoutSparkSettledWalletMaterial
  openWallet?: (wallet: CheckoutSparkSettledWalletMaterial) => Promise<void>
  closeWallet?: (walletId: string) => Promise<void>
  createFundingReceive?: (
    wallet: CheckoutSparkSettledWalletMaterial,
    input: SparkCheckoutReceiveInput
  ) => Promise<SparkCheckoutReceiveRequest>
  publishRecoveryHandoff?: typeof publishCheckoutSparkSettledRecoveryHandoff
  verifyRecoveryAck?: (
    handoffId: string,
    plan: CheckoutSparkSettledPlan,
    storage: CheckoutSparkSettledPreparationStorage | null
  ) => boolean
}

function browserStorage(): CheckoutSparkSettledPreparationStorage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function requireStorage(
  storage: CheckoutSparkSettledPreparationStorage | null
): CheckoutSparkSettledPreparationStorage {
  if (!storage) {
    throw new Error(
      "Durable settled checkout preparation storage is unavailable."
    )
  }
  return storage
}

function parseStored(value: unknown): StoredCheckoutSparkSettledPreparation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored settled checkout preparation is invalid.")
  }
  const item = value as Partial<StoredCheckoutSparkSettledPreparation>
  if (
    item.schemaVersion !== 3 ||
    typeof item.checkoutId !== "string" ||
    !item.checkoutId ||
    item.checkoutId.trim() !== item.checkoutId ||
    item.checkoutId.length > 512 ||
    typeof item.planDigest !== "string" ||
    !HEX_64.test(item.planDigest) ||
    (item.purchaseClaimDigest !== undefined &&
      (typeof item.purchaseClaimDigest !== "string" ||
        !HEX_64.test(item.purchaseClaimDigest))) ||
    (item.recoveryHandoffId !== null &&
      (typeof item.recoveryHandoffId !== "string" ||
        !item.recoveryHandoffId ||
        item.recoveryHandoffId.length > 256)) ||
    (item.fundingInvoiceExposedAt !== null &&
      (!Number.isSafeInteger(item.fundingInvoiceExposedAt) ||
        item.fundingInvoiceExposedAt! < 0 ||
        item.recoveryHandoffId === null)) ||
    (item.fundingSubmissionState !== "not_started" &&
      item.fundingSubmissionState !== "provisional") ||
    (item.externalFundingExposedAt !== undefined &&
      (!Number.isSafeInteger(item.externalFundingExposedAt) ||
        item.fundingSubmissionState !== "provisional" ||
        item.fundingInvoiceExposedAt === null ||
        item.externalFundingExposedAt < item.fundingInvoiceExposedAt! ||
        item.externalFundingExposedAt > item.savedAt!)) ||
    !Number.isSafeInteger(item.savedAt) ||
    item.savedAt! < 0
  ) {
    throw new Error("Stored settled checkout preparation is invalid.")
  }
  return item as StoredCheckoutSparkSettledPreparation
}

function readStored(
  storage: CheckoutSparkSettledPreparationStorage | null
): StoredCheckoutSparkSettledPreparation[] {
  const raw = requireStorage(storage).getItem(STORAGE_KEY)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Stored settled checkout preparations are invalid.")
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_STORED) {
    throw new Error("Stored settled checkout preparations are invalid.")
  }
  const items = parsed.map(parseStored)
  if (new Set(items.map((item) => item.checkoutId)).size !== items.length) {
    throw new Error("Stored settled checkout preparations are duplicated.")
  }
  return items
}

function writeStored(
  items: readonly StoredCheckoutSparkSettledPreparation[],
  storage: CheckoutSparkSettledPreparationStorage | null
): void {
  if (items.length > MAX_STORED) {
    throw new Error("Stored settled checkout preparation limit reached.")
  }
  requireStorage(storage).setItem(STORAGE_KEY, JSON.stringify(items))
}

export function getCheckoutSparkSettledPreparation(
  checkoutId: string,
  storage: CheckoutSparkSettledPreparationStorage | null = browserStorage()
): StoredCheckoutSparkSettledPreparation | null {
  return (
    readStored(storage).find((item) => item.checkoutId === checkoutId) ?? null
  )
}

export function listCheckoutSparkSettledPreparations(
  storage: CheckoutSparkSettledPreparationStorage | null = browserStorage()
): StoredCheckoutSparkSettledPreparation[] {
  return readStored(storage)
}

export function saveCheckoutSparkSettledPreparation(
  item: StoredCheckoutSparkSettledPreparation,
  storage: CheckoutSparkSettledPreparationStorage | null = browserStorage(),
  options: { allowDefinitePreSendReset?: boolean } = {}
): StoredCheckoutSparkSettledPreparation {
  const next = parseStored(item)
  const items = readStored(storage)
  const index = items.findIndex(
    (candidate) => candidate.checkoutId === next.checkoutId
  )
  const previous = items[index]
  if (
    previous &&
    (previous.planDigest !== next.planDigest ||
      previous.purchaseClaimDigest !== next.purchaseClaimDigest ||
      (previous.recoveryHandoffId !== null &&
        previous.recoveryHandoffId !== next.recoveryHandoffId) ||
      (previous.fundingInvoiceExposedAt !== null &&
        previous.fundingInvoiceExposedAt !== next.fundingInvoiceExposedAt) ||
      (previous.externalFundingExposedAt !== undefined &&
        previous.externalFundingExposedAt !== next.externalFundingExposedAt) ||
      (previous.fundingSubmissionState === "provisional" &&
        previous.externalFundingExposedAt === undefined &&
        next.externalFundingExposedAt !== undefined) ||
      (previous.fundingSubmissionState === "provisional" &&
        next.fundingSubmissionState !== "provisional" &&
        !options.allowDefinitePreSendReset) ||
      next.savedAt < previous.savedAt)
  ) {
    throw new Error("Settled checkout preparation conflicts with prior state.")
  }
  if (index < 0) items.push(next)
  else items[index] = next
  writeStored(items, storage)
  const readback = getCheckoutSparkSettledPreparation(next.checkoutId, storage)
  if (!readback || JSON.stringify(readback) !== JSON.stringify(next)) {
    throw new Error("Settled checkout preparation was not durably saved.")
  }
  return readback
}

function createWalletMaterial(
  network: CheckoutSparkNetwork
): CheckoutSparkSettledWalletMaterial {
  const configuration = getSparkConfiguration()
  if (configuration.status !== "ready" || configuration.network !== network) {
    throw new Error("Spark is unavailable for this checkout network.")
  }
  if (!globalThis.crypto?.randomUUID) {
    throw new Error("Secure checkout wallet generation is unavailable.")
  }
  return {
    walletId: globalThis.crypto.randomUUID(),
    mnemonic: generateSparkMnemonic(),
    accountNumber: getDefaultSparkAccountNumber(network),
    network,
  }
}

function requireSparkManager() {
  const manager = getSparkWalletManager()
  if (!manager) throw new Error("Spark is unavailable in this Market build.")
  return manager
}

function recoveryAcked(
  handoffId: string,
  plan: CheckoutSparkSettledPlan,
  storage: CheckoutSparkSettledPreparationStorage | null
): boolean {
  const delivery = getCheckoutSparkRecoveryDelivery(handoffId, storage)
  return Boolean(
    delivery &&
    delivery.record.checkoutId === plan.checkoutId &&
    delivery.record.orderId === plan.orderId &&
    delivery.record.planDigest === plan.planDigest &&
    delivery.record.walletId === plan.walletId &&
    delivery.record.merchantPubkey === plan.merchantPubkey &&
    delivery.deliveryProgress.acknowledgedRelayRefs.length > 0
  )
}

export async function prepareCheckoutSparkSettledFunding(
  input: PrepareCheckoutSparkSettledFundingInput,
  dependencies: PrepareCheckoutSparkSettledFundingDependencies = {}
): Promise<PreparedCheckoutSparkSettledFunding> {
  const {
    checkoutId,
    orderId,
    merchantPubkey,
    network,
    takeoverAt,
    grossFundingSats,
    fundingExpirySecs,
    shouldContinue: callerShouldContinue,
  } = input
  const now = dependencies.now ?? Date.now
  const fetchPayoutMetadata = dependencies.fetchPayoutMetadata
  const identity = { ...input.identity }
  const shouldContinue = () =>
    (callerShouldContinue?.() ?? true) &&
    (identity.kind !== "guest_ephemeral" ||
      (typeof callerShouldContinue === "function" &&
        isCurrentGuestOrderSigningIdentity(
          identity,
          {
            orderId,
            merchantPubkey,
          },
          now()
        )))
  const assertCurrent = () => {
    if (!shouldContinue())
      throw new Error("Checkout Spark buyer session changed.")
  }
  assertCurrent()
  // Detach the complete public evidence before any wallet or storage await.
  // It is never rebuilt from display/cache fields or fetched a second time.
  const sourceEvents = snapshotCheckoutSparkPlanSourceEvents(input.sourceEvents)
  const quoteAuthority = structuredClone(input.quoteAuthority)
  const recipients = structuredClone(input.recipients)
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const recoveryStorage =
    input.recoveryStorage === undefined
      ? browserStorage()
      : input.recoveryStorage
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const makeWallet = dependencies.createWalletMaterial ?? createWalletMaterial
  const openWallet =
    dependencies.openWallet ??
    ((wallet: CheckoutSparkSettledWalletMaterial) =>
      requireSparkManager().openWithMnemonic(wallet))
  const closeWallet =
    dependencies.closeWallet ??
    ((walletId: string) => requireSparkManager().close(walletId))
  const createReceive =
    dependencies.createFundingReceive ??
    ((
      wallet: CheckoutSparkSettledWalletMaterial,
      request: SparkCheckoutReceiveInput
    ) => requireSparkManager().createCheckoutReceive(wallet.walletId, request))
  const publishRecovery =
    dependencies.publishRecoveryHandoff ??
    publishCheckoutSparkSettledRecoveryHandoff
  const verifyAck = dependencies.verifyRecoveryAck ?? recoveryAcked

  const preparedAt = now()
  if (
    !Number.isSafeInteger(preparedAt) ||
    preparedAt < 0 ||
    !Number.isSafeInteger(fundingExpirySecs) ||
    fundingExpirySecs <= 0 ||
    !Number.isSafeInteger(grossFundingSats) ||
    grossFundingSats <= 0 ||
    !Number.isSafeInteger(grossFundingSats * 1_000)
  ) {
    throw new Error("Settled checkout funding terms are invalid.")
  }
  // A pre-existing checkout cannot be given a second wallet or invoice.
  const assertUnprepared = () => {
    if (getCheckoutSparkSettledPreparation(checkoutId, storage)) {
      throw new Error("Settled checkout funding is already prepared.")
    }
  }
  assertUnprepared()
  const commerceQuote = freezeCheckoutSparkCommerceQuote(
    buildCheckoutSparkCommerceEvidence(quoteAuthority),
    merchantPubkey
  )
  if (
    grossFundingSats !==
    calculateCheckoutSparkSettledGrossFundingSats(
      commerceQuote.commerceTotalSats
    )
  ) {
    throw new Error("Settled checkout gross funding differs from frozen terms.")
  }
  if (recipients.some((recipient) => recipient.kind === "organizer")) {
    throw new Error(
      "Settled checkout organizer allocation is not yet supported."
    )
  }
  assertCheckoutSparkSignedCommerceAllocations({
    quote: commerceQuote,
    products: quoteAuthority.products,
    shippingEvents: sourceEvents.filter((event) => event.kind === 30_406),
    pickupSourceEvents: sourceEvents,
    acceptedAtMs: preparedAt,
    merchantPubkey,
    commerce: recipients
      .filter(
        (
          recipient
        ): recipient is CheckoutSparkSettledRecipientInput & {
          kind: "merchant" | "supplier"
        } => recipient.kind === "merchant" || recipient.kind === "supplier"
      )
      .map((recipient) => ({
        kind: recipient.kind,
        recipientId: recipient.recipientId,
        amountSats: recipient.weightSats,
      })),
  })

  const sourcesById = new Map(sourceEvents.map((event) => [event.id, event]))
  const expectedSourceIds = new Set<string>()
  function unavailableSources(): never {
    throw new Error(
      "Settled checkout requires its complete signed source events."
    )
  }
  for (const line of commerceQuote.lines) {
    const event = sourcesById.get(line.productEventId)
    if (
      !event ||
      event.kind !== 30_402 ||
      event.pubkey !== line.merchantPubkey ||
      event.created_at > Math.floor(preparedAt / 1_000)
    )
      unavailableSources()
    expectedSourceIds.add(line.productEventId)
    if (line.shippingOption) {
      const shippingEvent = sourcesById.get(line.shippingOption.eventId)
      if (
        !shippingEvent ||
        shippingEvent.kind !== 30_406 ||
        shippingEvent.pubkey !==
          (line.pickup
            ? line.shippingOption.coordinate.split(":")[1]
            : line.merchantPubkey) ||
        shippingEvent.created_at > Math.floor(preparedAt / 1_000)
      )
        unavailableSources()
      expectedSourceIds.add(line.shippingOption.eventId)
    }
    if (line.pickup) {
      const pickup = resolveCheckoutSparkSignedPickup({
        productEvent: event,
        line,
        sourceEvents,
        acceptedAtMs: preparedAt,
      })
      if (
        pickup?.handoffMode !== "merchant_handoff" ||
        pickup.handlerPubkey !== merchantPubkey
      )
        unavailableSources()
      // The complete graph was independently verified by signed allocation
      // above. Retain precisely those revisions, not latest replacements.
      expectedSourceIds.add(line.pickup.calendar.eventId)
      expectedSourceIds.add(line.pickup.collection.eventId)
    }
  }
  for (const recipient of recipients) {
    if (recipient.kind === "conduit") continue
    const source = recipient.destination.source
    if (source.type !== "signed_profile") unavailableSources()
    const event = sourcesById.get(source.profileEventId)
    if (
      !event ||
      event.kind !== 0 ||
      event.pubkey !== recipient.recipientId ||
      event.created_at !== source.profileEventCreatedAt ||
      event.created_at > Math.floor(preparedAt / 1_000) ||
      projectProfileContent(event.pubkey, event.content).lud16?.trim() !==
        recipient.destination.value
    )
      unavailableSources()
    expectedSourceIds.add(source.profileEventId)
  }
  if (expectedSourceIds.size !== sourcesById.size) unavailableSources()

  // Metadata is only an endpoint/range observation. It cannot prove the
  // eventual allocation, invoice network or fees; those remain post-credit.
  const payoutDestinations = new Set(
    recipients
      .filter(
        (recipient) =>
          recipient.kind === "merchant" || recipient.kind === "supplier"
      )
      .map((recipient) => recipient.destination.value)
  )
  for (const lud16 of payoutDestinations) {
    assertCurrent()
    try {
      await assertCheckoutSparkLnurlPayoutMetadata(
        { lud16, maximumAllocationSats: grossFundingSats, shouldContinue },
        { fetchMetadata: fetchPayoutMetadata }
      )
    } catch {
      assertCurrent()
      throw new CheckoutSparkSettledFundingMetadataPreflightError()
    }
    assertCurrent()
  }
  assertUnprepared()
  // Registry reloads may run while the wallet exists but its plan has not yet
  // reached local storage. Acquire before generation, then recheck a competing
  // preparation that may have completed while metadata or this lock was pending.
  const releaseRetentionLock = await acquireCheckoutSparkWalletRetentionLock()
  let wallet: CheckoutSparkSettledWalletMaterial | null = null
  let handoffPersisted = false
  try {
    assertCurrent()
    assertUnprepared()
    wallet = makeWallet(network)
    if (wallet.network !== network) {
      throw new Error("Settled checkout wallet network is invalid.")
    }
    await openWallet(wallet)
    assertCurrent()
    const receive = await createReceive(wallet, {
      description: "Conduit checkout funding",
      requiredNetSats: grossFundingSats,
      grossFundingSats,
      expirySecs: fundingExpirySecs,
      receiveMode: "ordinary_settled_v3",
    })
    assertCurrent()
    if (
      receive.walletId !== wallet.walletId ||
      receive.network !== wallet.network ||
      receive.receiveSettledPolicy !== "ordinary-exact-credit-v3" ||
      !/^(02|03)[0-9a-f]{64}$/.test(receive.receiverIdentityPublicKey ?? "") ||
      receive.receiveQuotePolicy !== undefined ||
      receive.receiveCanaryPolicy !== undefined ||
      receive.requiredNetSats !== grossFundingSats ||
      receive.grossFundingSats !== grossFundingSats ||
      receive.expirySecs !== fundingExpirySecs
    ) {
      throw new Error(
        "Settled checkout receive does not match its invoice terms."
      )
    }
    const plan = freezeCheckoutSparkSettledPlan({
      checkoutId,
      orderId,
      merchantPubkey,
      walletId: wallet.walletId,
      network,
      createdAt: receive.createdAt,
      takeoverAt,
      commerceQuote,
      funding: {
        requestId: receive.id,
        paymentRequest: receive.paymentRequest,
        paymentHash: receive.paymentHash,
        grossFundingSats: receive.grossFundingSats,
        receiverIdentityPublicKey: receive.receiverIdentityPublicKey!,
        createdAt: receive.createdAt,
        expiresAt: receive.expiresAt,
      },
      recipients,
    })
    const canonicalSources = canonicalizeCheckoutSparkPlanSourceEvents(
      plan,
      sourceEvents
    )
    const snapshot = await repository.create(plan)
    assertCurrent()
    if (
      snapshot.status !== "active" ||
      snapshot.state.plan.planDigest !== plan.planDigest ||
      snapshot.state.credit !== null
    ) {
      throw new Error("Settled checkout plan was not durably recorded.")
    }
    const initial = saveCheckoutSparkSettledPreparation(
      {
        schemaVersion: 3,
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        purchaseClaimDigest: input.purchaseClaimDigest,
        recoveryHandoffId: null,
        fundingInvoiceExposedAt: null,
        fundingSubmissionState: "not_started",
        savedAt: now(),
      },
      storage
    )
    const handoff = await publishRecovery({
      state: createCheckoutSparkSettledReconciliation(plan),
      recovery: wallet,
      identity,
      sourceEvents: canonicalSources,
      preparedAt: now(),
      storage: recoveryStorage,
      transport: { shouldContinue },
      onPersisted: (handoffId) => {
        handoffPersisted = true
        saveCheckoutSparkSettledPreparation(
          {
            ...initial,
            recoveryHandoffId: handoffId,
            savedAt: now(),
          },
          storage
        )
      },
    })
    assertCurrent()
    const persisted = getCheckoutSparkSettledPreparation(
      plan.checkoutId,
      storage
    )
    const exposedAt = now()
    if (
      !handoff.canExposeFundingInvoice ||
      !persisted ||
      persisted.recoveryHandoffId !== handoff.handoffId ||
      !verifyAck(handoff.handoffId, plan, recoveryStorage) ||
      !Number.isSafeInteger(exposedAt) ||
      exposedAt < plan.createdAt ||
      exposedAt >= plan.funding.expiresAt ||
      exposedAt >= plan.takeoverAt
    ) {
      throw new Error(
        "Settled checkout recovery is not ready to expose funding."
      )
    }
    // Recovery publication can outlive a scheduled event. Historical plan
    // validity must not authorize first invoice exposure after ordering ends.
    for (const line of plan.commerceQuote.lines) {
      if (!line.pickup) continue
      resolveCheckoutSparkSignedPickup({
        productEvent: sourcesById.get(line.productEventId)!,
        line,
        sourceEvents: canonicalSources,
        acceptedAtMs: exposedAt,
      })
    }
    saveCheckoutSparkSettledPreparation(
      { ...persisted, fundingInvoiceExposedAt: exposedAt, savedAt: exposedAt },
      storage
    )
    return {
      plan,
      state: restoreCheckoutSparkSettledReconciliation(snapshot.state),
      fundingReceive: Object.freeze({ ...receive }),
      fundingInvoice: plan.funding.paymentRequest,
      recoveryHandoffId: handoff.handoffId,
    }
  } catch (error) {
    if (wallet && !handoffPersisted) {
      try {
        await closeWallet(wallet.walletId)
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Settled checkout preparation failed and its unfunded wallet could not be closed.",
          { cause: closeError }
        )
      }
    }
    throw error
  } finally {
    releaseRetentionLock()
  }
}

export async function loadAuthorizedCheckoutSparkSettledFunding(
  checkoutId: string,
  options: {
    storage?: CheckoutSparkSettledPreparationStorage | null
    recoveryStorage?: CheckoutSparkSettledPreparationStorage | null
    repository?: CheckoutSparkSettledPreparationRepository
    now?: () => number
    expectedBuyerPubkey?: string
  } = {}
): Promise<PreparedCheckoutSparkSettledFunding> {
  const storage =
    options.storage === undefined ? browserStorage() : options.storage
  const recoveryStorage =
    options.recoveryStorage === undefined
      ? browserStorage()
      : options.recoveryStorage
  const stored = getCheckoutSparkSettledPreparation(checkoutId, storage)
  if (
    !stored ||
    !stored.recoveryHandoffId ||
    stored.fundingInvoiceExposedAt === null
  ) {
    throw new Error("Settled checkout funding is not durably authorized.")
  }
  const repository =
    options.repository ?? new DexieCheckoutSparkSettledRepository()
  const snapshot = await repository.load(checkoutId, stored.planDigest)
  if (snapshot.status !== "active") {
    throw new Error("Settled checkout funding state is unavailable.")
  }
  const plan = snapshot.state.plan
  assertMarketCheckoutSparkDispatchPlan(plan)
  const currentTime = (options.now ?? Date.now)()
  const delivery = getCheckoutSparkRecoveryDelivery(
    stored.recoveryHandoffId,
    recoveryStorage
  )
  if (
    !recoveryAcked(stored.recoveryHandoffId, plan, recoveryStorage) ||
    (options.expectedBuyerPubkey !== undefined &&
      delivery?.record.senderPubkey !==
        options.expectedBuyerPubkey.toLowerCase()) ||
    stored.fundingInvoiceExposedAt < plan.createdAt ||
    stored.fundingInvoiceExposedAt >= plan.funding.expiresAt ||
    !Number.isSafeInteger(currentTime) ||
    currentTime < stored.fundingInvoiceExposedAt ||
    currentTime >= plan.takeoverAt
  ) {
    throw new Error("Settled checkout funding authorization is stale.")
  }
  // The persisted invoice is reconstructed only from the frozen, CAS-backed plan.
  return {
    plan,
    state: snapshot.state,
    fundingReceive: Object.freeze({
      walletId: plan.walletId,
      network: plan.network,
      id: plan.funding.requestId,
      paymentRequest: plan.funding.paymentRequest,
      paymentHash: plan.funding.paymentHash,
      providerStatus: "PERSISTED",
      requiredNetSats: plan.funding.grossFundingSats,
      grossFundingSats: plan.funding.grossFundingSats,
      expirySecs: (plan.funding.expiresAt - plan.funding.createdAt) / 1_000,
      createdAt: plan.funding.createdAt,
      expiresAt: plan.funding.expiresAt,
      receiveSettledPolicy: "ordinary-exact-credit-v3",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    }),
    fundingInvoice: plan.funding.paymentRequest,
    recoveryHandoffId: stored.recoveryHandoffId,
  }
}
