import type { NostrKeySigner } from "@conduit/core"
import {
  createCheckoutSparkRecoveryPayload,
  createCheckoutSparkSettledRecoveryPayload,
  createCheckoutSparkSettledRecoveryProgressPayload,
  deriveCheckoutSparkSettledRecoverySnapshotKey,
  parseCheckoutSparkRecoveryDeliveryProgress,
  parseCheckoutSparkRecoveryDeliveryRecord,
  publishCheckoutSparkRecovery,
  retryCheckoutSparkRecoveryDelivery,
  type CheckoutSparkPlan,
  type CheckoutSparkRecoveryPayload,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkRecoveryDeliveryProgress,
  type CheckoutSparkRecoveryDeliveryRecord,
  type CheckoutSparkRecoveryTransportOptions,
  type PublishCheckoutSparkRecoveryResult as CorePublishCheckoutSparkRecoveryResult,
  type RetryCheckoutSparkRecoveryResult,
  type SignedPublicNostrEvent,
} from "@conduit/core"

import {
  createGuestCheckoutSparkRecoverySigner,
  GUEST_ORDER_SESSION_TTL_MS,
  type GuestOrderSigningIdentity,
} from "./guest-order-identity"
import type { SparkRecoveryBundle } from "./spark-recovery-bundle"
import { isValidSparkMnemonic, normalizeSparkMnemonic } from "./spark-recovery"

import { withCheckoutSparkStorageLock } from "./checkout-spark-storage"

const STORAGE_KEY = "conduit:checkout-spark-recovery-outbox:v1"
const SNAPSHOT_RETRY_STORAGE_KEY =
  "conduit:checkout-spark-recovery-snapshot-retries:v1"
// The retry registry is one shared localStorage object, so serialize its
// read/sign/persist sequence across all checkouts in this browser origin.
const SNAPSHOT_RETRY_LOCK_NAME =
  "conduit:checkout-spark-recovery-snapshot-retries"
const MAX_STORED_RECOVERY_DELIVERIES = 64
const HEX_64 = /^[0-9a-f]{64}$/

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

function readSnapshotRetryRegistry(
  storage: RecoveryStorage | null
): Record<string, string> {
  if (!storage)
    throw new Error("Durable checkout recovery storage is unavailable.")
  const raw = storage.getItem(SNAPSHOT_RETRY_STORAGE_KEY)
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Stored checkout recovery retry registry is invalid.")
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length > MAX_STORED_RECOVERY_DELIVERIES ||
    Object.entries(parsed).some(
      ([key, handoffId]) =>
        !HEX_64.test(key) ||
        typeof handoffId !== "string" ||
        !HEX_64.test(handoffId)
    )
  ) {
    throw new Error("Stored checkout recovery retry registry is invalid.")
  }
  return parsed as Record<string, string>
}

function saveSnapshotRetryMapping(input: {
  key: string
  handoffId: string
  storage: RecoveryStorage | null
}): void {
  const registry = readSnapshotRetryRegistry(input.storage)
  if (registry[input.key] && registry[input.key] !== input.handoffId) {
    throw new Error(
      "Checkout recovery state already has a different signed wrap."
    )
  }
  const next = { ...registry, [input.key]: input.handoffId }
  if (Object.keys(next).length > MAX_STORED_RECOVERY_DELIVERIES) {
    throw new Error("Stored checkout recovery retry registry is full.")
  }
  input.storage!.setItem(SNAPSHOT_RETRY_STORAGE_KEY, JSON.stringify(next))
  if (readSnapshotRetryRegistry(input.storage)[input.key] !== input.handoffId) {
    throw new Error("Checkout recovery retry mapping was not durably saved.")
  }
}

export type CheckoutSparkRecoverySigningIdentity =
  | GuestOrderSigningIdentity
  | {
      kind: "signed_in"
      pubkey: string
      signer: NostrKeySigner
    }

/** Legacy router plans still require a signed-in external signer. */
export function assertCheckoutSparkRecoverySigningIdentity(
  identity: CheckoutSparkRecoverySigningIdentity
): asserts identity is Extract<
  CheckoutSparkRecoverySigningIdentity,
  { kind: "signed_in" }
> {
  if (identity.kind !== "signed_in") {
    throw new Error(
      "Checkout Spark router recovery requires a signed-in external signer."
    )
  }
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

export async function saveCheckoutSparkRecoveryDelivery(
  recordInput: CheckoutSparkRecoveryDeliveryRecord,
  progressInput: CheckoutSparkRecoveryDeliveryProgress,
  storage: RecoveryStorage | null = browserStorage(),
  now = Date.now()
): Promise<StoredCheckoutSparkRecoveryDelivery> {
  return withCheckoutSparkStorageLock(STORAGE_KEY, () => {
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
  })
}

export async function deleteCheckoutSparkRecoveryDelivery(
  handoffId: string,
  storage: RecoveryStorage | null = browserStorage()
): Promise<void> {
  return withCheckoutSparkStorageLock(STORAGE_KEY, () => {
    writeOutbox(
      readOutbox(storage).filter(
        (delivery) => delivery.record.handoffId !== handoffId
      ),
      storage
    )
  })
}

function assertGuestSettledRecoveryScope(input: {
  identity: GuestOrderSigningIdentity
  plan: CheckoutSparkPlan | CheckoutSparkSettledPlan
  preparedAt: number
  now: number
}): void {
  const { identity, plan, preparedAt, now } = input
  if (
    (plan.schemaVersion !== 3 && plan.schemaVersion !== 4) ||
    identity.orderId !== plan.orderId ||
    identity.merchantPubkey !== plan.merchantPubkey ||
    !HEX_64.test(identity.pubkey) ||
    !Number.isSafeInteger(identity.createdAt) ||
    identity.createdAt <= 0 ||
    !Number.isSafeInteger(identity.expiresAt) ||
    identity.expiresAt - identity.createdAt !== GUEST_ORDER_SESSION_TTL_MS ||
    !Number.isSafeInteger(preparedAt) ||
    preparedAt < identity.createdAt ||
    preparedAt >= identity.expiresAt ||
    !Number.isSafeInteger(now) ||
    now < preparedAt ||
    now >= identity.expiresAt ||
    now >= plan.takeoverAt
  ) {
    throw new Error(
      "Guest checkout recovery is outside its order or session scope."
    )
  }
}

function assertScopedRecoveryInput(input: {
  plan: CheckoutSparkSettledPlan
  recovery: SparkRecoveryBundle
  identity: CheckoutSparkRecoverySigningIdentity
  preparedAt: number
  now: number
}): string {
  if (input.identity.kind === "guest_ephemeral") {
    assertGuestSettledRecoveryScope({ ...input, identity: input.identity })
  } else {
    assertCheckoutSparkRecoverySigningIdentity(input.identity)
  }
  const mnemonic = normalizeSparkMnemonic(input.recovery.mnemonic)
  if (
    !isValidSparkMnemonic(mnemonic) ||
    input.recovery.network !== input.plan.network
  ) {
    throw new Error("Checkout Spark recovery is outside its checkout scope.")
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
  assertCheckoutSparkRecoverySigningIdentity(input.identity)
  const mnemonic = normalizeSparkMnemonic(input.recovery.mnemonic)
  if (
    !isValidSparkMnemonic(mnemonic) ||
    input.recovery.network !== input.plan.network
  ) {
    throw new Error("Checkout Spark recovery is outside its checkout scope.")
  }
  const payload = createCheckoutSparkRecoveryPayload({
    plan: input.plan,
    senderPubkey: input.identity.pubkey,
    mnemonic,
    accountNumber: input.recovery.accountNumber,
    preparedAt,
  })
  return persistAndPublishRecoveryHandoff({
    ...input,
    payload,
    now,
  })
}

/** A v3 snapshot is encrypted for the merchant before its funding invoice is
 * exposed, then again before any later dynamic payout attempt. */
export async function publishCheckoutSparkSettledRecoveryHandoff(input: {
  state: CheckoutSparkSettledReconciliation
  sourceEvents?: readonly SignedPublicNostrEvent[]
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
  const identity = { ...input.identity }
  const mnemonic = assertScopedRecoveryInput({
    plan: input.state.plan,
    recovery: input.recovery,
    identity,
    preparedAt,
    now: now(),
  })
  const payload = createCheckoutSparkSettledRecoveryPayload({
    state: input.state,
    sourceEvents: input.sourceEvents,
    senderPubkey: identity.pubkey,
    mnemonic,
    accountNumber: input.recovery.accountNumber,
    preparedAt,
  })
  return persistAndPublishRecoveryHandoff({
    ...input,
    identity,
    payload,
    now,
  })
}

/**
 * Persist and ACK one buyer-signed, merchant-only progress update without
 * retrieving the checkout wallet phrase from the SDK or browser storage.
 * The exact initial wallet handoff must already be durably ACKed.
 */
type CheckoutSparkSettledSnapshotInput = {
  initialHandoffId: string
  state: CheckoutSparkSettledReconciliation
  identity: CheckoutSparkRecoverySigningIdentity
  preparedAt?: number
  storage?: RecoveryStorage | null
  transport?: CheckoutSparkRecoveryTransportOptions
  now?: () => number
  onPersisted?: (handoffId: string) => void | Promise<void>
}

async function assertAcknowledgedInitialRecovery(
  input: CheckoutSparkSettledSnapshotInput,
  preparedAt: number,
  storage: RecoveryStorage | null
): Promise<CheckoutSparkRecoveryDeliveryRecord> {
  const assertGuestScope = () => {
    if (input.identity.kind === "guest_ephemeral") {
      assertGuestSettledRecoveryScope({
        identity: input.identity,
        plan: input.state.plan,
        preparedAt,
        now: (input.now ?? Date.now)(),
      })
    }
  }
  assertGuestScope()
  const initial = getCheckoutSparkRecoveryDelivery(
    input.initialHandoffId,
    storage
  )
  const plan = input.state.plan
  if (
    !initial ||
    initial.deliveryProgress.acknowledgedRelayRefs.length === 0 ||
    initial.record.checkoutId !== plan.checkoutId ||
    initial.record.orderId !== plan.orderId ||
    initial.record.planDigest !== plan.planDigest ||
    initial.record.walletId !== plan.walletId ||
    initial.record.network !== plan.network ||
    initial.record.senderPubkey !== input.identity.pubkey.toLowerCase() ||
    initial.record.merchantPubkey !== plan.merchantPubkey ||
    (input.identity.kind === "guest_ephemeral" &&
      (input.identity.orderId !== plan.orderId ||
        input.identity.merchantPubkey.toLowerCase() !== plan.merchantPubkey ||
        preparedAt < input.identity.createdAt ||
        preparedAt >= input.identity.expiresAt))
  ) {
    throw new Error("Initial checkout recovery is not ACKed for this plan.")
  }
  const signerPubkey = (
    await input.identity.signer.getPublicKey()
  ).toLowerCase()
  assertGuestScope()
  if (signerPubkey !== initial.record.senderPubkey) {
    throw new Error("Checkout recovery signer changed before progress handoff.")
  }
  return initial.record
}

export async function acknowledgeCheckoutSparkSettledSnapshot(
  input: CheckoutSparkSettledSnapshotInput
): Promise<PublishCheckoutSparkRecoveryHandoffResult> {
  input = {
    ...input,
    identity: { ...input.identity },
    transport: input.transport ? { ...input.transport } : undefined,
  }
  const now = input.now ?? Date.now
  const preparedAt = input.preparedAt ?? now()
  const storage = input.storage === undefined ? browserStorage() : input.storage
  await assertAcknowledgedInitialRecovery(input, preparedAt, storage)
  const payload = createCheckoutSparkSettledRecoveryProgressPayload({
    initialHandoffId: input.initialHandoffId,
    state: input.state,
    senderPubkey: input.identity.pubkey,
    preparedAt,
  })
  return persistAndPublishRecoveryHandoff({
    ...input,
    payload,
    storage,
    now,
  })
}

export interface AcknowledgedCheckoutSparkSettledSnapshot {
  handoffId: string
  deliveryProgress: CheckoutSparkRecoveryDeliveryProgress
  acknowledged: true
  mode: "published" | "reused" | "retried"
}

export interface CheckoutSparkSnapshotRetryLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T>
}

function browserSnapshotRetryLockManager(): CheckoutSparkSnapshotRetryLockManager | null {
  if (typeof navigator === "undefined" || !navigator.locks) return null
  return navigator.locks as CheckoutSparkSnapshotRetryLockManager
}

/**
 * Idempotent progress delivery across refresh: a content-free durable mapping
 * finds the exact previous signed ciphertext for this canonical state. Never
 * create a second wrap after an uncertain relay attempt.
 */
export async function acknowledgeOrRetryCheckoutSparkSettledSnapshot(
  input: Omit<CheckoutSparkSettledSnapshotInput, "onPersisted"> & {
    lockManager?: CheckoutSparkSnapshotRetryLockManager | null
    requireCrossTabLock?: boolean
  }
): Promise<AcknowledgedCheckoutSparkSettledSnapshot> {
  input = {
    ...input,
    identity: { ...input.identity },
    transport: input.transport ? { ...input.transport } : undefined,
  }
  const lockManager =
    input.lockManager === undefined
      ? browserSnapshotRetryLockManager()
      : input.lockManager
  if (!lockManager) {
    if (input.requireCrossTabLock ?? typeof window !== "undefined") {
      throw new Error(
        "This browser cannot safely coordinate checkout recovery across tabs."
      )
    }
    return acknowledgeOrRetryCheckoutSparkSettledSnapshotLocked(input)
  }
  return lockManager.request(
    SNAPSHOT_RETRY_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        throw new Error("Checkout recovery is active in another tab.")
      }
      return acknowledgeOrRetryCheckoutSparkSettledSnapshotLocked(input)
    }
  )
}

async function acknowledgeOrRetryCheckoutSparkSettledSnapshotLocked(
  input: Omit<CheckoutSparkSettledSnapshotInput, "onPersisted">
): Promise<AcknowledgedCheckoutSparkSettledSnapshot> {
  const assertCurrent = () => {
    if (input.identity.kind === "guest_ephemeral") {
      const now = input.now ?? Date.now
      assertGuestSettledRecoveryScope({
        identity: input.identity,
        plan: input.state.plan,
        preparedAt: input.preparedAt ?? now(),
        now: now(),
      })
    }
    if (input.transport?.shouldContinue && !input.transport.shouldContinue()) {
      throw new Error("Checkout recovery account changed before relay ACK.")
    }
  }
  assertCurrent()
  const now = input.now ?? Date.now
  const preparedAt = input.preparedAt ?? now()
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const currentTime = now()
  const initial = await assertAcknowledgedInitialRecovery(
    input,
    Math.max(preparedAt, currentTime),
    storage
  )
  assertCurrent()
  if (
    preparedAt >= input.state.plan.takeoverAt ||
    currentTime >= input.state.plan.takeoverAt
  ) {
    throw new Error(
      "Checkout recovery progress is outside its takeover window."
    )
  }
  const key = deriveCheckoutSparkSettledRecoverySnapshotKey({
    initialHandoffId: input.initialHandoffId,
    state: input.state,
  })
  const existingHandoffId = readSnapshotRetryRegistry(storage)[key]
  if (existingHandoffId) {
    const existing = getCheckoutSparkRecoveryDelivery(
      existingHandoffId,
      storage
    )
    if (
      !existing ||
      existing.record.checkoutId !== initial.checkoutId ||
      existing.record.orderId !== initial.orderId ||
      existing.record.planDigest !== initial.planDigest ||
      existing.record.walletId !== initial.walletId ||
      existing.record.network !== initial.network ||
      existing.record.senderPubkey !== initial.senderPubkey ||
      existing.record.merchantPubkey !== initial.merchantPubkey
    ) {
      throw new Error("Stored checkout recovery progress is incomplete.")
    }
    if (existing.deliveryProgress.acknowledgedRelayRefs.length > 0) {
      assertCurrent()
      return {
        handoffId: existingHandoffId,
        deliveryProgress: existing.deliveryProgress,
        acknowledged: true,
        mode: "reused",
      }
    }
    const retry = await retryStoredCheckoutSparkRecoveryHandoff({
      handoffId: existingHandoffId,
      storage,
      recipientInboxRelays: input.transport?.recipientInboxRelays,
      shouldContinue: () => {
        try {
          assertCurrent()
          return true
        } catch {
          return false
        }
      },
      publishFn: input.transport?.publishFn
        ? (...args) => {
            assertCurrent()
            return input.transport!.publishFn!(...args)
          }
        : undefined,
      now,
    })
    if (!retry.canExposeFundingInvoice) {
      throw new Error("Checkout Spark recovery received no relay ACK.")
    }
    assertCurrent()
    return {
      handoffId: existingHandoffId,
      deliveryProgress: retry.deliveryProgress,
      acknowledged: true,
      mode: "retried",
    }
  }
  const published = await acknowledgeCheckoutSparkSettledSnapshot({
    ...input,
    preparedAt,
    storage,
    now,
    onPersisted: (handoffId) =>
      saveSnapshotRetryMapping({ key, handoffId, storage }),
  })
  assertCurrent()
  return {
    handoffId: published.handoffId,
    deliveryProgress: published.deliveryProgress,
    acknowledged: true,
    mode: "published",
  }
}

async function persistAndPublishRecoveryHandoff(input: {
  payload: CheckoutSparkRecoveryPayload
  identity: CheckoutSparkRecoverySigningIdentity
  storage?: RecoveryStorage | null
  transport?: CheckoutSparkRecoveryTransportOptions
  now: () => number
  onPersisted?: (handoffId: string) => void | Promise<void>
}): Promise<PublishCheckoutSparkRecoveryHandoffResult> {
  const storage = input.storage === undefined ? browserStorage() : input.storage
  const identity = { ...input.identity }
  const callerShouldContinue = input.transport?.shouldContinue
  const assertGuestCurrent = () => {
    if (identity.kind !== "guest_ephemeral") return
    assertGuestSettledRecoveryScope({
      identity,
      plan: input.payload.plan,
      preparedAt: input.payload.preparedAt,
      now: input.now(),
    })
    if (callerShouldContinue?.() === false) {
      throw new Error("Guest checkout recovery session changed.")
    }
  }
  const shouldContinue = () => {
    try {
      assertGuestCurrent()
      return callerShouldContinue?.() !== false
    } catch {
      return false
    }
  }
  assertGuestCurrent()
  const signer =
    identity.kind === "guest_ephemeral"
      ? createGuestCheckoutSparkRecoverySigner(identity, { now: input.now })
      : identity.signer
  if (identity.kind === "guest_ephemeral") {
    const actualPubkey = (await signer.getPublicKey()).toLowerCase()
    assertGuestCurrent()
    if (actualPubkey !== identity.pubkey) {
      throw new Error(
        "Guest checkout recovery signer does not match its sender."
      )
    }
  }
  const publishFn = input.transport?.publishFn
  const transport =
    identity.kind === "guest_ephemeral"
      ? {
          ...input.transport,
          shouldContinue,
          ...(publishFn
            ? {
                publishFn: ((...args) => {
                  assertGuestCurrent()
                  return publishFn(...args)
                }) as typeof publishFn,
              }
            : {}),
        }
      : input.transport
  const persisted = {
    record: null as CheckoutSparkRecoveryDeliveryRecord | null,
  }
  const result = await publishCheckoutSparkRecovery({
    payload: input.payload,
    signer,
    signerInteraction:
      identity.kind === "guest_ephemeral" ? "application_owned" : "external",
    transport,
    persistExactWrap: async (preparedRecord, progress) => {
      assertGuestCurrent()
      persisted.record = preparedRecord
      await saveCheckoutSparkRecoveryDelivery(
        preparedRecord,
        progress,
        storage,
        input.now()
      )
      // A persisted wrap must retain its local recovery/retry link even if the
      // guest session changed during storage. This grants no send authority.
      await input.onPersisted?.(preparedRecord.handoffId)
      assertGuestCurrent()
    },
  })
  const record = persisted.record
  if (!record) {
    throw new Error("Checkout Spark recovery wrapper was not persisted.")
  }
  await saveCheckoutSparkRecoveryDelivery(
    record,
    result.deliveryProgress,
    storage,
    input.now()
  )
  assertGuestCurrent()
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
  await saveCheckoutSparkRecoveryDelivery(
    stored.record,
    result.deliveryProgress,
    storage,
    (input.now ?? Date.now)()
  )
  return result
}
