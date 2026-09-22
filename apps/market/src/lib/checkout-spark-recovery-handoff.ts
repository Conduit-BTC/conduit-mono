import {
  createCheckoutSparkRecoveryPayload,
  parseCheckoutSparkRecoveryDeliveryProgress,
  parseCheckoutSparkRecoveryDeliveryRecord,
  publishCheckoutSparkRecovery,
  retryCheckoutSparkRecoveryDelivery,
  type CheckoutSparkPlan,
  type CheckoutSparkRecoveryDeliveryProgress,
  type CheckoutSparkRecoveryDeliveryRecord,
  type CheckoutSparkRecoveryTransportOptions,
  type PublishCheckoutSparkRecoveryResult as CorePublishCheckoutSparkRecoveryResult,
  type RetryCheckoutSparkRecoveryResult,
} from "@conduit/core"
import type { NDKSigner } from "@nostr-dev-kit/ndk"

import type { GuestOrderSigningIdentity } from "./guest-order-identity"
import type { SparkRecoveryBundle } from "./spark-recovery-bundle"
import { isValidSparkMnemonic, normalizeSparkMnemonic } from "./spark-recovery"

const STORAGE_KEY = "conduit:checkout-spark-recovery-outbox:v1"
const MAX_STORED_RECOVERY_DELIVERIES = 64

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export type CheckoutSparkRecoverySigningIdentity =
  | GuestOrderSigningIdentity
  | {
      kind: "signed_in"
      pubkey: string
      signer: NDKSigner
    }

export interface StoredCheckoutSparkRecoveryDelivery {
  record: CheckoutSparkRecoveryDeliveryRecord
  deliveryProgress: CheckoutSparkRecoveryDeliveryProgress
  savedAt: number
}

export type PublishCheckoutSparkRecoveryHandoffResult =
  CorePublishCheckoutSparkRecoveryResult & {
    handoffId: string
  }

function browserStorage(): RecoveryStorage | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function validateStoredDelivery(
  value: unknown
): StoredCheckoutSparkRecoveryDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored checkout recovery delivery is invalid.")
  }
  const candidate = value as Partial<StoredCheckoutSparkRecoveryDelivery>
  const record = parseCheckoutSparkRecoveryDeliveryRecord(candidate.record)
  const deliveryProgress = parseCheckoutSparkRecoveryDeliveryProgress(
    candidate.deliveryProgress,
    record
  )
  if (
    !Number.isSafeInteger(candidate.savedAt) ||
    (candidate.savedAt ?? -1) < record.createdAt
  ) {
    throw new Error("Stored checkout recovery delivery is invalid.")
  }
  return { record, deliveryProgress, savedAt: candidate.savedAt! }
}

function readOutbox(
  storage: RecoveryStorage | null
): StoredCheckoutSparkRecoveryDelivery[] {
  if (!storage) {
    throw new Error("Durable checkout recovery storage is unavailable.")
  }
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Stored checkout recovery outbox is invalid.")
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > MAX_STORED_RECOVERY_DELIVERIES
  ) {
    throw new Error("Stored checkout recovery outbox is invalid.")
  }
  const deliveries = parsed.map(validateStoredDelivery)
  if (
    new Set(deliveries.map((delivery) => delivery.record.handoffId)).size !==
    deliveries.length
  ) {
    throw new Error("Stored checkout recovery outbox is invalid.")
  }
  return deliveries
}

function writeOutbox(
  deliveries: readonly StoredCheckoutSparkRecoveryDelivery[],
  storage: RecoveryStorage | null
): void {
  if (!storage) {
    throw new Error("Durable checkout recovery storage is unavailable.")
  }
  if (deliveries.length > MAX_STORED_RECOVERY_DELIVERIES) {
    throw new Error("Stored checkout recovery outbox is full.")
  }
  if (deliveries.length === 0) {
    storage.removeItem(STORAGE_KEY)
    return
  }
  storage.setItem(STORAGE_KEY, JSON.stringify(deliveries))
}

function sameExactDelivery(
  left: CheckoutSparkRecoveryDeliveryRecord,
  right: CheckoutSparkRecoveryDeliveryRecord
): boolean {
  return (
    left.handoffId === right.handoffId &&
    left.rumorId === right.rumorId &&
    left.signedRecipientWrap.id === right.signedRecipientWrap.id &&
    left.signedRecipientWrap.sig === right.signedRecipientWrap.sig
  )
}

export function listCheckoutSparkRecoveryDeliveries(
  storage: RecoveryStorage | null = browserStorage()
): StoredCheckoutSparkRecoveryDelivery[] {
  return readOutbox(storage)
}

export function getCheckoutSparkRecoveryDelivery(
  handoffId: string,
  storage: RecoveryStorage | null = browserStorage()
): StoredCheckoutSparkRecoveryDelivery | null {
  return (
    readOutbox(storage).find(
      (delivery) => delivery.record.handoffId === handoffId
    ) ?? null
  )
}

export function saveCheckoutSparkRecoveryDelivery(
  recordInput: CheckoutSparkRecoveryDeliveryRecord,
  progressInput: CheckoutSparkRecoveryDeliveryProgress,
  storage: RecoveryStorage | null = browserStorage(),
  now = Date.now()
): StoredCheckoutSparkRecoveryDelivery {
  const record = parseCheckoutSparkRecoveryDeliveryRecord(recordInput)
  const deliveryProgress = parseCheckoutSparkRecoveryDeliveryProgress(
    progressInput,
    record
  )
  if (!Number.isSafeInteger(now) || now < record.createdAt) {
    throw new Error("Checkout recovery persistence time is invalid.")
  }
  const deliveries = readOutbox(storage)
  const existingIndex = deliveries.findIndex(
    (delivery) => delivery.record.handoffId === record.handoffId
  )
  if (
    existingIndex >= 0 &&
    !sameExactDelivery(deliveries[existingIndex]!.record, record)
  ) {
    throw new Error(
      "Checkout recovery already has a different exact delivery wrapper."
    )
  }
  const existing = existingIndex >= 0 ? deliveries[existingIndex]! : null
  const mergedProgress = parseCheckoutSparkRecoveryDeliveryProgress(
    existing
      ? {
          ...deliveryProgress,
          acknowledgedRelayRefs: Array.from(
            new Set([
              ...existing.deliveryProgress.acknowledgedRelayRefs,
              ...deliveryProgress.acknowledgedRelayRefs,
            ])
          ).sort(),
        }
      : deliveryProgress,
    record
  )
  const stored = {
    record,
    deliveryProgress: mergedProgress,
    savedAt: Math.max(existing?.savedAt ?? record.createdAt, now),
  }
  const next = [...deliveries]
  if (existingIndex >= 0) next[existingIndex] = stored
  else next.push(stored)
  writeOutbox(next, storage)

  const readback = readOutbox(storage).find(
    (delivery) => delivery.record.handoffId === record.handoffId
  )
  if (!readback || !sameExactDelivery(readback.record, record)) {
    throw new Error("Checkout recovery wrapper was not durably saved.")
  }
  return readback
}

export function deleteCheckoutSparkRecoveryDelivery(
  handoffId: string,
  storage: RecoveryStorage | null = browserStorage()
): void {
  writeOutbox(
    readOutbox(storage).filter(
      (delivery) => delivery.record.handoffId !== handoffId
    ),
    storage
  )
}

function assertScopedRecoveryInput(input: {
  plan: CheckoutSparkPlan
  recovery: SparkRecoveryBundle
  identity: CheckoutSparkRecoverySigningIdentity
  preparedAt: number
}): string {
  const mnemonic = normalizeSparkMnemonic(input.recovery.mnemonic)
  if (
    !isValidSparkMnemonic(mnemonic) ||
    input.recovery.network !== input.plan.network
  ) {
    throw new Error(
      input.identity.kind === "guest_ephemeral"
        ? "Checkout Spark recovery is outside its guest order scope."
        : "Checkout Spark recovery is outside its checkout scope."
    )
  }
  if (
    input.identity.kind === "guest_ephemeral" &&
    (input.identity.orderId !== input.plan.orderId ||
      input.identity.merchantPubkey.trim().toLowerCase() !==
        input.plan.merchantPubkey ||
      input.preparedAt < input.identity.createdAt ||
      input.preparedAt >= input.identity.expiresAt)
  ) {
    throw new Error("Checkout Spark recovery is outside its guest order scope.")
  }
  return mnemonic
}

/**
 * Prepare, persist, and publish one merchant recovery wrap. The funding invoice
 * remains unusable to the caller until this resolves with an acknowledged wrap.
 */
export async function publishCheckoutSparkRecoveryHandoff(input: {
  plan: CheckoutSparkPlan
  recovery: SparkRecoveryBundle
  identity: CheckoutSparkRecoverySigningIdentity
  preparedAt?: number
  storage?: RecoveryStorage | null
  transport?: CheckoutSparkRecoveryTransportOptions
  now?: () => number
  onPersisted?: (handoffId: string) => void | Promise<void>
}): Promise<PublishCheckoutSparkRecoveryHandoffResult> {
  const now = input.now ?? Date.now
  const preparedAt = input.preparedAt ?? now()
  const mnemonic = assertScopedRecoveryInput({
    plan: input.plan,
    recovery: input.recovery,
    identity: input.identity,
    preparedAt,
  })
  const payload = createCheckoutSparkRecoveryPayload({
    plan: input.plan,
    senderPubkey: input.identity.pubkey,
    mnemonic,
    accountNumber: input.recovery.accountNumber,
    preparedAt,
  })
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const persisted = {
    record: null as CheckoutSparkRecoveryDeliveryRecord | null,
  }
  const result = await publishCheckoutSparkRecovery({
    payload,
    signer: input.identity.signer,
    signerInteraction:
      input.identity.kind === "guest_ephemeral"
        ? "application_owned"
        : "external",
    transport: input.transport,
    persistExactWrap: async (preparedRecord, progress) => {
      persisted.record = preparedRecord
      saveCheckoutSparkRecoveryDelivery(
        preparedRecord,
        progress,
        storage,
        now()
      )
      await input.onPersisted?.(preparedRecord.handoffId)
    },
  })
  const record = persisted.record
  if (!record) {
    throw new Error("Checkout Spark recovery wrapper was not persisted.")
  }
  saveCheckoutSparkRecoveryDelivery(
    record,
    result.deliveryProgress,
    storage,
    now()
  )
  return { ...result, handoffId: record.handoffId }
}

/** Retry a previously persisted exact wrapper without accessing the mnemonic. */
export async function retryStoredCheckoutSparkRecoveryHandoff(input: {
  handoffId: string
  storage?: RecoveryStorage | null
  recipientInboxRelays?: readonly string[]
  shouldContinue?: () => boolean
  publishFn?: Parameters<
    typeof retryCheckoutSparkRecoveryDelivery
  >[0]["publishFn"]
  now?: () => number
}): Promise<RetryCheckoutSparkRecoveryResult> {
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const stored = getCheckoutSparkRecoveryDelivery(input.handoffId, storage)
  if (!stored) throw new Error("Checkout recovery delivery was not found.")
  const result = await retryCheckoutSparkRecoveryDelivery({
    record: stored.record,
    deliveryProgress: stored.deliveryProgress,
    recipientInboxRelays: input.recipientInboxRelays,
    shouldContinue: input.shouldContinue,
    publishFn: input.publishFn,
  })
  saveCheckoutSparkRecoveryDelivery(
    stored.record,
    result.deliveryProgress,
    storage,
    (input.now ?? Date.now)()
  )
  return result
}
