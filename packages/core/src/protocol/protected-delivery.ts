import {
  NDKUser,
  giftWrap,
  type NDKEvent,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import {
  db,
  type ProtectedDeliveryConfirmationState,
  type ProtectedDeliveryFailureCategory,
  type ProtectedDeliveryIntent,
  type ProtectedDeliveryPriorityClass,
  type ProtectedDeliveryRecipientRole,
  type ProtectedDeliveryRelayOutcomeStatus,
  type ProtectedDeliveryRelayPolicy,
  type ProtectedDeliverySourceRationale,
  type ProtectedDeliveryState,
  type ProtectedDeliverySurface,
  type StoredProtectedDeliveryRecord,
  type StoredProtectedDeliveryRelayOutcome,
} from "../db"
import { config } from "../config"
import { EVENT_KINDS } from "./kinds"
import {
  RelayPublishDiagnosticsError,
  planPublishRelays,
  publishWithPlanner,
  type PublishWithPlannerInput,
  type PublishWithPlannerResult,
} from "./relay-publish"
import type { RelayWritePlan } from "./relay-planner"
import { tryNormalizeRelayUrl } from "./relay-settings"

export type {
  ProtectedDeliveryConfirmationState,
  ProtectedDeliveryFailureCategory,
  ProtectedDeliveryIntent,
  ProtectedDeliveryPriorityClass,
  ProtectedDeliveryRecipientRole,
  ProtectedDeliveryRelayOutcomeStatus,
  ProtectedDeliveryRelayPolicy,
  ProtectedDeliverySourceRationale,
  ProtectedDeliveryState,
  ProtectedDeliverySurface,
  StoredProtectedDeliveryRecord,
  StoredProtectedDeliveryRelayOutcome,
}

const PRODUCT_COORDINATE_RE = /^30402:[0-9a-f]{64}:.+$/i
const DEFAULT_REQUIRED_ACK_COUNT = 1
const DEFAULT_MAX_RETRY_COUNT = 5
const DEFAULT_RETRY_DELAY_MS = 30_000
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000
const PUBLISHING_STALE_MS = 60_000

const RETRYABLE_STATES = new Set<ProtectedDeliveryState>([
  "queued",
  "publishing",
  "partially_delivered",
  "retry_needed",
])

export interface CreateProtectedDeliveryRecordInput {
  id?: string
  orderId?: string
  conversationId?: string
  senderPubkey: string
  recipientPubkey: string
  recipientRole: ProtectedDeliveryRecipientRole
  surface: ProtectedDeliverySurface
  intent: ProtectedDeliveryIntent
  priorityClass?: ProtectedDeliveryPriorityClass
  productCoordinates?: readonly string[]
  signedWrapEventId: string
  signedWrapEventKind?: number
  signedWrapEventJson: string
  localRumorId?: string
  sourceRationale: readonly ProtectedDeliverySourceRationale[]
  plannedRelayUrls: readonly string[]
  requiredRelayUrls?: readonly string[]
  recipientRelayPolicy?: ProtectedDeliveryRelayPolicy
  requiredAckCount?: number
  allowSelfCopyFailure?: boolean
  maxRetryCount?: number
  retryDelayMs?: number
  maxRetryDelayMs?: number
  now?: number
}

export interface ProtectedDeliveryBatchProjection {
  overallState: ProtectedDeliveryState
  confirmationState: ProtectedDeliveryConfirmationState
  primaryRecipientState: ProtectedDeliveryState
  requiredDelivered: boolean
  selfCopyState?: ProtectedDeliveryState
  selfCopyRetryNeeded: boolean
  retryNeededRecordIds: string[]
}

export interface ProtectedDeliveryDiagnostics {
  id: string
  orderId?: string
  conversationId?: string
  surface: ProtectedDeliverySurface
  intent: ProtectedDeliveryIntent
  recipientRole: ProtectedDeliveryRecipientRole
  priorityClass: ProtectedDeliveryPriorityClass
  signedWrapEventId: string
  signedWrapEventKind: number
  deliveryState: ProtectedDeliveryState
  confirmationState: ProtectedDeliveryConfirmationState
  plannedRelayCount: number
  requiredRelayCount: number
  attemptedRelayCount: number
  ackedRelayCount: number
  failedRelayCount: number
  failureCategories: ProtectedDeliveryFailureCategory[]
  retryCount: number
  nextRetryAt?: number
  updatedAt: number
  sourceRationale: ProtectedDeliverySourceRationale[]
}

export interface ExecuteProtectedDeliveryRecordInput {
  record: StoredProtectedDeliveryRecord
  event: NDKEvent
  publishInput: PublishWithPlannerInput
  resolvedPlan?: RelayWritePlan
  persistQueued?: boolean
  throwOnPolicyFailure?: boolean
  now?: number
}

export interface DeliverProtectedOrderMessageInput {
  rumor: NDKEvent
  signer: NDKSigner | undefined
  orderId: string
  intent?: ProtectedDeliveryIntent
  senderPubkey: string
  recipientPubkey: string
  selfCopyPubkey?: string
  productCoordinates: readonly string[]
  surface?: ProtectedDeliverySurface
  now?: number
}

export interface ProtectedOrderMessageDeliveryResult {
  primaryRecord: StoredProtectedDeliveryRecord
  selfCopyRecord: StoredProtectedDeliveryRecord
  selfCopyError: string | null
}

interface ProtectedDeliveryTestOverrides {
  putRecord?: (record: StoredProtectedDeliveryRecord) => Promise<void>
  getRecords?: () => Promise<StoredProtectedDeliveryRecord[]>
  planPublishRelays?: (
    input: PublishWithPlannerInput
  ) => Promise<RelayWritePlan>
  publishWithPlanner?: (
    event: NDKEvent,
    input: PublishWithPlannerInput
  ) => Promise<PublishWithPlannerResult>
  now?: () => number
}

let testOverrides: ProtectedDeliveryTestOverrides = {}

export function __setProtectedDeliveryTestOverrides(
  overrides: Partial<ProtectedDeliveryTestOverrides>
): void {
  testOverrides = { ...testOverrides, ...overrides }
}

export function __resetProtectedDeliveryTestOverrides(): void {
  testOverrides = {}
}

function nowMs(inputNow?: number): number {
  return inputNow ?? testOverrides.now?.() ?? Date.now()
}

function assertNonEmpty(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`Protected delivery ${field} is required`)
  }
  return trimmed
}

function normalizeRelayUrls(
  urls: readonly (string | null | undefined)[]
): string[] {
  const seen = new Set<string>()
  const normalizedUrls: string[] = []
  for (const url of urls) {
    if (!url) continue
    const normalized = tryNormalizeRelayUrl(url)
    if (!normalized.ok || seen.has(normalized.url)) continue
    seen.add(normalized.url)
    normalizedUrls.push(normalized.url)
  }
  return normalizedUrls
}

function mergeRelayUrls(
  ...groups: Array<readonly (string | null | undefined)[] | undefined>
): string[] {
  const merged: string[] = []
  for (const group of groups) merged.push(...normalizeRelayUrls(group ?? []))
  return normalizeRelayUrls(merged)
}

function dedupeSourceRationale(
  values: readonly ProtectedDeliverySourceRationale[]
): ProtectedDeliverySourceRationale[] {
  return Array.from(new Set(values))
}

function normalizeProductCoordinates(
  coordinates: readonly string[] | undefined
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const coordinate of coordinates ?? []) {
    const normalized = coordinate.trim()
    if (!normalized) continue
    if (!isFullProductCoordinate(normalized)) {
      throw new Error(
        "Protected delivery product references must use full 30402:<pubkey>:<d> coordinates"
      )
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function createRecordId(input: {
  surface: ProtectedDeliverySurface
  intent: ProtectedDeliveryIntent
  recipientRole: ProtectedDeliveryRecipientRole
  signedWrapEventId: string
}): string {
  return [
    "protected",
    input.surface,
    input.intent,
    input.recipientRole,
    input.signedWrapEventId,
  ].join(":")
}

function eventJson(input: NDKEvent): {
  id: string
  kind: number
  json: string
} {
  const raw = input.rawEvent()
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new Error("Protected delivery signed wrap is missing an event id")
  }
  if (typeof raw.kind !== "number") {
    throw new Error("Protected delivery signed wrap is missing an event kind")
  }
  return {
    id: raw.id,
    kind: raw.kind,
    json: JSON.stringify(raw),
  }
}

function prepareOrderRumor(rumor: NDKEvent, senderPubkey: string): void {
  rumor.pubkey = senderPubkey
  if (rumor.id) return
  rumor.id = rumor.getEventHash()
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback
  return Math.max(0, Math.trunc(value))
}

function normalizePositiveCount(
  value: number | undefined,
  fallback: number
): number {
  return Math.max(1, normalizeCount(value, fallback))
}

function assertSignedWrapEventJson(input: {
  signedWrapEventJson: string
  signedWrapEventId: string
  signedWrapEventKind: number
}): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.signedWrapEventJson)
  } catch {
    throw new Error("Protected delivery signed wrap event JSON is invalid")
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "Protected delivery signed wrap event JSON must be an event"
    )
  }

  const event = parsed as { id?: unknown; kind?: unknown }
  if (typeof event.id === "string" && event.id !== input.signedWrapEventId) {
    throw new Error("Protected delivery signed wrap event id mismatch")
  }
  if (
    typeof event.kind === "number" &&
    event.kind !== input.signedWrapEventKind
  ) {
    throw new Error("Protected delivery signed wrap event kind mismatch")
  }
}

function classifyRelayFailure(
  message: string | undefined
): ProtectedDeliveryFailureCategory {
  if (!message) return "relay_timeout"
  const lower = message.toLowerCase()
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("no acknowledgement")
  ) {
    return "relay_timeout"
  }
  if (lower.includes("auth")) return "relay_auth_required"
  if (lower.includes("rate") || lower.includes("limit")) {
    return "relay_rate_limited"
  }
  return "relay_rejected"
}

function failureCategoryFromError(
  error: unknown
): ProtectedDeliveryFailureCategory {
  if (error instanceof RelayPublishDiagnosticsError) {
    const messages = Object.values(error.diagnostics.relayFailureMessages)
    return messages.length > 0
      ? classifyRelayFailure(messages.at(-1))
      : "publish_error"
  }
  if (error instanceof Error) return classifyRelayFailure(error.message)
  return "publish_error"
}

function outcomeStatusForFailure(
  failureCategory: ProtectedDeliveryFailureCategory
): ProtectedDeliveryRelayOutcomeStatus {
  return failureCategory === "relay_timeout" ? "timeout" : "rejected"
}

function mergeRelayOutcomes(
  existing: readonly StoredProtectedDeliveryRelayOutcome[],
  next: readonly StoredProtectedDeliveryRelayOutcome[]
): StoredProtectedDeliveryRelayOutcome[] {
  const byRelay = new Map<string, StoredProtectedDeliveryRelayOutcome>()
  for (const outcome of existing) byRelay.set(outcome.relayUrl, outcome)
  for (const outcome of next) byRelay.set(outcome.relayUrl, outcome)
  return Array.from(byRelay.values())
}

function countStatuses(
  outcomes: readonly StoredProtectedDeliveryRelayOutcome[],
  status: ProtectedDeliveryRelayOutcomeStatus
): number {
  return outcomes.filter((outcome) => outcome.status === status).length
}

function hasRequiredDelivery(record: StoredProtectedDeliveryRecord): boolean {
  if (record.deliveryState === "delivered_required") return true
  const requiredRelays = new Set(record.requiredRelayUrls)
  const qualifyingAcks = record.relayOutcomes.filter((outcome) => {
    if (outcome.status !== "acked") return false
    return requiredRelays.size === 0 || requiredRelays.has(outcome.relayUrl)
  }).length
  return qualifyingAcks >= record.requiredAckCount
}

function scheduleNextRetry(input: {
  record: StoredProtectedDeliveryRecord
  retryCount: number
  now: number
}): number {
  const multiplier = Math.max(1, 2 ** Math.max(0, input.retryCount - 1))
  const delay = Math.min(
    input.record.retryDelayMs * multiplier,
    input.record.maxRetryDelayMs
  )
  return input.now + delay
}

function markProtectedDeliveryAttemptFailed(
  record: StoredProtectedDeliveryRecord,
  failureCategory: ProtectedDeliveryFailureCategory,
  now: number = nowMs()
): StoredProtectedDeliveryRecord {
  const nextRetryCount = record.retryCount + 1
  const retryExhausted = nextRetryCount >= record.maxRetryCount
  return {
    ...record,
    deliveryState: retryExhausted ? "failed" : "retry_needed",
    retryCount: nextRetryCount,
    lastFailureCategory: failureCategory,
    nextRetryAt: retryExhausted
      ? undefined
      : scheduleNextRetry({
          record,
          retryCount: nextRetryCount,
          now,
        }),
    updatedAt: now,
  }
}

function collapseStates(
  records: readonly StoredProtectedDeliveryRecord[]
): ProtectedDeliveryState {
  if (records.length === 0) return "queued"
  if (records.some((record) => hasRequiredDelivery(record))) {
    return "delivered_required"
  }
  if (
    records.some((record) => record.deliveryState === "partially_delivered")
  ) {
    return "partially_delivered"
  }
  if (records.some((record) => record.deliveryState === "publishing")) {
    return "publishing"
  }
  if (records.some((record) => record.deliveryState === "retry_needed")) {
    return "retry_needed"
  }
  if (records.every((record) => record.deliveryState === "failed")) {
    return "failed"
  }
  return "queued"
}

function strongestConfirmationState(
  records: readonly StoredProtectedDeliveryRecord[]
): ProtectedDeliveryConfirmationState {
  if (records.some((record) => record.confirmationState === "confirmed")) {
    return "confirmed"
  }
  if (
    records.some(
      (record) => record.confirmationState === "observed_via_read_path"
    )
  ) {
    return "observed_via_read_path"
  }
  if (records.some((record) => record.confirmationState === "acked_by_relay")) {
    return "acked_by_relay"
  }
  return "unconfirmed"
}

function isRetryableRecord(
  record: StoredProtectedDeliveryRecord,
  now: number
): boolean {
  if (!RETRYABLE_STATES.has(record.deliveryState)) return false
  if (record.deliveryState === "publishing") {
    return (
      (record.lastAttemptAt ?? record.updatedAt) <= now - PUBLISHING_STALE_MS
    )
  }
  return record.nextRetryAt === undefined || record.nextRetryAt <= now
}

function sourceRationaleForPlan(input: {
  plan: RelayWritePlan
  recipientRole: ProtectedDeliveryRecipientRole
}): ProtectedDeliverySourceRationale[] {
  const commerceFallbackRelays = new Set(
    normalizeRelayUrls(config.commerceDmFallbackRelayUrls)
  )
  const appWriteRelays = new Set(normalizeRelayUrls(config.appWriteRelayUrls))
  const primaryUsesFallback = input.plan.primaryRelayUrls.some((url) =>
    commerceFallbackRelays.has(url)
  )
  const broadcastUsesAppWrite = input.plan.broadcastRelayUrls.some((url) =>
    appWriteRelays.has(url)
  )
  const rationale: ProtectedDeliverySourceRationale[] = []

  if (input.recipientRole === "primary_recipient") {
    if (primaryUsesFallback) rationale.push("commerce_dm_fallback")
    if (!primaryUsesFallback || input.plan.primaryRelayUrls.length > 0) {
      rationale.push("recipient_nip17_10050")
    }
  } else {
    rationale.push("recipient_nip17_10050", "sender_write_relay")
  }
  if (broadcastUsesAppWrite) rationale.push("app_write_relay")
  if (input.plan.broadcastRelayUrls.length > 0)
    rationale.push("sender_write_relay")
  if (rationale.length === 0) rationale.push("local_retry")

  return dedupeSourceRationale(rationale)
}

function requiredRelayUrlsForPlan(input: {
  plan: RelayWritePlan
  recipientRole: ProtectedDeliveryRecipientRole
}): string[] {
  if (input.recipientRole === "primary_recipient") {
    return mergeRelayUrls(
      input.plan.primaryRelayUrls,
      config.commerceDmFallbackRelayUrls
    )
  }
  return normalizeRelayUrls(input.plan.primaryRelayUrls)
}

async function resolvePublishPlan(
  input: PublishWithPlannerInput
): Promise<RelayWritePlan> {
  return testOverrides.planPublishRelays
    ? await testOverrides.planPublishRelays(input)
    : await planPublishRelays(input)
}

async function publishPlannedEvent(
  event: NDKEvent,
  input: PublishWithPlannerInput
): Promise<PublishWithPlannerResult> {
  return testOverrides.publishWithPlanner
    ? await testOverrides.publishWithPlanner(event, input)
    : await publishWithPlanner(event, input)
}

function createProtectedDeliveryRecordFromWrap(input: {
  wrappedEvent: NDKEvent
  orderId: string
  localRumorId?: string
  senderPubkey: string
  recipientPubkey: string
  recipientRole: ProtectedDeliveryRecipientRole
  surface: ProtectedDeliverySurface
  intent: ProtectedDeliveryIntent
  productCoordinates: readonly string[]
  plan: RelayWritePlan
  now?: number
}): StoredProtectedDeliveryRecord {
  const signedWrap = eventJson(input.wrappedEvent)
  const plannedRelayUrls = mergeRelayUrls(
    input.plan.primaryRelayUrls,
    input.plan.broadcastRelayUrls,
    config.commerceDmFallbackRelayUrls
  )

  return createProtectedDeliveryRecord({
    orderId: input.orderId,
    senderPubkey: input.senderPubkey,
    recipientPubkey: input.recipientPubkey,
    recipientRole: input.recipientRole,
    surface: input.surface,
    intent: input.intent,
    productCoordinates: input.productCoordinates,
    signedWrapEventId: signedWrap.id,
    signedWrapEventKind: signedWrap.kind,
    signedWrapEventJson: signedWrap.json,
    localRumorId: input.localRumorId,
    sourceRationale: sourceRationaleForPlan({
      plan: input.plan,
      recipientRole: input.recipientRole,
    }),
    plannedRelayUrls,
    requiredRelayUrls: requiredRelayUrlsForPlan({
      plan: input.plan,
      recipientRole: input.recipientRole,
    }),
    recipientRelayPolicy: "nip17_order",
    requiredAckCount: DEFAULT_REQUIRED_ACK_COUNT,
    allowSelfCopyFailure: input.recipientRole === "self_copy",
    now: input.now,
  })
}

export function isFullProductCoordinate(value: string): boolean {
  return PRODUCT_COORDINATE_RE.test(value.trim())
}

export function createProtectedDeliveryRecord(
  input: CreateProtectedDeliveryRecordInput
): StoredProtectedDeliveryRecord {
  const createdAt = nowMs(input.now)
  const senderPubkey = assertNonEmpty(input.senderPubkey, "senderPubkey")
  const recipientPubkey = assertNonEmpty(
    input.recipientPubkey,
    "recipientPubkey"
  )
  const signedWrapEventId = assertNonEmpty(
    input.signedWrapEventId,
    "signedWrapEventId"
  )
  const signedWrapEventJson = assertNonEmpty(
    input.signedWrapEventJson,
    "signedWrapEventJson"
  )
  const signedWrapEventKind = input.signedWrapEventKind ?? EVENT_KINDS.GIFT_WRAP
  if (signedWrapEventKind !== EVENT_KINDS.GIFT_WRAP) {
    throw new Error("Protected delivery records must store NIP-59 gift wraps")
  }
  assertSignedWrapEventJson({
    signedWrapEventJson,
    signedWrapEventId,
    signedWrapEventKind,
  })
  const plannedRelayUrls = normalizeRelayUrls(input.plannedRelayUrls)
  const requiredRelayUrls = normalizeRelayUrls(
    input.requiredRelayUrls ?? plannedRelayUrls
  )
  const sourceRationale = dedupeSourceRationale(input.sourceRationale)
  if (sourceRationale.length === 0) {
    throw new Error("Protected delivery source rationale is required")
  }

  return {
    id:
      input.id ??
      createRecordId({
        surface: input.surface,
        intent: input.intent,
        recipientRole: input.recipientRole,
        signedWrapEventId,
      }),
    orderId: input.orderId,
    conversationId: input.conversationId,
    senderPubkey,
    recipientPubkey,
    recipientRole: input.recipientRole,
    surface: input.surface,
    intent: input.intent,
    priorityClass: input.priorityClass ?? "critical_order_write",
    productCoordinates: normalizeProductCoordinates(input.productCoordinates),
    signedWrapEventId,
    signedWrapEventKind,
    signedWrapEventJson,
    localRumorId: input.localRumorId,
    sourceRationale,
    plannedRelayUrls,
    requiredRelayUrls,
    recipientRelayPolicy: input.recipientRelayPolicy ?? "nip17_order",
    deliveryMode: "critical",
    requiredAckCount: normalizePositiveCount(
      input.requiredAckCount,
      DEFAULT_REQUIRED_ACK_COUNT
    ),
    allowSelfCopyFailure:
      input.allowSelfCopyFailure ?? input.recipientRole === "self_copy",
    relayOutcomes: [],
    deliveryState: "queued",
    confirmationState: "unconfirmed",
    retryCount: 0,
    maxRetryCount: normalizePositiveCount(
      input.maxRetryCount,
      DEFAULT_MAX_RETRY_COUNT
    ),
    retryDelayMs: normalizePositiveCount(
      input.retryDelayMs,
      DEFAULT_RETRY_DELAY_MS
    ),
    maxRetryDelayMs: normalizePositiveCount(
      input.maxRetryDelayMs,
      DEFAULT_MAX_RETRY_DELAY_MS
    ),
    createdAt,
    updatedAt: createdAt,
  }
}

export async function persistProtectedDeliveryRecord(
  record: StoredProtectedDeliveryRecord
): Promise<StoredProtectedDeliveryRecord> {
  if (testOverrides.putRecord) await testOverrides.putRecord(record)
  else await db.protectedDeliveryRecords.put(record)
  return record
}

export class ProtectedDeliveryPolicyError extends Error {
  readonly record: StoredProtectedDeliveryRecord
  readonly cause: unknown

  constructor(
    message: string,
    record: StoredProtectedDeliveryRecord,
    cause: unknown = null
  ) {
    super(message)
    this.name = "ProtectedDeliveryPolicyError"
    this.record = record
    this.cause = cause
  }
}

export function getProtectedDeliveryErrorMessage(error: unknown): string {
  if (error instanceof ProtectedDeliveryPolicyError) {
    return "Protected delivery is saved locally and needs retry."
  }
  if (error instanceof RelayPublishDiagnosticsError) {
    return "Protected delivery did not receive a required relay acknowledgement."
  }
  return error instanceof Error
    ? error.message
    : "Protected delivery did not complete."
}

export async function executeProtectedDeliveryRecord(
  input: ExecuteProtectedDeliveryRecordInput
): Promise<StoredProtectedDeliveryRecord> {
  const publishInput = input.resolvedPlan
    ? { ...input.publishInput, resolvedPlan: input.resolvedPlan }
    : input.publishInput

  if (input.persistQueued !== false) {
    await persistProtectedDeliveryRecord(input.record)
  }

  const publishing = markProtectedDeliveryPublishing(
    input.record,
    nowMs(input.now)
  )
  await persistProtectedDeliveryRecord(publishing)

  let finalRecord: StoredProtectedDeliveryRecord
  try {
    const result = await publishPlannedEvent(input.event, publishInput)
    finalRecord = applyProtectedDeliveryPublishResult(
      publishing,
      result,
      nowMs(input.now)
    )
  } catch (error) {
    const diagnostics =
      error instanceof RelayPublishDiagnosticsError
        ? error.diagnostics
        : undefined
    finalRecord = diagnostics
      ? applyProtectedDeliveryPublishResult(
          publishing,
          diagnostics,
          nowMs(input.now)
        )
      : markProtectedDeliveryAttemptFailed(
          publishing,
          failureCategoryFromError(error),
          nowMs(input.now)
        )
    await persistProtectedDeliveryRecord(finalRecord)
    throw new ProtectedDeliveryPolicyError(
      "Protected delivery did not receive a required relay acknowledgement.",
      finalRecord,
      error
    )
  }

  await persistProtectedDeliveryRecord(finalRecord)
  if (
    input.throwOnPolicyFailure !== false &&
    !hasRequiredDelivery(finalRecord)
  ) {
    throw new ProtectedDeliveryPolicyError(
      "Protected delivery did not satisfy required recipient policy.",
      finalRecord
    )
  }
  return finalRecord
}

export async function deliverProtectedOrderMessage(
  input: DeliverProtectedOrderMessageInput
): Promise<ProtectedOrderMessageDeliveryResult> {
  if (!input.signer) {
    throw new Error("Protected order delivery requires an active signer")
  }

  const surface = input.surface ?? "market_checkout"
  const intent = input.intent ?? "checkout_order"
  prepareOrderRumor(input.rumor, input.senderPubkey)

  const primaryPublishInput: PublishWithPlannerInput = {
    intent: "recipient_event",
    authorPubkey: input.senderPubkey,
    recipientPubkeys: [input.recipientPubkey],
    recipientRelayPolicy: "nip17_order",
    refreshRelayLists: true,
    deliveryMode: "critical",
  }
  const selfCopyPubkey = input.selfCopyPubkey ?? input.senderPubkey
  const selfCopyPublishInput: PublishWithPlannerInput = {
    intent: "recipient_event",
    authorPubkey: input.senderPubkey,
    recipientPubkeys: [selfCopyPubkey],
    recipientRelayPolicy: "nip17_order",
    refreshRelayLists: true,
    deliveryMode: "critical",
  }

  const [primaryPlan, selfCopyPlan] = await Promise.all([
    resolvePublishPlan(primaryPublishInput),
    resolvePublishPlan(selfCopyPublishInput),
  ])
  const [wrappedToRecipient, wrappedToSelf] = await Promise.all([
    giftWrap(
      input.rumor,
      new NDKUser({ pubkey: input.recipientPubkey }),
      input.signer,
      {
        rumorKind: EVENT_KINDS.ORDER,
      }
    ),
    giftWrap(
      input.rumor,
      new NDKUser({ pubkey: selfCopyPubkey }),
      input.signer,
      {
        rumorKind: EVENT_KINDS.ORDER,
      }
    ),
  ])

  const primaryRecord = createProtectedDeliveryRecordFromWrap({
    wrappedEvent: wrappedToRecipient,
    orderId: input.orderId,
    localRumorId: input.rumor.id,
    senderPubkey: input.senderPubkey,
    recipientPubkey: input.recipientPubkey,
    recipientRole: "primary_recipient",
    surface,
    intent,
    productCoordinates: input.productCoordinates,
    plan: primaryPlan,
    now: input.now,
  })
  const selfCopyRecord = createProtectedDeliveryRecordFromWrap({
    wrappedEvent: wrappedToSelf,
    orderId: input.orderId,
    localRumorId: input.rumor.id,
    senderPubkey: input.senderPubkey,
    recipientPubkey: selfCopyPubkey,
    recipientRole: "self_copy",
    surface,
    intent,
    productCoordinates: input.productCoordinates,
    plan: selfCopyPlan,
    now: input.now,
  })

  await Promise.all([
    persistProtectedDeliveryRecord(primaryRecord),
    persistProtectedDeliveryRecord(selfCopyRecord),
  ])

  const deliveredPrimaryRecord = await executeProtectedDeliveryRecord({
    record: primaryRecord,
    event: wrappedToRecipient,
    publishInput: primaryPublishInput,
    resolvedPlan: primaryPlan,
    persistQueued: false,
  })

  let deliveredSelfCopyRecord = selfCopyRecord
  let selfCopyError: string | null = null
  try {
    deliveredSelfCopyRecord = await executeProtectedDeliveryRecord({
      record: selfCopyRecord,
      event: wrappedToSelf,
      publishInput: selfCopyPublishInput,
      resolvedPlan: selfCopyPlan,
      persistQueued: false,
      throwOnPolicyFailure: false,
    })
  } catch (error) {
    selfCopyError = getProtectedDeliveryErrorMessage(error)
    deliveredSelfCopyRecord =
      error instanceof ProtectedDeliveryPolicyError
        ? error.record
        : markProtectedDeliveryAttemptFailed(
            selfCopyRecord,
            failureCategoryFromError(error)
          )
    await persistProtectedDeliveryRecord(deliveredSelfCopyRecord)
  }

  return {
    primaryRecord: deliveredPrimaryRecord,
    selfCopyRecord: deliveredSelfCopyRecord,
    selfCopyError,
  }
}

export function markProtectedDeliveryPublishing(
  record: StoredProtectedDeliveryRecord,
  now: number = nowMs()
): StoredProtectedDeliveryRecord {
  return {
    ...record,
    deliveryState: "publishing",
    lastAttemptAt: now,
    updatedAt: now,
  }
}

export function applyProtectedDeliveryPublishResult(
  record: StoredProtectedDeliveryRecord,
  result: PublishWithPlannerResult,
  now: number = nowMs()
): StoredProtectedDeliveryRecord {
  const attemptedRelayUrls = normalizeRelayUrls(result.attemptedRelayUrls)
  const successfulRelayUrls = new Set(
    normalizeRelayUrls(result.successfulRelayUrls)
  )
  const failedRelayUrls = new Set(normalizeRelayUrls(result.failedRelayUrls))
  const nextOutcomes = attemptedRelayUrls.map((relayUrl) => {
    if (successfulRelayUrls.has(relayUrl)) {
      return {
        relayUrl,
        status: "acked" as const,
        attemptedAt: record.lastAttemptAt ?? now,
        completedAt: now,
      }
    }

    const failureCategory = failedRelayUrls.has(relayUrl)
      ? classifyRelayFailure(result.relayFailureMessages[relayUrl])
      : "unknown"
    return {
      relayUrl,
      status: outcomeStatusForFailure(failureCategory),
      failureCategory,
      attemptedAt: record.lastAttemptAt ?? now,
      completedAt: now,
    }
  })
  const relayOutcomes = mergeRelayOutcomes(record.relayOutcomes, nextOutcomes)
  const requiredRelays = new Set(record.requiredRelayUrls)
  const requiredAcks = relayOutcomes.filter((outcome) => {
    if (outcome.status !== "acked") return false
    return requiredRelays.size === 0 || requiredRelays.has(outcome.relayUrl)
  }).length
  const anyAck = relayOutcomes.some((outcome) => outcome.status === "acked")
  const requiredDelivered = requiredAcks >= record.requiredAckCount
  const nextRetryCount = requiredDelivered
    ? record.retryCount
    : record.retryCount + 1
  const retryExhausted = nextRetryCount >= record.maxRetryCount
  const lastFailureCategory = relayOutcomes
    .filter((outcome) => outcome.status !== "acked")
    .at(-1)?.failureCategory

  const deliveryState: ProtectedDeliveryState = requiredDelivered
    ? "delivered_required"
    : anyAck
      ? "partially_delivered"
      : retryExhausted
        ? "failed"
        : "retry_needed"

  return {
    ...record,
    relayOutcomes,
    deliveryState,
    confirmationState: requiredDelivered
      ? "acked_by_relay"
      : record.confirmationState,
    retryCount: nextRetryCount,
    lastFailureCategory,
    nextRetryAt: requiredDelivered
      ? undefined
      : scheduleNextRetry({
          record,
          retryCount: nextRetryCount,
          now,
        }),
    updatedAt: now,
  }
}

export function markProtectedDeliveryObserved(
  record: StoredProtectedDeliveryRecord,
  now: number = nowMs()
): StoredProtectedDeliveryRecord {
  return {
    ...record,
    confirmationState: "observed_via_read_path",
    deliveryState: hasRequiredDelivery(record)
      ? "delivered_required"
      : record.deliveryState,
    updatedAt: now,
  }
}

export function markProtectedDeliveryConfirmed(
  record: StoredProtectedDeliveryRecord,
  now: number = nowMs()
): StoredProtectedDeliveryRecord {
  return {
    ...record,
    confirmationState: "confirmed",
    deliveryState: "delivered_required",
    nextRetryAt: undefined,
    updatedAt: now,
  }
}

export function projectProtectedDeliveryBatch(
  records: readonly StoredProtectedDeliveryRecord[]
): ProtectedDeliveryBatchProjection {
  const primaryRecords = records.filter(
    (record) => record.recipientRole === "primary_recipient"
  )
  const selfCopyRecords = records.filter(
    (record) => record.recipientRole === "self_copy"
  )
  const primaryRecipientState = collapseStates(primaryRecords)
  const selfCopyState =
    selfCopyRecords.length > 0 ? collapseStates(selfCopyRecords) : undefined
  const requiredDelivered = primaryRecords.some((record) =>
    hasRequiredDelivery(record)
  )
  const retryNeededRecordIds = records
    .filter((record) => RETRYABLE_STATES.has(record.deliveryState))
    .filter((record) => !hasRequiredDelivery(record))
    .map((record) => record.id)

  return {
    overallState: requiredDelivered
      ? "delivered_required"
      : primaryRecipientState,
    confirmationState: strongestConfirmationState(primaryRecords),
    primaryRecipientState,
    requiredDelivered,
    selfCopyState,
    selfCopyRetryNeeded:
      requiredDelivered &&
      selfCopyRecords.some((record) => !hasRequiredDelivery(record)),
    retryNeededRecordIds,
  }
}

export function createProtectedDeliveryDiagnostics(
  record: StoredProtectedDeliveryRecord
): ProtectedDeliveryDiagnostics {
  const failureCategories = Array.from(
    new Set(
      record.relayOutcomes
        .map((outcome) => outcome.failureCategory)
        .filter((category): category is ProtectedDeliveryFailureCategory =>
          Boolean(category)
        )
    )
  )

  return {
    id: record.id,
    orderId: record.orderId,
    conversationId: record.conversationId,
    surface: record.surface,
    intent: record.intent,
    recipientRole: record.recipientRole,
    priorityClass: record.priorityClass,
    signedWrapEventId: record.signedWrapEventId,
    signedWrapEventKind: record.signedWrapEventKind,
    deliveryState: record.deliveryState,
    confirmationState: record.confirmationState,
    plannedRelayCount: record.plannedRelayUrls.length,
    requiredRelayCount: record.requiredRelayUrls.length,
    attemptedRelayCount: record.relayOutcomes.length,
    ackedRelayCount: countStatuses(record.relayOutcomes, "acked"),
    failedRelayCount: record.relayOutcomes.filter(
      (outcome) => outcome.status !== "acked"
    ).length,
    failureCategories,
    retryCount: record.retryCount,
    nextRetryAt: record.nextRetryAt,
    updatedAt: record.updatedAt,
    sourceRationale: [...record.sourceRationale],
  }
}

export async function getRetryableProtectedDeliveryRecords(
  now: number = nowMs()
): Promise<StoredProtectedDeliveryRecord[]> {
  const records = testOverrides.getRecords
    ? await testOverrides.getRecords()
    : await db.protectedDeliveryRecords
        .where("deliveryState")
        .anyOf([...RETRYABLE_STATES])
        .toArray()

  return records.filter((record) => isRetryableRecord(record, now))
}
