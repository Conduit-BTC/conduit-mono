import {
  applyCheckoutSparkEvidence,
  buildCheckoutSparkRouterObligations,
  createCheckoutSparkReconciliation,
  freezeCheckoutSparkPlan,
  restoreCheckoutSparkReconciliation,
  type BuildCheckoutSparkRouterObligationsInput,
  type CheckoutSparkNetwork,
  type CheckoutSparkPlan,
  type CheckoutSparkReconciliation,
} from "@conduit/core"

import {
  getCheckoutSparkRecoveryDelivery,
  publishCheckoutSparkRecoveryHandoff,
  retryStoredCheckoutSparkRecoveryHandoff,
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

const STORAGE_KEY = "conduit:checkout-spark-router-preparations:v1"
const MAX_STORED_PREPARATIONS = 64
const MAX_HANDOFF_ID_LENGTH = 256

export type CheckoutSparkRouterStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>

export type CheckoutSparkRouterFundingSubmissionState =
  "not_started" | "provisional"

export interface StoredCheckoutSparkRouterPreparation {
  schemaVersion: 1
  reconciliation: CheckoutSparkReconciliation
  /** Non-secret provider receive identity needed to resume after relay lag. */
  fundingReceive?: SparkCheckoutReceiveRequest
  recoveryHandoffId: string | null
  fundingInvoiceExposedAt: number | null
  fundingSubmissionState: CheckoutSparkRouterFundingSubmissionState
  savedAt: number
}

export interface CheckoutSparkRouterWalletMaterial extends SparkRecoveryBundle {
  walletId: string
  network: CheckoutSparkNetwork
}

export interface PrepareCheckoutSparkRouterFundingInput {
  checkoutId: string
  orderId: string
  merchantPubkey: string
  network: CheckoutSparkNetwork
  takeoverAt: number
  grossFundingSats: number
  fundingExpirySecs: number
  identity: CheckoutSparkRecoverySigningIdentity
  routerObligationInputs: Omit<
    BuildCheckoutSparkRouterObligationsInput,
    "network" | "nowSeconds"
  >
  storage?: CheckoutSparkRouterStorage | null
}

export interface PreparedCheckoutSparkRouterFunding {
  plan: CheckoutSparkPlan
  reconciliation: CheckoutSparkReconciliation
  recoveryHandoffId: string
  fundingInvoice: string
  fundingReceive: Readonly<SparkCheckoutReceiveRequest>
  fundingSubmissionState: CheckoutSparkRouterFundingSubmissionState
}

interface PublishRecoveryHandoffInput {
  plan: CheckoutSparkPlan
  recovery: SparkRecoveryBundle
  identity: CheckoutSparkRecoverySigningIdentity
  preparedAt: number
  onPersisted: (handoffId: string) => void | Promise<void>
}

export interface PrepareCheckoutSparkRouterFundingDependencies {
  now?: () => number
  createWalletMaterial?: (
    network: CheckoutSparkNetwork
  ) => CheckoutSparkRouterWalletMaterial
  openWallet?: (wallet: CheckoutSparkRouterWalletMaterial) => Promise<void>
  closeWallet?: (walletId: string) => Promise<void>
  createFundingReceive?: (
    wallet: CheckoutSparkRouterWalletMaterial,
    input: SparkCheckoutReceiveInput
  ) => Promise<SparkCheckoutReceiveRequest>
  publishRecoveryHandoff?: (
    input: PublishRecoveryHandoffInput
  ) => Promise<{ handoffId: string; canExposeFundingInvoice: true }>
}

function browserStorage(): CheckoutSparkRouterStorage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function requireStorage(
  storage: CheckoutSparkRouterStorage | null
): CheckoutSparkRouterStorage {
  if (!storage) {
    throw new Error("Durable checkout Spark router storage is unavailable.")
  }
  return storage
}

function parseOptionalHandoffId(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_HANDOFF_ID_LENGTH
  ) {
    throw new Error("Stored checkout Spark router handoff is invalid.")
  }
  return value
}

function parseOptionalExposureTime(
  value: unknown,
  createdAt: number
): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < createdAt) {
    throw new Error("Stored checkout Spark router exposure is invalid.")
  }
  return value as number
}

function parseFundingSubmissionState(
  value: unknown
): CheckoutSparkRouterFundingSubmissionState {
  if (value === undefined || value === "not_started") return "not_started"
  if (value === "provisional") return value
  throw new Error("Stored checkout Spark router submission is invalid.")
}

function parseStoredFundingReceive(
  value: unknown,
  plan: CheckoutSparkPlan
): SparkCheckoutReceiveRequest | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored checkout Spark receive is invalid.")
  }
  const receive = value as Partial<SparkCheckoutReceiveRequest>
  const funding = plan.funding
  const expiryMs = funding.expiresAt - funding.createdAt
  if (
    receive.walletId !== plan.walletId ||
    receive.network !== plan.network ||
    receive.id !== funding.requestId ||
    receive.paymentRequest !== funding.paymentRequest ||
    receive.paymentHash !== funding.paymentHash ||
    receive.requiredNetSats !== funding.requiredNetSats ||
    receive.grossFundingSats !== funding.grossFundingSats ||
    receive.createdAt !== funding.createdAt ||
    receive.expiresAt !== funding.expiresAt ||
    !Number.isSafeInteger(receive.expirySecs) ||
    receive.expirySecs! <= 0 ||
    receive.expirySecs! * 1_000 !== expiryMs ||
    typeof receive.providerStatus !== "string" ||
    !receive.providerStatus.trim()
  ) {
    throw new Error("Stored checkout Spark receive conflicts with its plan.")
  }
  return receive as SparkCheckoutReceiveRequest
}

function parseStoredPreparation(
  value: unknown
): StoredCheckoutSparkRouterPreparation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored checkout Spark router preparation is invalid.")
  }
  const candidate = value as Partial<StoredCheckoutSparkRouterPreparation>
  if (candidate.schemaVersion !== 1 || !candidate.reconciliation) {
    throw new Error("Stored checkout Spark router preparation is invalid.")
  }
  const reconciliation = restoreCheckoutSparkReconciliation(
    candidate.reconciliation
  )
  const fundingReceive = parseStoredFundingReceive(
    candidate.fundingReceive,
    reconciliation.plan
  )
  const recoveryHandoffId = parseOptionalHandoffId(candidate.recoveryHandoffId)
  const fundingInvoiceExposedAt = parseOptionalExposureTime(
    candidate.fundingInvoiceExposedAt,
    reconciliation.plan.createdAt
  )
  const fundingSubmissionState = parseFundingSubmissionState(
    candidate.fundingSubmissionState
  )
  if (
    !Number.isSafeInteger(candidate.savedAt) ||
    (candidate.savedAt ?? -1) < reconciliation.plan.createdAt ||
    (fundingInvoiceExposedAt !== null && recoveryHandoffId === null)
  ) {
    throw new Error("Stored checkout Spark router preparation is invalid.")
  }
  return {
    schemaVersion: 1,
    reconciliation,
    ...(fundingReceive ? { fundingReceive } : {}),
    recoveryHandoffId,
    fundingInvoiceExposedAt,
    fundingSubmissionState,
    savedAt: candidate.savedAt!,
  }
}

function readPreparations(
  storage: CheckoutSparkRouterStorage | null
): StoredCheckoutSparkRouterPreparation[] {
  const durable = requireStorage(storage)
  const raw = durable.getItem(STORAGE_KEY)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Stored checkout Spark router preparations are invalid.")
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_STORED_PREPARATIONS) {
    throw new Error("Stored checkout Spark router preparations are invalid.")
  }
  const preparations = parsed.map(parseStoredPreparation)
  if (
    new Set(
      preparations.map(
        (preparation) => preparation.reconciliation.plan.checkoutId
      )
    ).size !== preparations.length
  ) {
    throw new Error("Stored checkout Spark router preparations are invalid.")
  }
  return preparations
}

function writePreparations(
  preparations: readonly StoredCheckoutSparkRouterPreparation[],
  storage: CheckoutSparkRouterStorage | null
): void {
  const durable = requireStorage(storage)
  if (preparations.length > MAX_STORED_PREPARATIONS) {
    throw new Error("Stored checkout Spark router preparation limit reached.")
  }
  if (preparations.length === 0) {
    durable.removeItem(STORAGE_KEY)
    return
  }
  durable.setItem(STORAGE_KEY, JSON.stringify(preparations))
}

export function listCheckoutSparkRouterPreparations(
  storage: CheckoutSparkRouterStorage | null = browserStorage()
): StoredCheckoutSparkRouterPreparation[] {
  return readPreparations(storage)
}

export function getCheckoutSparkRouterPreparation(
  checkoutId: string,
  storage: CheckoutSparkRouterStorage | null = browserStorage()
): StoredCheckoutSparkRouterPreparation | null {
  return (
    readPreparations(storage).find(
      (preparation) => preparation.reconciliation.plan.checkoutId === checkoutId
    ) ?? null
  )
}

function mergeCheckoutSparkRouterFundingProgress(
  current: CheckoutSparkReconciliation,
  candidate: CheckoutSparkReconciliation
): CheckoutSparkReconciliation {
  if (current.plan.planDigest !== candidate.plan.planDigest) {
    throw new Error(
      "Checkout Spark router funding progress does not match its frozen plan."
    )
  }
  if (
    candidate.funding.state === "unreconciled" ||
    candidate.funding.observedAt === null
  ) {
    return current
  }
  return applyCheckoutSparkEvidence(current, {
    type: "funding",
    requestId: candidate.plan.funding.requestId,
    paymentRequest: candidate.plan.funding.paymentRequest,
    paymentHash: candidate.plan.funding.paymentHash,
    walletId: candidate.plan.walletId,
    network: candidate.plan.network,
    requiredNetSats: candidate.plan.funding.requiredNetSats,
    grossFundingSats: candidate.plan.funding.grossFundingSats,
    state: candidate.funding.state,
    observedAt: candidate.funding.observedAt,
  })
}

function saveCheckoutSparkRouterPreparationInternal(
  input: Omit<StoredCheckoutSparkRouterPreparation, "schemaVersion">,
  storage: CheckoutSparkRouterStorage | null,
  allowFundingSubmissionReset: boolean
): StoredCheckoutSparkRouterPreparation {
  const candidate = parseStoredPreparation({ schemaVersion: 1, ...input })
  const preparations = readPreparations(storage)
  const checkoutId = candidate.reconciliation.plan.checkoutId
  const index = preparations.findIndex(
    (preparation) => preparation.reconciliation.plan.checkoutId === checkoutId
  )
  const existing = index >= 0 ? preparations[index]! : null
  if (
    existing &&
    (existing.reconciliation.plan.planDigest !==
      candidate.reconciliation.plan.planDigest ||
      (existing.recoveryHandoffId !== null &&
        candidate.recoveryHandoffId !== null &&
        existing.recoveryHandoffId !== candidate.recoveryHandoffId))
  ) {
    throw new Error(
      "Checkout Spark router preparation conflicts with its frozen plan."
    )
  }
  const candidateFundingMatchesExisting =
    existing === null ||
    (existing.reconciliation.funding.state ===
      candidate.reconciliation.funding.state &&
      existing.reconciliation.funding.observedAt ===
        candidate.reconciliation.funding.observedAt)
  const canResetFundingSubmission =
    allowFundingSubmissionReset && candidateFundingMatchesExisting
  const stored = parseStoredPreparation({
    ...candidate,
    reconciliation: existing
      ? mergeCheckoutSparkRouterFundingProgress(
          existing.reconciliation,
          candidate.reconciliation
        )
      : candidate.reconciliation,
    ...(existing?.fundingReceive || candidate.fundingReceive
      ? {
          fundingReceive: existing?.fundingReceive ?? candidate.fundingReceive,
        }
      : {}),
    recoveryHandoffId:
      existing?.recoveryHandoffId ?? candidate.recoveryHandoffId,
    fundingInvoiceExposedAt:
      existing?.fundingInvoiceExposedAt ?? candidate.fundingInvoiceExposedAt,
    fundingSubmissionState:
      !canResetFundingSubmission &&
      existing?.fundingSubmissionState === "provisional" &&
      candidate.fundingSubmissionState === "not_started"
        ? "provisional"
        : candidate.fundingSubmissionState,
    savedAt: Math.max(
      existing?.savedAt ?? candidate.savedAt,
      candidate.savedAt
    ),
  })
  const next = [...preparations]
  if (index >= 0) next[index] = stored
  else next.push(stored)
  writePreparations(next, storage)

  const readback = getCheckoutSparkRouterPreparation(checkoutId, storage)
  if (
    !readback ||
    readback.reconciliation.plan.planDigest !==
      stored.reconciliation.plan.planDigest ||
    readback.recoveryHandoffId !== stored.recoveryHandoffId ||
    readback.fundingInvoiceExposedAt !== stored.fundingInvoiceExposedAt ||
    readback.fundingSubmissionState !== stored.fundingSubmissionState
  ) {
    throw new Error("Checkout Spark router preparation was not durably saved.")
  }
  return readback
}

export function saveCheckoutSparkRouterPreparation(
  input: Omit<StoredCheckoutSparkRouterPreparation, "schemaVersion">,
  storage: CheckoutSparkRouterStorage | null = browserStorage()
): StoredCheckoutSparkRouterPreparation {
  return saveCheckoutSparkRouterPreparationInternal(input, storage, false)
}

export function saveCheckoutSparkRouterFundingProgress(
  input: {
    checkoutId: string
    planDigest: string
    reconciliation: CheckoutSparkReconciliation
    fundingSubmissionState: CheckoutSparkRouterFundingSubmissionState
    savedAt: number
    /** Only a definite no-funds-moved result may clear a provisional send. */
    allowSubmissionReset?: boolean
  },
  storage: CheckoutSparkRouterStorage | null = browserStorage()
): StoredCheckoutSparkRouterPreparation {
  const existing = getCheckoutSparkRouterPreparation(input.checkoutId, storage)
  if (
    !existing ||
    existing.reconciliation.plan.planDigest !== input.planDigest ||
    input.reconciliation.plan.planDigest !== input.planDigest
  ) {
    throw new Error(
      "Checkout Spark router funding progress does not match its frozen plan."
    )
  }
  return saveCheckoutSparkRouterPreparationInternal(
    {
      ...existing,
      reconciliation: input.reconciliation,
      fundingSubmissionState: input.fundingSubmissionState,
      savedAt: input.savedAt,
    },
    storage,
    input.allowSubmissionReset === true
  )
}

export function deleteCheckoutSparkRouterPreparation(
  checkoutId: string,
  storage: CheckoutSparkRouterStorage | null = browserStorage()
): void {
  writePreparations(
    readPreparations(storage).filter(
      (preparation) => preparation.reconciliation.plan.checkoutId !== checkoutId
    ),
    storage
  )
}

function defaultCreateWalletMaterial(
  network: CheckoutSparkNetwork
): CheckoutSparkRouterWalletMaterial {
  const configuration = getSparkConfiguration()
  if (configuration.status !== "ready" || configuration.network !== network) {
    throw new Error(
      configuration.status === "unavailable"
        ? configuration.reason
        : "Spark is configured for a different checkout network."
    )
  }
  if (!globalThis.crypto?.randomUUID) {
    throw new Error(
      "Secure checkout wallet identity generation is unavailable."
    )
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

export async function prepareCheckoutSparkRouterFunding(
  input: PrepareCheckoutSparkRouterFundingInput,
  dependencies: PrepareCheckoutSparkRouterFundingDependencies = {}
): Promise<PreparedCheckoutSparkRouterFunding> {
  const now = dependencies.now ?? Date.now
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const createWalletMaterial =
    dependencies.createWalletMaterial ?? defaultCreateWalletMaterial
  const openWallet =
    dependencies.openWallet ??
    ((wallet: CheckoutSparkRouterWalletMaterial) =>
      requireSparkManager().openWithMnemonic(wallet))
  const closeWallet =
    dependencies.closeWallet ??
    ((walletId: string) => requireSparkManager().close(walletId))
  const createFundingReceive =
    dependencies.createFundingReceive ??
    ((wallet: CheckoutSparkRouterWalletMaterial, request) =>
      requireSparkManager().createCheckoutReceive(wallet.walletId, request))
  const publishRecoveryHandoff =
    dependencies.publishRecoveryHandoff ?? publishCheckoutSparkRecoveryHandoff

  const routerObligations = buildCheckoutSparkRouterObligations({
    ...input.routerObligationInputs,
    network: input.network,
    nowSeconds: Math.floor(now() / 1_000),
  })
  const requiredNetSats = routerObligations.requiredNetSats
  const wallet = createWalletMaterial(input.network)
  if (wallet.network !== input.network) {
    throw new Error("Checkout Spark wallet network does not match the router.")
  }
  let recoveryPersisted = false
  let preparation: StoredCheckoutSparkRouterPreparation | null = null

  await openWallet(wallet)
  try {
    const funding = await createFundingReceive(wallet, {
      invoiceKind: "plain",
      description: "Conduit checkout funding",
      requiredNetSats,
      grossFundingSats: input.grossFundingSats,
      expirySecs: input.fundingExpirySecs,
    })
    if (
      funding.walletId !== wallet.walletId ||
      funding.network !== wallet.network ||
      funding.requiredNetSats !== requiredNetSats ||
      funding.grossFundingSats !== input.grossFundingSats ||
      funding.expirySecs !== input.fundingExpirySecs
    ) {
      throw new Error(
        "Checkout Spark funding request does not match its exact router terms."
      )
    }
    const plan = freezeCheckoutSparkPlan({
      checkoutId: input.checkoutId,
      orderId: input.orderId,
      merchantPubkey: input.merchantPubkey,
      walletId: wallet.walletId,
      network: input.network,
      createdAt: funding.createdAt,
      takeoverAt: input.takeoverAt,
      funding: {
        requestId: funding.id,
        paymentRequest: funding.paymentRequest,
        paymentHash: funding.paymentHash,
        requiredNetSats: funding.requiredNetSats,
        grossFundingSats: funding.grossFundingSats,
        createdAt: funding.createdAt,
        expiresAt: funding.expiresAt,
      },
      obligations: routerObligations.obligations,
    })
    const reconciliation = createCheckoutSparkReconciliation(plan)
    preparation = saveCheckoutSparkRouterPreparation(
      {
        reconciliation,
        fundingReceive: funding,
        recoveryHandoffId: null,
        fundingInvoiceExposedAt: null,
        fundingSubmissionState: "not_started",
        savedAt: now(),
      },
      storage
    )

    const handoff = await publishRecoveryHandoff({
      plan,
      recovery: wallet,
      identity: input.identity,
      preparedAt: now(),
      onPersisted: (handoffId) => {
        recoveryPersisted = true
        preparation = saveCheckoutSparkRouterPreparation(
          {
            ...preparation!,
            recoveryHandoffId: handoffId,
            savedAt: now(),
          },
          storage
        )
      },
    })
    if (
      !handoff.canExposeFundingInvoice ||
      preparation.recoveryHandoffId !== handoff.handoffId
    ) {
      throw new Error(
        "Checkout Spark recovery is not ready to expose the funding invoice."
      )
    }

    preparation = saveCheckoutSparkRouterPreparation(
      {
        ...preparation,
        fundingInvoiceExposedAt: now(),
        savedAt: now(),
      },
      storage
    )
    return {
      plan,
      reconciliation: preparation.reconciliation,
      recoveryHandoffId: handoff.handoffId,
      fundingInvoice: plan.funding.paymentRequest,
      fundingReceive: Object.freeze({ ...funding }),
      fundingSubmissionState: preparation.fundingSubmissionState,
    }
  } catch (error) {
    if (!recoveryPersisted) {
      if (preparation) {
        deleteCheckoutSparkRouterPreparation(input.checkoutId, storage)
      }
      try {
        await closeWallet(wallet.walletId)
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Checkout Spark preparation failed and its empty wallet could not be closed.",
          { cause: closeError }
        )
      }
    }
    throw error
  }
}

/**
 * Finish a preparation whose exact recovery wrap was saved but received no
 * relay ACK. This never creates a new wallet, receive invoice, or NIP-59 wrap.
 */
export async function retryCheckoutSparkRouterRecoveryAndResumeFunding(input: {
  checkoutId: string
  storage?: CheckoutSparkRouterStorage | null
  now?: () => number
  recipientInboxRelays?: readonly string[]
  shouldContinue?: () => boolean
  publishFn?: Parameters<
    typeof retryStoredCheckoutSparkRecoveryHandoff
  >[0]["publishFn"]
}): Promise<PreparedCheckoutSparkRouterFunding> {
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const now = input.now ?? Date.now
  const stored = getCheckoutSparkRouterPreparation(input.checkoutId, storage)
  const handoffId = stored?.recoveryHandoffId
  const receive = stored?.fundingReceive
  if (!stored || !handoffId || !receive) {
    throw new Error("Checkout Spark recovery cannot resume this preparation.")
  }
  const plan = stored.reconciliation.plan
  const currentTime = now()
  if (
    !Number.isSafeInteger(currentTime) ||
    currentTime < plan.createdAt ||
    currentTime >= plan.funding.expiresAt ||
    currentTime >= plan.takeoverAt ||
    stored.fundingSubmissionState !== "not_started"
  ) {
    throw new Error("Checkout Spark funding is no longer safe to expose.")
  }

  const delivery = getCheckoutSparkRecoveryDelivery(handoffId, storage)
  if (
    !delivery ||
    delivery.record.checkoutId !== plan.checkoutId ||
    delivery.record.orderId !== plan.orderId ||
    delivery.record.planDigest !== plan.planDigest ||
    delivery.record.walletId !== plan.walletId ||
    delivery.record.network !== plan.network ||
    delivery.record.merchantPubkey !== plan.merchantPubkey
  ) {
    throw new Error("Checkout Spark recovery does not match its frozen plan.")
  }

  const retried = await retryStoredCheckoutSparkRecoveryHandoff({
    handoffId,
    storage,
    now,
    recipientInboxRelays: input.recipientInboxRelays,
    shouldContinue: input.shouldContinue,
    publishFn: input.publishFn,
  })
  if (!retried.canExposeFundingInvoice) {
    throw new Error("Checkout Spark recovery received no relay ACK.")
  }
  const acknowledged = getCheckoutSparkRecoveryDelivery(handoffId, storage)
  const current = getCheckoutSparkRouterPreparation(input.checkoutId, storage)
  if (
    !acknowledged?.deliveryProgress.acknowledgedRelayRefs.length ||
    current?.reconciliation.plan.planDigest !== plan.planDigest ||
    current.recoveryHandoffId !== handoffId ||
    current.fundingSubmissionState !== "not_started" ||
    !current.fundingReceive ||
    now() >= plan.funding.expiresAt ||
    now() >= plan.takeoverAt
  ) {
    throw new Error("Checkout Spark funding is no longer safe to expose.")
  }
  const exposed = saveCheckoutSparkRouterPreparation(
    {
      ...current,
      fundingInvoiceExposedAt: current.fundingInvoiceExposedAt ?? now(),
      savedAt: now(),
    },
    storage
  )
  return {
    plan,
    reconciliation: exposed.reconciliation,
    recoveryHandoffId: handoffId,
    fundingInvoice: plan.funding.paymentRequest,
    fundingReceive: Object.freeze({ ...current.fundingReceive }),
    fundingSubmissionState: exposed.fundingSubmissionState,
  }
}
