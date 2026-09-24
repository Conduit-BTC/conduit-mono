import { giftUnwrap, NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

import {
  createCheckoutSparkReconciliation,
  type CheckoutSparkNetwork,
  type CheckoutSparkPlan,
} from "./checkout-spark-reconciliation"
import { EVENT_KINDS } from "./kinds"
import {
  publishPrivateMessage,
  type PreparedPrivateMessageWraps,
  type PublishPrivateMessageInput,
  type PublishPrivateMessageResult,
} from "./messaging"
import { getNdk } from "./ndk"
import { appendConduitClientTag } from "./nip89"
import {
  MAX_DECLARED_INBOX_WRITE_RELAYS,
  resolveInboxDeclaration,
  type ResolveInboxDeclarationOptions,
} from "./private-message-routing"
import {
  publishWithPlanner,
  RelayPublishDiagnosticsError,
  type PublishWithPlannerResult,
} from "./relay-publish"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/
const RECOVERY_HANDOFF_DOMAIN = "conduit:checkout-spark-recovery:v1"
const RECOVERY_RELAY_REF_DOMAIN =
  "conduit:checkout-spark-recovery-relay-target:v1"
const MAX_OPAQUE_ID_LENGTH = 256
const MAX_MNEMONIC_LENGTH = 512
const MAX_RECOVERY_RELAY_REFS = 64

export interface CheckoutSparkRecoveryWallet {
  providerId: "spark"
  walletId: string
  network: CheckoutSparkNetwork
  accountNumber: number
  mnemonic: string
}

/**
 * Checkout-scoped recovery authority sent only inside the standard NIP-59
 * rumor -> seal -> gift-wrap chain. It must never enter generic order state,
 * message caches, logs, telemetry, or user-visible conversation rendering.
 */
export interface CheckoutSparkRecoveryPayload {
  schemaVersion: 1
  type: "checkout_spark_recovery"
  handoffId: string
  senderPubkey: string
  merchantPubkey: string
  preparedAt: number
  plan: CheckoutSparkPlan
  wallet: CheckoutSparkRecoveryWallet
}

export interface CreateCheckoutSparkRecoveryPayloadInput {
  plan: CheckoutSparkPlan
  senderPubkey: string
  mnemonic: string
  accountNumber: number
  preparedAt: number
}

/** Ciphertext-only durable retry descriptor. */
export interface CheckoutSparkRecoveryDeliveryRecord {
  schemaVersion: 1
  handoffId: string
  rumorId: string
  checkoutId: string
  orderId: string
  planDigest: string
  walletId: string
  network: CheckoutSparkNetwork
  senderPubkey: string
  merchantPubkey: string
  signedRecipientWrap: SignedPublicNostrEvent
  createdAt: number
}

export interface CheckoutSparkRecoveryDeliveryProgress {
  schemaVersion: 1
  recipientWrapId: string
  /** URL-free refs for relays that acknowledged this exact signed wrap. */
  acknowledgedRelayRefs: string[]
}

export type PersistCheckoutSparkRecoveryWrap = (
  record: CheckoutSparkRecoveryDeliveryRecord,
  initialProgress: CheckoutSparkRecoveryDeliveryProgress
) => void | Promise<void>

export type CheckoutSparkRecoveryTransportOptions = Pick<
  PublishPrivateMessageInput,
  | "recipientInboxRelays"
  | "resolveInboxRelays"
  | "accountNetworkLocalStateRepository"
  | "giftWrapFn"
  | "publishFn"
  | "refreshRelayLists"
  | "shouldContinue"
>

export type PublishCheckoutSparkRecoveryResult = Omit<
  PublishPrivateMessageResult,
  "orderRelayDelivery"
> & {
  deliveryProgress: CheckoutSparkRecoveryDeliveryProgress
  /** Funding may be shown only after the exact recovery wrap has one ACK. */
  canExposeFundingInvoice: true
}

export interface RetryCheckoutSparkRecoveryResult {
  recipientDelivery: PublishWithPlannerResult | null
  deliveryProgress: CheckoutSparkRecoveryDeliveryProgress
  canExposeFundingInvoice: boolean
}

export type CheckoutSparkRecoveryGiftUnwrap = (
  event: NDKEvent,
  signer: NDKSigner
) => Promise<NDKEvent | null>

function normalizeHex64(value: string, label: string): string {
  const normalized = value.trim().toLowerCase()
  if (!HEX_64.test(normalized)) throw new Error(`${label} is invalid.`)
  return normalized
}

function normalizeOpaqueId(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_OPAQUE_ID_LENGTH) {
    throw new Error(`${label} is invalid.`)
  }
  return normalized
}

function normalizeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function normalizeAccountNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) {
    throw new Error("Checkout Spark recovery account number is invalid.")
  }
  return value
}

function normalizeMnemonic(value: string): string {
  const normalized = value.trim().split(/\s+/u).join(" ")
  if (!normalized || normalized.length > MAX_MNEMONIC_LENGTH) {
    throw new Error("Checkout Spark recovery mnemonic is invalid.")
  }
  return normalized
}

function hashValue(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
}

function canonicalPlan(plan: CheckoutSparkPlan): CheckoutSparkPlan {
  try {
    return createCheckoutSparkReconciliation(plan).plan
  } catch {
    throw new Error("Checkout Spark recovery plan is invalid.")
  }
}

function assertExactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`)
  }
  const keys = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} is invalid.`)
  }
}

function deriveCheckoutSparkRecoveryHandoffId(input: {
  plan: CheckoutSparkPlan
  senderPubkey: string
  preparedAt: number
  accountNumber: number
}): string {
  return hashValue([
    RECOVERY_HANDOFF_DOMAIN,
    input.plan.checkoutId,
    input.plan.orderId,
    input.plan.planDigest,
    input.plan.merchantPubkey,
    input.senderPubkey,
    input.plan.walletId,
    input.plan.network,
    input.accountNumber,
    input.preparedAt,
  ])
}

/** Build and validate the exact recovery authority before any wrapping. */
export function createCheckoutSparkRecoveryPayload(
  input: CreateCheckoutSparkRecoveryPayloadInput
): CheckoutSparkRecoveryPayload {
  const plan = canonicalPlan(input.plan)
  const senderPubkey = normalizeHex64(input.senderPubkey, "Sender pubkey")
  const preparedAt = normalizeTimestamp(input.preparedAt, "Recovery time")
  const accountNumber = normalizeAccountNumber(input.accountNumber)
  const mnemonic = normalizeMnemonic(input.mnemonic)
  if (preparedAt < plan.createdAt || preparedAt >= plan.takeoverAt) {
    throw new Error(
      "Checkout Spark recovery must be prepared before merchant takeover."
    )
  }
  const handoffId = deriveCheckoutSparkRecoveryHandoffId({
    plan,
    senderPubkey,
    preparedAt,
    accountNumber,
  })
  return Object.freeze({
    schemaVersion: 1,
    type: "checkout_spark_recovery",
    handoffId,
    senderPubkey,
    merchantPubkey: plan.merchantPubkey,
    preparedAt,
    plan,
    wallet: Object.freeze({
      providerId: "spark",
      walletId: plan.walletId,
      network: plan.network,
      accountNumber,
      mnemonic,
    }),
  })
}

function parseRecoveryPayload(value: unknown): CheckoutSparkRecoveryPayload {
  assertExactObjectKeys(
    value,
    [
      "schemaVersion",
      "type",
      "handoffId",
      "senderPubkey",
      "merchantPubkey",
      "preparedAt",
      "plan",
      "wallet",
    ],
    "Checkout Spark recovery payload"
  )
  assertExactObjectKeys(
    value.wallet,
    ["providerId", "walletId", "network", "accountNumber", "mnemonic"],
    "Checkout Spark recovery wallet"
  )
  if (
    value.schemaVersion !== 1 ||
    value.type !== "checkout_spark_recovery" ||
    typeof value.handoffId !== "string" ||
    typeof value.senderPubkey !== "string" ||
    typeof value.merchantPubkey !== "string" ||
    typeof value.preparedAt !== "number" ||
    typeof value.wallet.providerId !== "string" ||
    typeof value.wallet.walletId !== "string" ||
    typeof value.wallet.network !== "string" ||
    typeof value.wallet.accountNumber !== "number" ||
    typeof value.wallet.mnemonic !== "string"
  ) {
    throw new Error("Checkout Spark recovery payload is invalid.")
  }
  const candidate = createCheckoutSparkRecoveryPayload({
    plan: value.plan as CheckoutSparkPlan,
    senderPubkey: value.senderPubkey,
    mnemonic: value.wallet.mnemonic,
    accountNumber: value.wallet.accountNumber,
    preparedAt: value.preparedAt,
  })
  if (
    normalizeHex64(value.merchantPubkey, "Merchant pubkey") !==
      candidate.merchantPubkey ||
    normalizeHex64(value.handoffId, "Recovery handoff id") !==
      candidate.handoffId ||
    value.wallet.providerId !== "spark" ||
    normalizeOpaqueId(value.wallet.walletId, "Recovery wallet id") !==
      candidate.wallet.walletId ||
    value.wallet.network !== candidate.wallet.network ||
    JSON.stringify(value.plan) !== JSON.stringify(candidate.plan)
  ) {
    throw new Error("Checkout Spark recovery payload binding is invalid.")
  }
  return candidate
}

function exactTagValue(
  rumor: NDKEvent,
  name: string,
  expected: string
): boolean {
  const matching = (rumor.tags ?? []).filter((tag) => tag[0] === name)
  return matching.length === 1 && matching[0]?.[1] === expected
}

/** Build the unsigned machine-only kind-16 rumor wrapped by NIP-59. */
export function buildCheckoutSparkRecoveryRumor(
  payloadInput: CheckoutSparkRecoveryPayload
): NDKEvent {
  const payload = parseRecoveryPayload(payloadInput)
  const rumor = new NDKEvent(getNdk())
  rumor.kind = EVENT_KINDS.ORDER
  rumor.pubkey = payload.senderPubkey
  rumor.created_at = Math.floor(payload.preparedAt / 1_000)
  rumor.tags = appendConduitClientTag(
    [
      ["p", payload.merchantPubkey],
      ["type", payload.type],
      ["order", payload.plan.orderId],
      ["checkout", payload.plan.checkoutId],
      ["handoff", payload.handoffId],
    ],
    "market"
  )
  rumor.content = JSON.stringify(payload)
  rumor.id = rumor.getEventHash()
  return rumor
}

/** Parse only this dedicated rumor; generic order parsing intentionally ignores it. */
export function parseCheckoutSparkRecoveryRumor(
  rumor: NDKEvent
): CheckoutSparkRecoveryPayload {
  try {
    if (
      rumor.kind !== EVENT_KINDS.ORDER ||
      !HEX_64.test(rumor.id?.toLowerCase() ?? "") ||
      rumor.id.toLowerCase() !== rumor.getEventHash().toLowerCase()
    ) {
      throw new Error("invalid rumor identity")
    }
    const payload = parseRecoveryPayload(JSON.parse(rumor.content))
    if (
      rumor.pubkey.trim().toLowerCase() !== payload.senderPubkey ||
      rumor.created_at !== Math.floor(payload.preparedAt / 1_000) ||
      !exactTagValue(rumor, "p", payload.merchantPubkey) ||
      !exactTagValue(rumor, "type", payload.type) ||
      !exactTagValue(rumor, "order", payload.plan.orderId) ||
      !exactTagValue(rumor, "checkout", payload.plan.checkoutId) ||
      !exactTagValue(rumor, "handoff", payload.handoffId)
    ) {
      throw new Error("invalid rumor binding")
    }
    return payload
  } catch {
    throw new Error("Checkout Spark recovery rumor is invalid.")
  }
}

function hasExactOuterRecipient(
  event: SignedPublicNostrEvent,
  recipientPubkey: string
): boolean {
  const recipients = event.tags.filter(
    (tag) => tag[0] === "p" && typeof tag[1] === "string"
  )
  return (
    recipients.length === 1 &&
    recipients[0]![1]!.toLowerCase() === recipientPubkey.toLowerCase()
  )
}

function signedRecoveryWrap(
  event: NDKEvent,
  merchantPubkey: string
): SignedPublicNostrEvent {
  const signed = event.rawEvent() as SignedPublicNostrEvent
  if (
    signed.kind !== EVENT_KINDS.GIFT_WRAP ||
    !isValidSignedPublicNostrEvent(signed) ||
    !hasExactOuterRecipient(signed, merchantPubkey)
  ) {
    throw new Error("Checkout Spark recovery wrap is invalid.")
  }
  return signed
}

function parseRelayRefs(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_RECOVERY_RELAY_REFS ||
    value.some((entry) => typeof entry !== "string" || !HEX_64.test(entry))
  ) {
    return null
  }
  const normalized = Array.from(new Set(value)).sort()
  return normalized.length === value.length ? normalized : null
}

function recoveryRelayRef(relayUrl: string): string {
  const normalized = normalizeSecureOrIsolatedE2eRelayUrls([relayUrl])[0]
  if (!normalized) throw new Error("Checkout Spark recovery relay is invalid.")
  return hashValue([RECOVERY_RELAY_REF_DOMAIN, normalized])
}

export function createCheckoutSparkRecoveryDeliveryProgress(
  record: CheckoutSparkRecoveryDeliveryRecord
): CheckoutSparkRecoveryDeliveryProgress {
  assertRecoveryDeliveryRecord(record)
  return {
    schemaVersion: 1,
    recipientWrapId: record.signedRecipientWrap.id.toLowerCase(),
    acknowledgedRelayRefs: [],
  }
}

export function parseCheckoutSparkRecoveryDeliveryProgress(
  value: unknown,
  record: CheckoutSparkRecoveryDeliveryRecord
): CheckoutSparkRecoveryDeliveryProgress {
  assertRecoveryDeliveryRecord(record)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted checkout recovery progress is invalid.")
  }
  const candidate = value as CheckoutSparkRecoveryDeliveryProgress
  const refs = parseRelayRefs(candidate.acknowledgedRelayRefs)
  if (
    candidate.schemaVersion !== 1 ||
    !HEX_64.test(candidate.recipientWrapId) ||
    candidate.recipientWrapId !== record.signedRecipientWrap.id.toLowerCase() ||
    !refs
  ) {
    throw new Error("Persisted checkout recovery progress is invalid.")
  }
  return {
    schemaVersion: 1,
    recipientWrapId: candidate.recipientWrapId,
    acknowledgedRelayRefs: refs,
  }
}

export function parseCheckoutSparkRecoveryDeliveryRecord(
  value: unknown
): CheckoutSparkRecoveryDeliveryRecord {
  assertExactObjectKeys(
    value,
    [
      "schemaVersion",
      "handoffId",
      "rumorId",
      "checkoutId",
      "orderId",
      "planDigest",
      "walletId",
      "network",
      "senderPubkey",
      "merchantPubkey",
      "signedRecipientWrap",
      "createdAt",
    ],
    "Persisted checkout recovery record"
  )
  const record = value as unknown as CheckoutSparkRecoveryDeliveryRecord
  if (
    record.schemaVersion !== 1 ||
    !HEX_64.test(record.handoffId) ||
    !HEX_64.test(record.rumorId) ||
    !HEX_64.test(record.planDigest) ||
    !HEX_64.test(record.senderPubkey) ||
    !HEX_64.test(record.merchantPubkey) ||
    !normalizeOpaqueId(record.checkoutId, "Checkout id") ||
    !normalizeOpaqueId(record.orderId, "Order id") ||
    !normalizeOpaqueId(record.walletId, "Wallet id") ||
    (record.network !== "mainnet" && record.network !== "regtest") ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0 ||
    !isValidSignedPublicNostrEvent(record.signedRecipientWrap) ||
    record.signedRecipientWrap.kind !== EVENT_KINDS.GIFT_WRAP ||
    !hasExactOuterRecipient(record.signedRecipientWrap, record.merchantPubkey)
  ) {
    throw new Error("Persisted checkout recovery record is invalid.")
  }
  return record
}

function assertRecoveryDeliveryRecord(
  record: CheckoutSparkRecoveryDeliveryRecord
): void {
  parseCheckoutSparkRecoveryDeliveryRecord(record)
}

function buildRecoveryDeliveryRecord(
  payload: CheckoutSparkRecoveryPayload,
  prepared: PreparedPrivateMessageWraps
): CheckoutSparkRecoveryDeliveryRecord {
  if (prepared.wrappedToSelf) {
    throw new Error("Checkout Spark recovery must not create a sender copy.")
  }
  const record: CheckoutSparkRecoveryDeliveryRecord = {
    schemaVersion: 1,
    handoffId: payload.handoffId,
    rumorId: prepared.rumorId.toLowerCase(),
    checkoutId: payload.plan.checkoutId,
    orderId: payload.plan.orderId,
    planDigest: payload.plan.planDigest,
    walletId: payload.plan.walletId,
    network: payload.plan.network,
    senderPubkey: payload.senderPubkey,
    merchantPubkey: payload.merchantPubkey,
    signedRecipientWrap: signedRecoveryWrap(
      prepared.wrappedToRecipient,
      payload.merchantPubkey
    ),
    createdAt: payload.preparedAt,
  }
  assertRecoveryDeliveryRecord(record)
  return record
}

function mergeAcknowledgedRelayRefs(input: {
  existing: readonly string[]
  attemptedRelayUrls: readonly string[]
  successfulRelayUrls: readonly string[]
}): string[] {
  const attempted = new Set(
    normalizeSecureOrIsolatedE2eRelayUrls(input.attemptedRelayUrls)
  )
  const additions = normalizeSecureOrIsolatedE2eRelayUrls(
    input.successfulRelayUrls
  )
    .filter((relayUrl) => attempted.has(relayUrl))
    .map(recoveryRelayRef)
  const merged = Array.from(new Set([...input.existing, ...additions])).sort()
  if (merged.length > MAX_RECOVERY_RELAY_REFS) {
    throw new Error("Checkout Spark recovery relay progress exceeds its limit.")
  }
  return merged
}

/**
 * Persist the exact signed ciphertext before relay I/O. One recipient ACK is
 * the hard gate for exposing the checkout funding invoice.
 */
export async function publishCheckoutSparkRecovery(input: {
  payload: CheckoutSparkRecoveryPayload
  signer: NDKSigner
  signerInteraction?: PublishPrivateMessageInput["signerInteraction"]
  persistExactWrap: PersistCheckoutSparkRecoveryWrap
  transport?: CheckoutSparkRecoveryTransportOptions
}): Promise<PublishCheckoutSparkRecoveryResult> {
  const payload = parseRecoveryPayload(input.payload)
  const rumor = buildCheckoutSparkRecoveryRumor(payload)
  const transport = input.transport
  let persistedRecord: CheckoutSparkRecoveryDeliveryRecord | null = null
  const result = await publishPrivateMessage({
    rumor,
    senderPubkey: payload.senderPubkey,
    recipientPubkey: payload.merchantPubkey,
    signer: input.signer,
    rumorKind: EVENT_KINDS.ORDER,
    selfCopy: false,
    ...(transport?.recipientInboxRelays
      ? { recipientInboxRelays: transport.recipientInboxRelays }
      : {}),
    ...(transport?.resolveInboxRelays
      ? { resolveInboxRelays: transport.resolveInboxRelays }
      : {}),
    ...(transport?.accountNetworkLocalStateRepository
      ? {
          accountNetworkLocalStateRepository:
            transport.accountNetworkLocalStateRepository,
        }
      : {}),
    ...(transport?.giftWrapFn ? { giftWrapFn: transport.giftWrapFn } : {}),
    ...(transport?.publishFn ? { publishFn: transport.publishFn } : {}),
    ...(transport?.refreshRelayLists !== undefined
      ? { refreshRelayLists: transport.refreshRelayLists }
      : {}),
    ...(transport?.shouldContinue
      ? { shouldContinue: transport.shouldContinue }
      : {}),
    signerInteraction: input.signerInteraction ?? "application_owned",
    // Recovery traffic never uses the compatibility order relay lane.
    onWrapped: async (prepared) => {
      const record = buildRecoveryDeliveryRecord(payload, prepared)
      await input.persistExactWrap(
        record,
        createCheckoutSparkRecoveryDeliveryProgress(record)
      )
      persistedRecord = record
    },
  })
  if (!persistedRecord) {
    throw new Error("Checkout Spark recovery wrap was not persisted.")
  }
  const deliveryProgress =
    createCheckoutSparkRecoveryDeliveryProgress(persistedRecord)
  deliveryProgress.acknowledgedRelayRefs = mergeAcknowledgedRelayRefs({
    existing: [],
    attemptedRelayUrls: result.recipientDelivery.attemptedRelayUrls,
    successfulRelayUrls: result.recipientDelivery.successfulRelayUrls,
  })
  if (deliveryProgress.acknowledgedRelayRefs.length === 0) {
    throw new Error("Checkout Spark recovery received no relay ACK.")
  }
  // This machine-only envelope must not acquire a generic order-delivery
  // descriptor that a caller could accidentally attach to conversation state.
  const { orderRelayDelivery: discardedOrderDelivery, ...privateDelivery } =
    result
  void discardedOrderDelivery
  return {
    ...privateDelivery,
    deliveryProgress,
    canExposeFundingInvoice: true,
  }
}

async function currentRecipientRelays(input: {
  merchantPubkey: string
  recipientInboxRelays?: readonly string[]
  inboxDeclarationOptions?: ResolveInboxDeclarationOptions
}): Promise<string[]> {
  if (input.recipientInboxRelays) {
    return normalizeSecureOrIsolatedE2eRelayUrls(
      input.recipientInboxRelays
    ).slice(0, MAX_DECLARED_INBOX_WRITE_RELAYS)
  }
  const declaration = await resolveInboxDeclaration(
    input.merchantPubkey,
    input.inboxDeclarationOptions
  )
  if (declaration.state !== "declared") {
    throw new Error("Merchant private-message inbox is not currently usable.")
  }
  return normalizeSecureOrIsolatedE2eRelayUrls(declaration.relayUrls).slice(
    0,
    MAX_DECLARED_INBOX_WRITE_RELAYS
  )
}

function recoverPartialPublish(
  error: unknown
): PublishWithPlannerResult | null {
  return error instanceof RelayPublishDiagnosticsError &&
    error.diagnostics.successfulRelayUrls.length > 0
    ? error.diagnostics
    : null
}

/** Retry the same signed ciphertext; never re-encrypt or re-sign recovery data. */
export async function retryCheckoutSparkRecoveryDelivery(input: {
  record: CheckoutSparkRecoveryDeliveryRecord
  deliveryProgress: CheckoutSparkRecoveryDeliveryProgress
  recipientInboxRelays?: readonly string[]
  inboxDeclarationOptions?: ResolveInboxDeclarationOptions
  shouldContinue?: () => boolean
  publishFn?: typeof publishWithPlanner
}): Promise<RetryCheckoutSparkRecoveryResult> {
  assertRecoveryDeliveryRecord(input.record)
  let deliveryProgress = parseCheckoutSparkRecoveryDeliveryProgress(
    input.deliveryProgress,
    input.record
  )
  const relayUrls = await currentRecipientRelays({
    merchantPubkey: input.record.merchantPubkey,
    recipientInboxRelays: input.recipientInboxRelays,
    inboxDeclarationOptions: input.inboxDeclarationOptions,
  })
  if (relayUrls.length === 0) {
    throw new Error("Merchant private-message inbox is not currently usable.")
  }
  const acknowledged = new Set(deliveryProgress.acknowledgedRelayRefs)
  const pendingRelayUrls = relayUrls.filter(
    (relayUrl) => !acknowledged.has(recoveryRelayRef(relayUrl))
  )
  let recipientDelivery: PublishWithPlannerResult | null = null
  if (pendingRelayUrls.length > 0) {
    try {
      recipientDelivery = await (input.publishFn ?? publishWithPlanner)(
        new NDKEvent(getNdk(), input.record.signedRecipientWrap),
        {
          intent: "recipient_event",
          authorPubkey: input.record.senderPubkey,
          recipientPubkeys: [input.record.merchantPubkey],
          exclusiveRelayUrls: pendingRelayUrls,
          deliveryMode: "critical",
          shouldContinue:
            input.shouldContinue ??
            input.inboxDeclarationOptions?.shouldContinue,
        }
      )
    } catch (error) {
      const partial = recoverPartialPublish(error)
      if (!partial) throw error
      recipientDelivery = partial
    }
    deliveryProgress = {
      ...deliveryProgress,
      acknowledgedRelayRefs: mergeAcknowledgedRelayRefs({
        existing: deliveryProgress.acknowledgedRelayRefs,
        attemptedRelayUrls: pendingRelayUrls,
        successfulRelayUrls: recipientDelivery.successfulRelayUrls,
      }),
    }
  }
  return {
    recipientDelivery,
    deliveryProgress,
    canExposeFundingInvoice: deliveryProgress.acknowledgedRelayRefs.length > 0,
  }
}

function sameRecoveredBinding(
  payload: CheckoutSparkRecoveryPayload,
  record: CheckoutSparkRecoveryDeliveryRecord,
  rumorId: string
): boolean {
  return (
    rumorId.toLowerCase() === record.rumorId &&
    payload.handoffId === record.handoffId &&
    payload.plan.checkoutId === record.checkoutId &&
    payload.plan.orderId === record.orderId &&
    payload.plan.planDigest === record.planDigest &&
    payload.plan.walletId === record.walletId &&
    payload.plan.network === record.network &&
    payload.senderPubkey === record.senderPubkey &&
    payload.merchantPubkey === record.merchantPubkey &&
    payload.preparedAt === record.createdAt
  )
}

export interface OpenCheckoutSparkRecoveryWrapResult {
  wrapId: string
  rumorId: string
  payload: CheckoutSparkRecoveryPayload
}

export type InspectCheckoutSparkRecoveryWrapOutcome =
  | ({ status: "ok" } & OpenCheckoutSparkRecoveryWrapResult)
  | { status: "ignored"; wrapId: string }
  | { status: "decrypt_failed"; wrapId: string }
  | { status: "malformed"; wrapId: string }

/**
 * Inspect a merchant inbox wrap without feeding recovery material into the
 * generic message classifier. Ordinary NIP-17 traffic is returned as ignored;
 * failures remain content-free so callers can retry safely.
 */
export async function inspectCheckoutSparkRecoveryWrap(input: {
  signedRecipientWrap: SignedPublicNostrEvent
  signer: NDKSigner
  giftUnwrap?: CheckoutSparkRecoveryGiftUnwrap
}): Promise<InspectCheckoutSparkRecoveryWrapOutcome> {
  const wrapId = input.signedRecipientWrap.id?.toLowerCase() ?? ""
  if (
    !isValidSignedPublicNostrEvent(input.signedRecipientWrap) ||
    input.signedRecipientWrap.kind !== EVENT_KINDS.GIFT_WRAP
  ) {
    return { status: "malformed", wrapId }
  }
  const signerPubkey = normalizeHex64(
    (await input.signer.user()).pubkey,
    "Recovery signer pubkey"
  )
  if (!hasExactOuterRecipient(input.signedRecipientWrap, signerPubkey)) {
    throw new Error("Checkout Spark recovery signer is not the merchant.")
  }
  const wrapped = new NDKEvent(getNdk(), input.signedRecipientWrap)
  let rumor: NDKEvent | null
  try {
    rumor = input.giftUnwrap
      ? await input.giftUnwrap(wrapped, input.signer)
      : await giftUnwrap(wrapped, undefined, input.signer, "nip44")
  } catch {
    rumor = null
  }
  if (!rumor) return { status: "decrypt_failed", wrapId }
  const typeTags = (rumor.tags ?? []).filter((tag) => tag[0] === "type")
  if (
    rumor.kind !== EVENT_KINDS.ORDER ||
    typeTags.length !== 1 ||
    typeTags[0]?.[1] !== "checkout_spark_recovery"
  ) {
    return { status: "ignored", wrapId }
  }
  try {
    const payload = parseCheckoutSparkRecoveryRumor(rumor)
    if (payload.merchantPubkey !== signerPubkey) {
      return { status: "malformed", wrapId }
    }
    return {
      status: "ok",
      wrapId,
      rumorId: rumor.id.toLowerCase(),
      payload,
    }
  } catch {
    return { status: "malformed", wrapId }
  }
}

/**
 * Open a recipient-side wrap without requiring the sender's local retry
 * descriptor. The exact outer recipient is checked before decryption and the
 * inner payload then binds the sender, merchant, wallet, and immutable plan.
 */
export async function openCheckoutSparkRecoveryWrap(input: {
  signedRecipientWrap: SignedPublicNostrEvent
  signer: NDKSigner
  giftUnwrap?: CheckoutSparkRecoveryGiftUnwrap
}): Promise<OpenCheckoutSparkRecoveryWrapResult> {
  const outcome = await inspectCheckoutSparkRecoveryWrap(input)
  if (outcome.status === "decrypt_failed") {
    throw new Error("Checkout Spark recovery could not be unwrapped.")
  }
  if (outcome.status !== "ok") {
    throw new Error("Checkout Spark recovery wrap is invalid.")
  }
  return {
    wrapId: outcome.wrapId,
    rumorId: outcome.rumorId,
    payload: outcome.payload,
  }
}

/**
 * Merchant-only recovery boundary. The returned mnemonic stays in the caller's
 * recovery adapter and must not enter ordinary message/order persistence.
 */
export async function openCheckoutSparkRecoveryDelivery(input: {
  record: CheckoutSparkRecoveryDeliveryRecord
  signer: NDKSigner
  giftUnwrap?: CheckoutSparkRecoveryGiftUnwrap
}): Promise<CheckoutSparkRecoveryPayload> {
  assertRecoveryDeliveryRecord(input.record)
  const opened = await openCheckoutSparkRecoveryWrap({
    signedRecipientWrap: input.record.signedRecipientWrap,
    signer: input.signer,
    giftUnwrap: input.giftUnwrap,
  })
  if (!sameRecoveredBinding(opened.payload, input.record, opened.rumorId)) {
    throw new Error("Checkout Spark recovery delivery binding is invalid.")
  }
  return opened.payload
}
