import {
  createCheckoutSparkReconciliation,
  freezeCheckoutSparkPlan,
  restoreCheckoutSparkReconciliation,
  type CheckoutSparkNetwork,
  type CheckoutSparkObligationPlanInput,
  type CheckoutSparkPlan,
  type CheckoutSparkReconciliation,
} from "@conduit/core"

import {
  publishCheckoutSparkRecoveryHandoff,
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

type RouterStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export interface StoredCheckoutSparkRouterPreparation {
  schemaVersion: 1
  reconciliation: CheckoutSparkReconciliation
  recoveryHandoffId: string | null
  fundingInvoiceExposedAt: number | null
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
  obligations: readonly CheckoutSparkObligationPlanInput[]
  storage?: RouterStorage | null
}

export interface PreparedCheckoutSparkRouterFunding {
  plan: CheckoutSparkPlan
  reconciliation: CheckoutSparkReconciliation
  recoveryHandoffId: string
  fundingInvoice: string
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

function browserStorage(): RouterStorage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function requireStorage(storage: RouterStorage | null): RouterStorage {
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
  const recoveryHandoffId = parseOptionalHandoffId(candidate.recoveryHandoffId)
  const fundingInvoiceExposedAt = parseOptionalExposureTime(
    candidate.fundingInvoiceExposedAt,
    reconciliation.plan.createdAt
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
    recoveryHandoffId,
    fundingInvoiceExposedAt,
    savedAt: candidate.savedAt!,
  }
}

function readPreparations(
  storage: RouterStorage | null
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
  storage: RouterStorage | null
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
  storage: RouterStorage | null = browserStorage()
): StoredCheckoutSparkRouterPreparation[] {
  return readPreparations(storage)
}

export function getCheckoutSparkRouterPreparation(
  checkoutId: string,
  storage: RouterStorage | null = browserStorage()
): StoredCheckoutSparkRouterPreparation | null {
  return (
    readPreparations(storage).find(
      (preparation) => preparation.reconciliation.plan.checkoutId === checkoutId
    ) ?? null
  )
}

export function saveCheckoutSparkRouterPreparation(
  input: Omit<StoredCheckoutSparkRouterPreparation, "schemaVersion">,
  storage: RouterStorage | null = browserStorage()
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
  const stored = parseStoredPreparation({
    ...candidate,
    recoveryHandoffId:
      existing?.recoveryHandoffId ?? candidate.recoveryHandoffId,
    fundingInvoiceExposedAt:
      existing?.fundingInvoiceExposedAt ?? candidate.fundingInvoiceExposedAt,
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
    readback.fundingInvoiceExposedAt !== stored.fundingInvoiceExposedAt
  ) {
    throw new Error("Checkout Spark router preparation was not durably saved.")
  }
  return readback
}

export function deleteCheckoutSparkRouterPreparation(
  checkoutId: string,
  storage: RouterStorage | null = browserStorage()
): void {
  writePreparations(
    readPreparations(storage).filter(
      (preparation) => preparation.reconciliation.plan.checkoutId !== checkoutId
    ),
    storage
  )
}

function requiredFundingSats(
  obligations: readonly CheckoutSparkObligationPlanInput[]
): number {
  const required = obligations.reduce(
    (sum, obligation) => sum + obligation.amountSats + obligation.maxFeeSats,
    0
  )
  if (!Number.isSafeInteger(required) || required <= 0) {
    throw new Error("Checkout Spark required funding is invalid.")
  }
  return required
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

  const requiredNetSats = requiredFundingSats(input.obligations)
  const wallet = createWalletMaterial(input.network)
  if (wallet.network !== input.network) {
    throw new Error("Checkout Spark wallet network does not match the router.")
  }
  let recoveryPersisted = false
  let preparation: StoredCheckoutSparkRouterPreparation | null = null

  await openWallet(wallet)
  try {
    const funding = await createFundingReceive(wallet, {
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
      obligations: input.obligations,
    })
    const reconciliation = createCheckoutSparkReconciliation(plan)
    preparation = saveCheckoutSparkRouterPreparation(
      {
        reconciliation,
        recoveryHandoffId: null,
        fundingInvoiceExposedAt: null,
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
