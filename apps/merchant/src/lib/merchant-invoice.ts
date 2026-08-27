import {
  canMockInvoice,
  db,
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  fetchLnurlInvoice,
  fetchLnurlPayMetadata,
  getAuthoritativeProfileLud16,
  getMerchantConversationList,
  getNwcConnectionFingerprint,
  isValidLud16Address,
  mockMakeInvoice,
  normalizeLightningInvoice,
  nwcGetInfo,
  nwcMakeInvoice,
  publishMerchantOrderMessage,
  normalizePubkey,
  validateLightningInvoiceForPayment,
  weblnMakeInvoice,
  type LnurlPayMetadata,
  type MerchantConversationSummary,
  type MerchantOrderDelivery,
  type NwcConnection,
  type NwcGetInfoResult,
  type PublishMerchantOrderMessageInput,
  type StoredMerchantPendingInvoice,
} from "@conduit/core"

export type MerchantInvoiceSource =
  | "profile_lud16"
  | "webln"
  | "nwc"
  | "manual"
  | "conversation_recovery"
  | "mock"

export type MerchantPendingInvoice = StoredMerchantPendingInvoice

export interface MerchantPendingInvoiceStore {
  get(
    merchantPubkey: string,
    orderId: string
  ): Promise<MerchantPendingInvoice | null>
  put(invoice: MerchantPendingInvoice): Promise<void>
  delete(merchantPubkey: string, orderId: string): Promise<void>
}

export interface MerchantInvoiceLockManager {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T>
}

type PendingInvoiceTable = {
  get(id: string): Promise<StoredMerchantPendingInvoice | undefined>
  put(invoice: StoredMerchantPendingInvoice): Promise<unknown>
  delete(id: string): Promise<void>
}

function parseStoredPendingInvoice(
  value: StoredMerchantPendingInvoice | undefined,
  expectedId: string
): MerchantPendingInvoice | null {
  if (!value || value.id !== expectedId) return null
  const merchantPubkey = normalizePubkey(value.merchantPubkey)
  const buyerPubkey = normalizePubkey(value.buyerPubkey)
  const source: readonly MerchantInvoiceSource[] = [
    "profile_lud16",
    "webln",
    "nwc",
    "manual",
    "conversation_recovery",
    "mock",
  ]
  const relayAcceptedAtIsValid =
    Number.isSafeInteger(value.relayAcceptedAt) &&
    (value.relayAcceptedAt ?? -1) >= 0
  const paymentAuthority = normalizeStoredPaymentAuthority(
    value.paymentAuthority
  )
  if (
    !merchantPubkey ||
    !buyerPubkey ||
    value.id !== pendingInvoiceId(merchantPubkey, value.orderId) ||
    typeof value.invoice !== "string" ||
    !value.invoice ||
    typeof value.paymentHash !== "string" ||
    !Number.isSafeInteger(value.amountMsats) ||
    value.amountMsats <= 0 ||
    (value.note !== undefined && typeof value.note !== "string") ||
    (value.delivery !== "buyer_and_self" && value.delivery !== "self_only") ||
    !source.includes(value.source) ||
    (value.paymentAuthority !== undefined && !paymentAuthority) ||
    (paymentAuthority !== null && paymentAuthority.type !== value.source) ||
    !Number.isSafeInteger(value.invoiceCreatedAt) ||
    !Number.isSafeInteger(value.invoiceExpiresAt) ||
    value.invoiceExpiresAt <= value.invoiceCreatedAt ||
    (value.deliveryState !== "pending" &&
      value.deliveryState !== "relay_accepted") ||
    !Number.isSafeInteger(value.deliveryAttemptCount) ||
    value.deliveryAttemptCount < 0 ||
    (value.deliveryState === "pending" &&
      value.relayAcceptedAt !== undefined) ||
    (value.deliveryState === "relay_accepted" &&
      (value.deliveryAttemptCount < 1 || !relayAcceptedAtIsValid)) ||
    !Number.isSafeInteger(value.savedAt)
  ) {
    return null
  }

  return {
    id: value.id,
    merchantPubkey,
    buyerPubkey,
    orderId: value.orderId,
    invoice: value.invoice,
    paymentHash: value.paymentHash,
    amountMsats: value.amountMsats,
    ...(value.note ? { note: value.note } : {}),
    delivery: value.delivery,
    source: value.source,
    ...(paymentAuthority ? { paymentAuthority } : {}),
    invoiceCreatedAt: value.invoiceCreatedAt,
    invoiceExpiresAt: value.invoiceExpiresAt,
    deliveryState: value.deliveryState,
    deliveryAttemptCount: value.deliveryAttemptCount,
    ...(Number.isSafeInteger(value.lastDeliveryAttemptAt)
      ? { lastDeliveryAttemptAt: value.lastDeliveryAttemptAt }
      : {}),
    ...(Number.isSafeInteger(value.relayAcceptedAt)
      ? { relayAcceptedAt: value.relayAcceptedAt }
      : {}),
    ...(value.lastFailureCode === "relay_delivery_failed"
      ? { lastFailureCode: value.lastFailureCode }
      : {}),
    savedAt: value.savedAt,
  }
}

function normalizeStoredPaymentAuthority(
  value: StoredMerchantPendingInvoice["paymentAuthority"]
): NonNullable<StoredMerchantPendingInvoice["paymentAuthority"]> | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as {
    type?: unknown
    lud16?: unknown
    profileFrontierEventId?: unknown
    connectionFingerprint?: unknown
  }
  if (
    (candidate.type !== "profile_lud16" && candidate.type !== "nwc") ||
    typeof candidate.lud16 !== "string" ||
    (candidate.profileFrontierEventId !== null &&
      typeof candidate.profileFrontierEventId !== "string")
  ) {
    return null
  }
  const lud16 = candidate.lud16.trim().toLowerCase()
  const profileFrontierEventId =
    candidate.profileFrontierEventId?.trim().toLowerCase() ?? null
  if (
    !isValidLud16Address(lud16) ||
    (profileFrontierEventId !== null &&
      !/^[0-9a-f]{64}$/.test(profileFrontierEventId))
  ) {
    return null
  }
  if (candidate.type === "profile_lud16") {
    return {
      type: candidate.type,
      lud16,
      profileFrontierEventId,
    }
  }
  if (typeof candidate.connectionFingerprint !== "string") return null
  const connectionFingerprint = candidate.connectionFingerprint
    .trim()
    .toLowerCase()
  return /^[0-9a-f]{64}$/.test(connectionFingerprint)
    ? {
        type: candidate.type,
        lud16,
        profileFrontierEventId,
        connectionFingerprint,
      }
    : null
}

export class DexieMerchantPendingInvoiceStore implements MerchantPendingInvoiceStore {
  constructor(
    private readonly table: PendingInvoiceTable = db.merchantPendingInvoices
  ) {}

  async get(
    merchantPubkey: string,
    orderId: string
  ): Promise<MerchantPendingInvoice | null> {
    const merchant = normalizePubkey(merchantPubkey)
    const normalizedOrderId = orderId.trim()
    if (!merchant || !normalizedOrderId) return null
    const id = pendingInvoiceId(merchant, normalizedOrderId)
    return parseStoredPendingInvoice(await this.table.get(id), id)
  }

  async put(invoice: MerchantPendingInvoice): Promise<void> {
    const parsed = parseStoredPendingInvoice(invoice, invoice.id)
    if (!parsed)
      throw new Error("Cannot persist invalid pending invoice state.")
    await this.table.put(parsed)
  }

  async delete(merchantPubkey: string, orderId: string): Promise<void> {
    const merchant = normalizePubkey(merchantPubkey)
    const normalizedOrderId = orderId.trim()
    if (!merchant || !normalizedOrderId) return
    await this.table.delete(pendingInvoiceId(merchant, normalizedOrderId))
  }
}

export type MerchantInvoiceSelection =
  | { type: "profile_lud16" }
  | { type: "webln" }
  | {
      type: "nwc"
      connection: NwcConnection
      walletLud16?: string | null
      /** Synchronous final guard against disconnect/session replacement. */
      assertCurrentConnection?: () => void
    }
  | { type: "manual"; invoice: string }

export type MerchantInvoiceMutationSource = Exclude<
  MerchantInvoiceSource,
  "mock" | "conversation_recovery"
>

export type MerchantInvoiceScope = {
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
}

export type MerchantConversationInvoiceRequest = {
  messageId: string
  merchantPubkey: string
  buyerPubkey: string
  orderId: string
  createdAt: number
  invoice: string
  amountSats?: number
  currency?: string
  note?: string
}

export type MerchantConversationInvoiceEvidence = {
  readState: "complete" | "incomplete"
  paymentRequests: MerchantConversationInvoiceRequest[]
}

const MERCHANT_INVOICE_HISTORY_LIMIT = 400

export function getMerchantConversationInvoiceEvidence(
  conversation: MerchantConversationSummary,
  readState: MerchantConversationInvoiceEvidence["readState"]
): MerchantConversationInvoiceEvidence {
  return {
    readState,
    paymentRequests: (conversation.messages ?? []).flatMap((message) =>
      message.type === "payment_request"
        ? [
            {
              messageId: message.id,
              merchantPubkey: message.senderPubkey,
              buyerPubkey: message.recipientPubkey,
              orderId: message.orderId,
              createdAt: message.createdAt,
              invoice: message.payload.invoice,
              ...(message.payload.amount !== undefined
                ? { amountSats: message.payload.amount }
                : {}),
              ...(message.payload.currency
                ? { currency: message.payload.currency }
                : {}),
              ...(message.payload.note ? { note: message.payload.note } : {}),
            },
          ]
        : []
    ),
  }
}

async function loadCurrentMerchantConversationInvoiceEvidence(
  scope: MerchantInvoiceScope
): Promise<MerchantConversationInvoiceEvidence> {
  const result = await getMerchantConversationList({
    principalPubkey: scope.merchantPubkey,
    limit: MERCHANT_INVOICE_HISTORY_LIMIT,
    forceFresh: true,
  })
  const readState =
    !result.meta.stale &&
    !result.meta.degraded &&
    !result.meta.capped &&
    result.meta.inbox?.coverage === "complete"
      ? "complete"
      : "incomplete"
  const conversation = result.data.find(
    (candidate) =>
      candidate.orderId === scope.orderId &&
      normalizePubkey(candidate.buyerPubkey) === scope.buyerPubkey
  )
  return conversation
    ? getMerchantConversationInvoiceEvidence(conversation, readState)
    : { readState, paymentRequests: [] }
}

export type DeliverMerchantInvoiceInput =
  | (MerchantInvoiceScope & {
      mode: "create"
      amountSats: number
      note?: string
      delivery: MerchantOrderDelivery
      source: MerchantInvoiceSelection
      conversationEvidence: MerchantConversationInvoiceEvidence
    })
  | (MerchantInvoiceScope & {
      mode: "retry"
      conversationEvidence?: MerchantConversationInvoiceEvidence
      /** Resolve the live authorization only when retrying an NWC invoice. */
      resolveCurrentNwcConnection?: () => NwcConnection
    })

export type DeliverMerchantInvoiceResult = {
  invoice: string
  source: MerchantInvoiceSource
  reused: boolean
  relayAcceptance: "accepted"
  localCheckpointWarning?: "relay_accepted_local_checkpoint_failed"
}

export type MerchantInvoiceMutationResult = Omit<
  DeliverMerchantInvoiceResult,
  "invoice"
>

export type MerchantInvoiceMutationErrorCode =
  | "profile_invoice_failed"
  | "browser_wallet_invoice_failed"
  | "connected_wallet_invoice_failed"
  | "manual_invoice_failed"
  | "invoice_retry_failed"
  | "invoice_discard_failed"

const MERCHANT_INVOICE_MUTATION_ERROR_MESSAGES: Record<
  MerchantInvoiceMutationErrorCode,
  string
> = {
  profile_invoice_failed:
    "Could not complete the profile Lightning invoice action. If a saved invoice is shown, retry it; otherwise try again or choose another invoice source.",
  browser_wallet_invoice_failed:
    "Could not complete the browser-wallet invoice action. If a saved invoice is shown, retry it; otherwise try again or choose another invoice source.",
  connected_wallet_invoice_failed:
    "Could not complete the connected-wallet invoice action. If a saved invoice is shown, retry it; otherwise check the wallet connection and try again.",
  manual_invoice_failed:
    "Could not complete the pasted-invoice action. If a saved invoice is shown, retry it; otherwise check the invoice and try again.",
  invoice_retry_failed:
    "Could not complete the saved-invoice action. Refresh its status and try again.",
  invoice_discard_failed:
    "Could not discard the expired saved invoice. Refresh its status and try again.",
}

export class MerchantInvoiceMutationError extends Error {
  readonly code: MerchantInvoiceMutationErrorCode

  constructor(code: MerchantInvoiceMutationErrorCode) {
    super(MERCHANT_INVOICE_MUTATION_ERROR_MESSAGES[code])
    this.name = "MerchantInvoiceMutationError"
    this.code = code
  }
}

function mutationErrorCodeForSource(
  source: MerchantInvoiceMutationSource
): MerchantInvoiceMutationErrorCode {
  switch (source) {
    case "profile_lud16":
      return "profile_invoice_failed"
    case "webln":
      return "browser_wallet_invoice_failed"
    case "nwc":
      return "connected_wallet_invoice_failed"
    case "manual":
      return "manual_invoice_failed"
  }
}

export function sanitizeMerchantInvoiceMutationResult(
  result: DeliverMerchantInvoiceResult
): MerchantInvoiceMutationResult {
  return {
    source: result.source,
    reused: result.reused,
    relayAcceptance: result.relayAcceptance,
    ...(result.localCheckpointWarning
      ? { localCheckpointWarning: result.localCheckpointWarning }
      : {}),
  }
}

export function createMerchantInvoiceMutationFn(input: {
  resolveSource: (
    source: MerchantInvoiceMutationSource
  ) => MerchantInvoiceSelection
  deliver: (
    source: MerchantInvoiceSelection
  ) => Promise<DeliverMerchantInvoiceResult>
}): (
  source: MerchantInvoiceMutationSource
) => Promise<MerchantInvoiceMutationResult> {
  return async (source) => {
    try {
      const result = await input.deliver(input.resolveSource(source))

      // Mutation data is visible to React Query diagnostics. Project an
      // explicit content-free result even if the provider boundary grows.
      return sanitizeMerchantInvoiceMutationResult(result)
    } catch {
      // Provider and delivery errors may contain Lightning addresses, invoices,
      // relay responses, or credential-bearing causes. React Query retains
      // rejected errors, so cross this boundary with a fresh allowlisted error
      // and deliberately do not preserve the raw error or its cause.
      throw new MerchantInvoiceMutationError(mutationErrorCodeForSource(source))
    }
  }
}

export function createMerchantInvoiceRetryMutationFn(
  deliver: () => Promise<DeliverMerchantInvoiceResult>
): () => Promise<MerchantInvoiceMutationResult> {
  return async () => {
    try {
      return sanitizeMerchantInvoiceMutationResult(await deliver())
    } catch {
      throw new MerchantInvoiceMutationError("invoice_retry_failed")
    }
  }
}

export function createMerchantInvoiceDiscardMutationFn(
  discard: () => Promise<void>
): () => Promise<void> {
  return async () => {
    try {
      await discard()
    } catch {
      // Storage failures can include the composite order key. Do not retain the
      // provider error in React Query's diagnostics-visible mutation cache.
      throw new MerchantInvoiceMutationError("invoice_discard_failed")
    }
  }
}

export type MerchantPendingInvoiceQueryResult = Pick<
  MerchantPendingInvoice,
  "deliveryState" | "invoiceExpiresAt"
>

export type MerchantPendingInvoiceQueryErrorCode =
  | "history_incomplete"
  | "history_conflict"
  | "history_invalid"
  | "storage_unavailable"

export class MerchantPendingInvoiceQueryError extends Error {
  readonly code: MerchantPendingInvoiceQueryErrorCode

  constructor(code: MerchantPendingInvoiceQueryErrorCode) {
    const message =
      code === "history_incomplete"
        ? "Invoice history is incomplete. New invoice creation is paused until complete history is available."
        : code === "history_conflict"
          ? "Multiple payable invoices exist in signed history. Resolve the order before creating another invoice."
          : code === "history_invalid"
            ? "Signed invoice history is invalid. Review the order before creating another invoice."
            : "Could not load the saved invoice status. Refresh and try again."
    super(message)
    this.name = "MerchantPendingInvoiceQueryError"
    this.code = code
  }
}

class MerchantInvoiceHistoryError extends Error {
  readonly code: Exclude<
    MerchantPendingInvoiceQueryErrorCode,
    "storage_unavailable"
  >

  constructor(
    code: Exclude<MerchantPendingInvoiceQueryErrorCode, "storage_unavailable">,
    message: string
  ) {
    super(message)
    this.name = "MerchantInvoiceHistoryError"
    this.code = code
  }
}

export function createMerchantPendingInvoiceQueryScope(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    ""
  )
}

export function merchantPendingInvoiceQueryKey(
  scope: string
): readonly ["merchant-pending-invoice", string] {
  return ["merchant-pending-invoice", scope]
}

export function createMerchantPendingInvoiceQueryFn(
  load: () => Promise<MerchantPendingInvoice | null>
): () => Promise<MerchantPendingInvoiceQueryResult | null> {
  return async () => {
    try {
      const pending = await load()
      return pending
        ? {
            deliveryState: pending.deliveryState,
            invoiceExpiresAt: pending.invoiceExpiresAt,
          }
        : null
    } catch (error) {
      // Query state is diagnostics-visible. Keep the persisted BOLT11, payment
      // hash, note, identities, storage key, and any raw storage error outside
      // both successful data and rejected error state.
      throw new MerchantPendingInvoiceQueryError(
        error instanceof MerchantInvoiceHistoryError
          ? error.code
          : "storage_unavailable"
      )
    }
  }
}

type MerchantInvoiceDependencies = {
  store: MerchantPendingInvoiceStore
  fetchLnurlPayMetadata: (lud16: string) => Promise<LnurlPayMetadata>
  fetchLnurlInvoice: (
    callback: string,
    amountMsats: number
  ) => Promise<{ invoice: string }>
  makeWeblnInvoice: typeof weblnMakeInvoice
  makeNwcInvoice: (
    connection: NwcConnection,
    input: { amountMsats: number; description?: string },
    timeoutMs: number
  ) => Promise<{ invoice: string }>
  getNwcInfo: (
    connection: NwcConnection,
    timeoutMs: number
  ) => Promise<NwcGetInfoResult>
  makeMockInvoice: typeof mockMakeInvoice
  isMockPayments: () => boolean
  resolveProfileLud16: (merchantPubkey: string) => Promise<
    | string
    | {
        lud16: string
        frontierEventId: string
      }
  >
  refreshConversationEvidence: (
    scope: MerchantInvoiceScope
  ) => Promise<MerchantConversationInvoiceEvidence>
  publish: (input: PublishMerchantOrderMessageInput) => Promise<unknown>
  now: () => number
  webLnTimeoutMs?: number
  nwcTimeoutMs?: number
  lockManager?: MerchantInvoiceLockManager | null
  requireCrossContextLock?: boolean
}

type ResolvedMerchantProfileInvoiceAuthority = {
  lud16: string
  /** Null is retained only for isolated dependency adapters in unit tests. */
  frontierEventId: string | null
}

type AcquiredMerchantInvoice = {
  invoice: string
  source: MerchantInvoiceSource
  paymentAuthority?: NonNullable<MerchantPendingInvoice["paymentAuthority"]>
  /** Re-check asynchronous payment authority immediately before persistence. */
  revalidate?: () => Promise<void>
}

export interface MerchantInvoiceModule {
  deliver(
    input: DeliverMerchantInvoiceInput
  ): Promise<DeliverMerchantInvoiceResult>
  getPending(
    input: MerchantInvoiceScope & {
      conversationEvidence?: MerchantConversationInvoiceEvidence
    }
  ): Promise<MerchantPendingInvoice | null>
  discardExpired(input: MerchantInvoiceScope): Promise<void>
}

function pendingInvoiceId(merchantPubkey: string, orderId: string): string {
  return `${merchantPubkey.trim()}:${orderId.trim()}`
}

function validateScope(input: MerchantInvoiceScope): MerchantInvoiceScope {
  const merchantPubkey = normalizePubkey(input.merchantPubkey)
  const buyerPubkey = normalizePubkey(input.buyerPubkey)
  const scope = {
    merchantPubkey: merchantPubkey ?? "",
    buyerPubkey: buyerPubkey ?? "",
    orderId: input.orderId.trim(),
  }
  if (!merchantPubkey || !buyerPubkey) {
    throw new Error("Valid merchant and buyer pubkeys are required.")
  }
  if (!scope.orderId || scope.orderId.length > 512) {
    throw new Error("A valid order is required.")
  }
  return scope
}

function validateGeneratedInvoice(
  invoice: string,
  expectedAmountMsats: number,
  nowMs: number
): {
  invoice: string
  paymentHash: string
  invoiceCreatedAt: number
  invoiceExpiresAt: number
} {
  const normalized = normalizeLightningInvoice(invoice)
  const validation = validateLightningInvoiceForPayment({
    invoice: normalized,
    expectedAmountMsats,
    nowSeconds: Math.floor(nowMs / 1_000),
  })
  if (!validation.ok) throw new Error(validation.reason)

  const paymentHash = decodeLightningInvoicePaymentHash(normalized)
  const metadata = decodeLightningInvoiceMetadata(normalized)
  if (
    !paymentHash ||
    metadata.createdAt === null ||
    metadata.expiresAt === null ||
    metadata.expiresAt <= metadata.createdAt
  ) {
    throw new Error("The invoice is not a structurally valid BOLT11 invoice.")
  }

  return {
    invoice: normalized,
    paymentHash,
    invoiceCreatedAt: metadata.createdAt,
    invoiceExpiresAt: metadata.expiresAt,
  }
}

type ValidatedConversationInvoice = ReturnType<
  typeof validateGeneratedInvoice
> & {
  amountMsats: number
  expired: boolean
  request: MerchantConversationInvoiceRequest
}

type ConversationInvoiceReconciliation =
  | { state: "none" | "expired" }
  | { state: "recoverable"; invoice: MerchantPendingInvoice }

function validateConversationInvoice(
  request: MerchantConversationInvoiceRequest,
  nowMs: number
): ValidatedConversationInvoice {
  const invoice = normalizeLightningInvoice(request.invoice)
  const metadata = decodeLightningInvoiceMetadata(invoice)
  const paymentHash = decodeLightningInvoicePaymentHash(invoice)
  if (
    !paymentHash ||
    metadata.msats === null ||
    !Number.isSafeInteger(metadata.msats) ||
    metadata.msats <= 0 ||
    metadata.createdAt === null ||
    !Number.isSafeInteger(metadata.createdAt) ||
    metadata.expiresAt === null ||
    !Number.isSafeInteger(metadata.expiresAt) ||
    metadata.expiresAt <= metadata.createdAt
  ) {
    throw new MerchantInvoiceHistoryError(
      "history_invalid",
      "The signed invoice history cannot safely authorize another invoice."
    )
  }

  if (request.amountSats !== undefined) {
    if (
      !Number.isSafeInteger(request.amountSats) ||
      request.amountSats <= 0 ||
      !Number.isSafeInteger(request.amountSats * 1_000) ||
      request.amountSats * 1_000 !== metadata.msats
    ) {
      throw new MerchantInvoiceHistoryError(
        "history_invalid",
        "The signed invoice history cannot safely authorize another invoice."
      )
    }
  }
  if (
    request.currency !== undefined &&
    !["SAT", "SATS"].includes(request.currency.trim().toUpperCase())
  ) {
    throw new MerchantInvoiceHistoryError(
      "history_invalid",
      "The signed invoice history cannot safely authorize another invoice."
    )
  }

  const nowSeconds = Math.floor(nowMs / 1_000)
  const expired = metadata.expiresAt <= nowSeconds
  const validation = validateLightningInvoiceForPayment({
    invoice,
    expectedAmountMsats: metadata.msats,
    // An expired invoice must still prove that it was a valid, payable BOLT11
    // before its signed expiry. Only then may it authorize replacement.
    nowSeconds: expired ? metadata.expiresAt - 1 : nowSeconds,
  })
  if (!validation.ok) {
    throw new MerchantInvoiceHistoryError(
      "history_invalid",
      "The signed invoice history cannot safely authorize another invoice."
    )
  }

  return {
    invoice,
    paymentHash,
    invoiceCreatedAt: metadata.createdAt,
    invoiceExpiresAt: metadata.expiresAt,
    amountMsats: metadata.msats,
    expired,
    request,
  }
}

function getExactConversationInvoiceRequests(
  scope: MerchantInvoiceScope,
  evidence: MerchantConversationInvoiceEvidence
): MerchantConversationInvoiceRequest[] {
  return evidence.paymentRequests.filter(
    (request) =>
      normalizePubkey(request.merchantPubkey) === scope.merchantPubkey &&
      normalizePubkey(request.buyerPubkey) === scope.buyerPubkey &&
      request.orderId.trim() === scope.orderId
  )
}

function assertSignedHistoryCompatibleWithSavedInvoice(
  scope: MerchantInvoiceScope,
  saved: MerchantPendingInvoice,
  evidence: MerchantConversationInvoiceEvidence | undefined,
  dependencies: MerchantInvoiceDependencies,
  requireRetryAuthorization = false
): boolean {
  if (!evidence || !Array.isArray(evidence.paymentRequests)) return false
  const exactRequests = getExactConversationInvoiceRequests(scope, evidence)

  const savedCanonicalInvoice = normalizeLightningInvoice(
    saved.invoice
  ).toLowerCase()
  let hasActiveSavedMatch = false
  for (const request of exactRequests) {
    const candidate = validateConversationInvoice(request, dependencies.now())
    if (
      !candidate.expired &&
      candidate.invoice.toLowerCase() === savedCanonicalInvoice
    ) {
      hasActiveSavedMatch = true
    }
    if (
      !candidate.expired &&
      candidate.invoice.toLowerCase() !== savedCanonicalInvoice
    ) {
      throw new MerchantInvoiceHistoryError(
        "history_conflict",
        "A different payable invoice exists in signed history. Resolve the order before retrying the saved invoice."
      )
    }
  }
  if (
    requireRetryAuthorization &&
    evidence.readState !== "complete" &&
    saved.deliveryState !== "relay_accepted" &&
    !hasActiveSavedMatch
  ) {
    throw new MerchantInvoiceHistoryError(
      "history_incomplete",
      "Invoice history is incomplete. Refresh the order before retrying this saved invoice."
    )
  }
  return hasActiveSavedMatch
}

function assertSignedHistoryAllowsFreshInvoice(
  scope: MerchantInvoiceScope,
  evidence: MerchantConversationInvoiceEvidence,
  dependencies: MerchantInvoiceDependencies
): void {
  if (!Array.isArray(evidence.paymentRequests)) {
    throw new MerchantInvoiceHistoryError(
      "history_incomplete",
      "Invoice history is unavailable. Refresh the order before creating an invoice."
    )
  }
  const exactRequests = getExactConversationInvoiceRequests(scope, evidence)
  const validated = exactRequests.map((request) =>
    validateConversationInvoice(request, dependencies.now())
  )
  if (validated.some((candidate) => !candidate.expired)) {
    throw new MerchantInvoiceHistoryError(
      "history_conflict",
      "A payable invoice appeared in signed history while this invoice was being created. Refresh the order and retry the existing invoice."
    )
  }
  if (evidence.readState !== "complete") {
    throw new MerchantInvoiceHistoryError(
      "history_incomplete",
      "Invoice history changed or remains incomplete. Refresh the order before creating an invoice."
    )
  }
}

async function reconcileConversationInvoiceHistory(
  scope: MerchantInvoiceScope,
  evidence: MerchantConversationInvoiceEvidence | undefined,
  dependencies: MerchantInvoiceDependencies
): Promise<ConversationInvoiceReconciliation> {
  if (!evidence || !Array.isArray(evidence.paymentRequests)) {
    throw new MerchantInvoiceHistoryError(
      "history_incomplete",
      "Invoice history is unavailable. Refresh the order before creating an invoice."
    )
  }

  const exactRequests = getExactConversationInvoiceRequests(scope, evidence)
  if (exactRequests.length === 0) {
    if (evidence.readState !== "complete") {
      throw new MerchantInvoiceHistoryError(
        "history_incomplete",
        "Invoice history is incomplete. Refresh the order before creating an invoice."
      )
    }
    return { state: "none" }
  }

  const now = dependencies.now()
  const validated = exactRequests.map((request) =>
    validateConversationInvoice(request, now)
  )
  const activeByInvoice = new Map<string, ValidatedConversationInvoice>()
  for (const candidate of validated) {
    if (!candidate.expired) {
      activeByInvoice.set(candidate.invoice.toLowerCase(), candidate)
    }
  }

  if (activeByInvoice.size > 1) {
    throw new MerchantInvoiceHistoryError(
      "history_conflict",
      "Multiple payable invoices were found in signed history. Resolve the order before creating another invoice."
    )
  }
  if (activeByInvoice.size === 1) {
    const recovered = activeByInvoice.values().next().value
    if (!recovered) {
      throw new MerchantInvoiceHistoryError(
        "history_invalid",
        "The signed invoice history cannot safely authorize another invoice."
      )
    }
    const invoice: MerchantPendingInvoice = {
      id: pendingInvoiceId(scope.merchantPubkey, scope.orderId),
      ...scope,
      invoice: recovered.invoice,
      paymentHash: recovered.paymentHash,
      amountMsats: recovered.amountMsats,
      ...(recovered.request.note?.trim()
        ? { note: recovered.request.note.trim() }
        : {}),
      delivery: "buyer_and_self",
      source: "conversation_recovery",
      invoiceCreatedAt: recovered.invoiceCreatedAt,
      invoiceExpiresAt: recovered.invoiceExpiresAt,
      deliveryState: "pending",
      deliveryAttemptCount: 0,
      savedAt: now,
    }
    await dependencies.store.put(invoice)
    return { state: "recoverable", invoice }
  }

  if (evidence.readState !== "complete") {
    throw new MerchantInvoiceHistoryError(
      "history_incomplete",
      "Invoice history is incomplete. Refresh the order before creating an invoice."
    )
  }
  return { state: "expired" }
}

function assertAmount(amountSats: number): number {
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error("Invoice amount must be a positive whole number of sats.")
  }
  const amountMsats = amountSats * 1_000
  if (!Number.isSafeInteger(amountMsats)) {
    throw new Error("Invoice amount is too large.")
  }
  return amountMsats
}

function assertLnurlRange(
  metadata: LnurlPayMetadata,
  amountMsats: number
): void {
  if (
    amountMsats < metadata.minSendable ||
    amountMsats > metadata.maxSendable
  ) {
    throw new Error(
      "The configured Lightning address does not accept this invoice amount."
    )
  }
}

function toPublishInput(
  pending: MerchantPendingInvoice,
  revalidateBeforeDelivery?: (
    leg: "sender_self_copy" | "recipient"
  ) => Promise<void>
): PublishMerchantOrderMessageInput {
  return {
    merchantPubkey: pending.merchantPubkey,
    buyerPubkey: pending.buyerPubkey,
    orderId: pending.orderId,
    type: "payment_request",
    tags: [
      ["amount", String(pending.amountMsats / 1_000)],
      ["currency", "SATS"],
      ["payment_method", "lightning"],
    ],
    payload: {
      invoice: pending.invoice,
      amount: pending.amountMsats / 1_000,
      currency: "SATS",
      note: pending.note,
    },
    delivery: pending.delivery,
    ...(revalidateBeforeDelivery ? { revalidateBeforeDelivery } : {}),
  }
}

function assertProfilePaymentAuthorityCurrent(
  expected: {
    lud16: string
    profileFrontierEventId: string | null
  },
  current: ResolvedMerchantProfileInvoiceAuthority
): void {
  if (
    !isSameProfileInvoiceAuthority(
      {
        lud16: expected.lud16,
        frontierEventId: expected.profileFrontierEventId,
      },
      current
    )
  ) {
    throw new Error(
      "The signed profile payment destination changed after this invoice was created."
    )
  }
}

function getSavedInvoiceAuthorityRevalidator(
  pending: MerchantPendingInvoice,
  resolveCurrentNwcConnection: (() => NwcConnection) | undefined,
  dependencies: MerchantInvoiceDependencies
): (() => Promise<void>) | undefined {
  const authority = pending.paymentAuthority
  if (!authority) {
    if (
      pending.deliveryState === "pending" &&
      (pending.source === "profile_lud16" || pending.source === "nwc")
    ) {
      throw new Error(
        "The saved invoice is missing its payment authority checkpoint and cannot be retried."
      )
    }
    return undefined
  }

  if (authority.type === "profile_lud16") {
    return async () => {
      assertProfilePaymentAuthorityCurrent(
        authority,
        await resolveCurrentProfileAuthority(
          pending.merchantPubkey,
          dependencies
        )
      )
    }
  }

  if (!resolveCurrentNwcConnection) {
    throw new Error(
      "Reconnect the wallet authorization that created this saved invoice before retrying it."
    )
  }
  const timeoutMs = dependencies.nwcTimeoutMs ?? 15_000
  return async () => {
    const connection = resolveCurrentNwcConnection()
    if (
      getNwcConnectionFingerprint(connection) !==
      authority.connectionFingerprint
    ) {
      throw new Error(
        "The connected NWC wallet changed after this invoice was created."
      )
    }

    let currentInfo: NwcGetInfoResult
    try {
      currentInfo = await dependencies.getNwcInfo(connection, timeoutMs)
    } catch {
      throw new Error(
        "The connected NWC wallet's current invoice authority is unavailable."
      )
    }
    const currentProfileAuthority = await resolveCurrentProfileAuthority(
      pending.merchantPubkey,
      dependencies
    )
    assertProfilePaymentAuthorityCurrent(authority, currentProfileAuthority)
    if (!currentInfo.methods.includes("make_invoice")) {
      throw new Error(
        "The connected NWC wallet no longer authorizes invoice creation."
      )
    }
    if (
      !hasExactNwcDestination(
        connection,
        currentInfo,
        currentProfileAuthority.lud16
      )
    ) {
      throw new Error(
        "The connected NWC destination no longer matches the current signed profile Lightning address."
      )
    }
    if (
      getNwcConnectionFingerprint(resolveCurrentNwcConnection()) !==
      authority.connectionFingerprint
    ) {
      throw new Error(
        "The connected NWC wallet changed while the saved invoice was being retried."
      )
    }
  }
}

function getInvoiceDeliveryRevalidation(
  pending: MerchantPendingInvoice,
  dependencies: MerchantInvoiceDependencies,
  revalidateAuthority: (() => Promise<void>) | undefined,
  authorityCommitted: boolean
): {
  beforeCheckpoint: () => Promise<void>
  beforeDelivery: (leg: "sender_self_copy" | "recipient") => Promise<void>
} {
  const revalidateExpiry = async () => {
    if (pending.source !== "mock") {
      validateGeneratedInvoice(
        pending.invoice,
        pending.amountMsats,
        dependencies.now()
      )
    }
  }
  const revalidateAuthorityAndExpiry = async () => {
    await revalidateExpiry()
    await revalidateAuthority?.()
    // Authority reads may cross the invoice's expiry boundary. Expiry is the
    // final synchronous check before each critical relay publish.
    await revalidateExpiry()
  }
  const revalidateCommittedHistory = async () => {
    const evidence = await dependencies.refreshConversationEvidence({
      merchantPubkey: pending.merchantPubkey,
      buyerPubkey: pending.buyerPubkey,
      orderId: pending.orderId,
    })
    const hasExactCommittedInvoice =
      assertSignedHistoryCompatibleWithSavedInvoice(
        pending,
        pending,
        evidence,
        dependencies,
        true
      )
    if (evidence.readState !== "complete" || !hasExactCommittedInvoice) {
      throw new MerchantInvoiceHistoryError(
        "history_incomplete",
        "The signed invoice commitment is not yet completely visible. Refresh the order before retrying it."
      )
    }
  }
  return {
    beforeCheckpoint: authorityCommitted
      ? revalidateExpiry
      : revalidateAuthorityAndExpiry,
    beforeDelivery: async (leg) => {
      // A required sender self-copy is the globally visible commitment to this
      // exact signed invoice. After its ACK, other devices can recover that
      // invoice without local authority metadata, so the recipient leg must
      // follow the same invariant and only re-check expiry.
      if (
        authorityCommitted ||
        (pending.delivery === "buyer_and_self" && leg === "recipient")
      ) {
        await revalidateExpiry()
        if (
          !authorityCommitted &&
          pending.delivery === "buyer_and_self" &&
          leg === "recipient"
        ) {
          // The required self-copy ACK is ordered before this callback. A
          // complete fresh read makes concurrent devices converge before any
          // newly issued distinct invoice can reach the buyer. An invoice that
          // was already committed by signed history or durable relay acceptance
          // needs no second convergence read and remains retryable when a later
          // inbox scan is capped or unavailable.
          await revalidateCommittedHistory()
          await revalidateExpiry()
        }
        return
      }
      await revalidateAuthorityAndExpiry()
    },
  }
}

async function deliverPendingInvoice(
  pending: MerchantPendingInvoice,
  dependencies: MerchantInvoiceDependencies,
  uncertainRelayAcceptedInvoices: Map<string, MerchantPendingInvoice>,
  revalidateBeforeDelivery?: (
    leg: "sender_self_copy" | "recipient"
  ) => Promise<void>
): Promise<{
  invoice: MerchantPendingInvoice
  localCheckpointWarning?: "relay_accepted_local_checkpoint_failed"
}> {
  const attempting: MerchantPendingInvoice = {
    ...pending,
    deliveryState: "pending",
    deliveryAttemptCount: pending.deliveryAttemptCount + 1,
    lastDeliveryAttemptAt: dependencies.now(),
    lastFailureCode: undefined,
  }
  await dependencies.store.put(attempting)

  try {
    await dependencies.publish(
      toPublishInput(attempting, revalidateBeforeDelivery)
    )
  } catch (error) {
    try {
      await dependencies.store.put({
        ...attempting,
        lastFailureCode: "relay_delivery_failed",
      })
    } catch {
      // The exact invoice was persisted before the network attempt. Preserve
      // the delivery error without logging invoice or order content.
    }
    throw error
  }

  const relayAccepted: MerchantPendingInvoice = {
    ...attempting,
    deliveryState: "relay_accepted",
    relayAcceptedAt: dependencies.now(),
  }
  try {
    await dependencies.store.put(relayAccepted)
  } catch {
    uncertainRelayAcceptedInvoices.set(pending.id, relayAccepted)
    // Keep the exact accepted record in memory so this session can still show
    // and redeliver it even though the durable checkpoint write failed.
    return {
      invoice: relayAccepted,
      localCheckpointWarning: "relay_accepted_local_checkpoint_failed",
    }
  }
  uncertainRelayAcceptedInvoices.delete(pending.id)
  // Keep the accepted checkpoint as an order-scoped idempotency tombstone.
  // A later tab can acquire the browser lock after this one finishes, so the
  // durable state—not the lock lifetime—must prevent a second invoice issue.
  return { invoice: relayAccepted }
}

async function redeliverAcceptedInvoice(
  accepted: MerchantPendingInvoice,
  dependencies: MerchantInvoiceDependencies,
  uncertainRelayAcceptedInvoices: Map<string, MerchantPendingInvoice>,
  revalidateBeforeDelivery?: (
    leg: "sender_self_copy" | "recipient"
  ) => Promise<void>
): Promise<{
  invoice: MerchantPendingInvoice
  localCheckpointWarning?: "relay_accepted_local_checkpoint_failed"
}> {
  const attempting: MerchantPendingInvoice = {
    ...accepted,
    deliveryAttemptCount: accepted.deliveryAttemptCount + 1,
    lastDeliveryAttemptAt: dependencies.now(),
    lastFailureCode: undefined,
  }

  try {
    await dependencies.publish(
      toPublishInput(attempting, revalidateBeforeDelivery)
    )
  } catch (error) {
    try {
      await dependencies.store.put({
        ...attempting,
        lastFailureCode: "relay_delivery_failed",
      })
    } catch {
      // The durable accepted tombstone still prevents another invoice from
      // being minted even when retry diagnostics cannot be persisted.
    }
    throw error
  }

  const confirmed: MerchantPendingInvoice = {
    ...attempting,
    relayAcceptedAt: dependencies.now(),
  }
  try {
    await dependencies.store.put(confirmed)
  } catch {
    uncertainRelayAcceptedInvoices.set(accepted.id, confirmed)
    return {
      invoice: confirmed,
      localCheckpointWarning: "relay_accepted_local_checkpoint_failed",
    }
  }
  uncertainRelayAcceptedInvoices.delete(accepted.id)
  return { invoice: confirmed }
}

async function acquireProfileInvoice(
  merchantPubkey: string,
  amountMsats: number,
  dependencies: MerchantInvoiceDependencies
): Promise<AcquiredMerchantInvoice> {
  if (dependencies.isMockPayments()) {
    return {
      invoice: dependencies.makeMockInvoice({
        amountSats: amountMsats / 1_000,
      }).invoice,
      source: "mock",
    }
  }
  const authority = await resolveCurrentProfileAuthority(
    merchantPubkey,
    dependencies
  )
  const metadata = await dependencies.fetchLnurlPayMetadata(authority.lud16)
  assertLnurlRange(metadata, amountMsats)
  return {
    // Deliberately omit NIP-57 `nostr` and `lnurl` parameters. Merchant
    // payment requests are ordinary private invoices, not self-zaps.
    ...(await dependencies.fetchLnurlInvoice(metadata.callback, amountMsats)),
    source: "profile_lud16",
    paymentAuthority: {
      type: "profile_lud16",
      lud16: authority.lud16,
      profileFrontierEventId: authority.frontierEventId,
    },
    revalidate: async () => {
      const current = await resolveCurrentProfileAuthority(
        merchantPubkey,
        dependencies
      )
      if (!isSameProfileInvoiceAuthority(authority, current)) {
        throw new Error(
          "The signed profile payment destination changed while the invoice was being created."
        )
      }
    },
  }
}

async function resolveCurrentProfileAuthority(
  merchantPubkey: string,
  dependencies: MerchantInvoiceDependencies
): Promise<ResolvedMerchantProfileInvoiceAuthority> {
  const resolved = await dependencies.resolveProfileLud16(merchantPubkey)
  const lud16 = (typeof resolved === "string" ? resolved : resolved.lud16)
    .trim()
    .toLowerCase()
  const frontierEventId =
    typeof resolved === "string"
      ? null
      : resolved.frontierEventId.trim().toLowerCase()
  if (
    !isValidLud16Address(lud16) ||
    (frontierEventId !== null && !/^[0-9a-f]{64}$/.test(frontierEventId))
  ) {
    throw new Error(
      "A current signed profile Lightning address is unavailable."
    )
  }
  return { lud16, frontierEventId }
}

function isSameProfileInvoiceAuthority(
  expected: ResolvedMerchantProfileInvoiceAuthority,
  current: ResolvedMerchantProfileInvoiceAuthority
): boolean {
  if (expected.lud16 !== current.lud16) return false
  if (expected.frontierEventId !== null || current.frontierEventId !== null) {
    return (
      expected.frontierEventId !== null &&
      expected.frontierEventId === current.frontierEventId
    )
  }
  return true
}

function hasExactNwcDestination(
  connection: NwcConnection,
  info: NwcGetInfoResult,
  profileLud16: string
): boolean {
  const connectionLud16 = connection.lud16?.trim().toLowerCase()
  if (
    !connectionLud16 ||
    !isValidLud16Address(connectionLud16) ||
    connectionLud16 !== profileLud16
  ) {
    return false
  }

  // `lud16` is a non-standard get_info extension. Treat an omitted or blank
  // extension as absent; the signed URI remains the standard NWC authority.
  if (info.lud16 === undefined || info.lud16.trim() === "") return true
  const liveExtensionLud16 = info.lud16.trim().toLowerCase()
  return (
    isValidLud16Address(liveExtensionLud16) &&
    liveExtensionLud16 === profileLud16
  )
}

async function acquireInvoice(
  source: MerchantInvoiceSelection,
  amountMsats: number,
  merchantPubkey: string,
  orderId: string,
  dependencies: MerchantInvoiceDependencies
): Promise<AcquiredMerchantInvoice> {
  if (source.type === "profile_lud16") {
    return acquireProfileInvoice(merchantPubkey, amountMsats, dependencies)
  }
  if (source.type === "manual") {
    return { invoice: source.invoice, source: "manual" }
  }
  if (source.type === "webln") {
    const timeoutMs = dependencies.webLnTimeoutMs ?? 15_000
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const invoice = await Promise.race([
        dependencies.makeWeblnInvoice({
          amountSats: amountMsats / 1_000,
          memo: `Conduit order ${orderId}`,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("Browser wallet invoice request timed out.")),
            timeoutMs
          )
        }),
      ])
      return { ...invoice, source: "webln" }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  if (source.type === "nwc") {
    const timeoutMs = dependencies.nwcTimeoutMs ?? 15_000
    source.assertCurrentConnection?.()
    const profileAuthority = await resolveCurrentProfileAuthority(
      merchantPubkey,
      dependencies
    )
    source.assertCurrentConnection?.()
    let currentInfo: NwcGetInfoResult
    source.assertCurrentConnection?.()
    try {
      currentInfo = await dependencies.getNwcInfo(source.connection, timeoutMs)
    } catch {
      throw new Error(
        "The connected NWC wallet's current invoice capability and destination are unavailable."
      )
    }
    source.assertCurrentConnection?.()
    if (!currentInfo.methods.includes("make_invoice")) {
      throw new Error(
        "The connected NWC wallet does not currently authorize invoice creation."
      )
    }
    if (
      !hasExactNwcDestination(
        source.connection,
        currentInfo,
        profileAuthority.lud16
      )
    ) {
      throw new Error(
        "The connected NWC destination must exactly match the current signed profile Lightning address."
      )
    }
    source.assertCurrentConnection?.()
    const invoice = await dependencies.makeNwcInvoice(
      source.connection,
      {
        amountMsats,
        description: `Conduit order ${orderId}`,
      },
      timeoutMs
    )
    source.assertCurrentConnection?.()
    return {
      ...invoice,
      source: "nwc",
      paymentAuthority: {
        type: "nwc",
        lud16: profileAuthority.lud16,
        profileFrontierEventId: profileAuthority.frontierEventId,
        connectionFingerprint: getNwcConnectionFingerprint(source.connection),
      },
      revalidate: async () => {
        let revalidatedInfo: NwcGetInfoResult
        source.assertCurrentConnection?.()
        try {
          revalidatedInfo = await dependencies.getNwcInfo(
            source.connection,
            timeoutMs
          )
        } catch {
          throw new Error(
            "The connected NWC wallet's current invoice capability and destination are unavailable."
          )
        }
        source.assertCurrentConnection?.()
        const currentProfileAuthority = await resolveCurrentProfileAuthority(
          merchantPubkey,
          dependencies
        )
        if (
          !isSameProfileInvoiceAuthority(
            profileAuthority,
            currentProfileAuthority
          )
        ) {
          throw new Error(
            "The signed profile payment destination changed while the invoice was being created."
          )
        }
        if (!revalidatedInfo.methods.includes("make_invoice")) {
          throw new Error(
            "The connected NWC wallet no longer authorizes invoice creation."
          )
        }
        if (
          !hasExactNwcDestination(
            source.connection,
            revalidatedInfo,
            currentProfileAuthority.lud16
          )
        ) {
          throw new Error(
            "The connected NWC destination no longer matches the current signed profile Lightning address."
          )
        }
        source.assertCurrentConnection?.()
      },
    }
  }
  throw new Error("This invoice source is not available yet.")
}

async function runExclusiveInvoiceAction<T>(
  dependencies: MerchantInvoiceDependencies,
  scopeId: string,
  action: () => Promise<T>
): Promise<T> {
  const runWithProcessGuard = async () => {
    if (fallbackActiveInvoiceScopes.has(scopeId)) {
      throw new Error(
        "An invoice action is already in progress for this order."
      )
    }
    fallbackActiveInvoiceScopes.add(scopeId)
    try {
      return await action()
    } finally {
      fallbackActiveInvoiceScopes.delete(scopeId)
    }
  }

  const lockManager =
    dependencies.lockManager === undefined
      ? getBrowserInvoiceLockManager()
      : dependencies.lockManager
  const requireCrossContextLock =
    dependencies.requireCrossContextLock ?? typeof window !== "undefined"
  if (!lockManager) {
    if (requireCrossContextLock) {
      throw new Error(
        "This browser cannot safely coordinate invoice actions across tabs."
      )
    }
    return runWithProcessGuard()
  }

  return lockManager.request(
    `conduit:merchant-invoice:${scopeId}`,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        throw new Error(
          "An invoice action is already in progress for this order."
        )
      }
      return runWithProcessGuard()
    }
  )
}

const fallbackActiveInvoiceScopes = new Set<string>()

function getBrowserInvoiceLockManager(): MerchantInvoiceLockManager | null {
  if (
    typeof navigator === "undefined" ||
    !("locks" in navigator) ||
    !navigator.locks
  ) {
    return null
  }
  return navigator.locks as unknown as MerchantInvoiceLockManager
}

function assertSavedInvoiceBuyer(
  saved: MerchantPendingInvoice,
  buyerPubkey: string,
  action: string
): void {
  if (saved.buyerPubkey !== buyerPubkey) {
    throw new Error(
      `The saved invoice belongs to a different buyer and cannot be ${action}.`
    )
  }
}

export function createMerchantInvoiceModule(
  dependencies: MerchantInvoiceDependencies
): MerchantInvoiceModule {
  const uncertainRelayAcceptedInvoices = new Map<
    string,
    MerchantPendingInvoice
  >()
  return {
    async getPending(
      input: MerchantInvoiceScope & {
        conversationEvidence?: MerchantConversationInvoiceEvidence
      }
    ): Promise<MerchantPendingInvoice | null> {
      const scope = validateScope(input)
      const scopeId = pendingInvoiceId(scope.merchantPubkey, scope.orderId)
      const uncertain = uncertainRelayAcceptedInvoices.get(scopeId)
      if (uncertain) {
        assertSavedInvoiceBuyer(uncertain, scope.buyerPubkey, "used")
        assertSignedHistoryCompatibleWithSavedInvoice(
          scope,
          uncertain,
          input.conversationEvidence,
          dependencies
        )
        return uncertain
      }
      return runExclusiveInvoiceAction(dependencies, scopeId, async () => {
        const acceptedDuringLock = uncertainRelayAcceptedInvoices.get(scopeId)
        if (acceptedDuringLock) {
          assertSavedInvoiceBuyer(acceptedDuringLock, scope.buyerPubkey, "used")
          assertSignedHistoryCompatibleWithSavedInvoice(
            scope,
            acceptedDuringLock,
            input.conversationEvidence,
            dependencies
          )
          return acceptedDuringLock
        }
        const saved = await dependencies.store.get(
          scope.merchantPubkey,
          scope.orderId
        )
        if (saved) {
          assertSavedInvoiceBuyer(saved, scope.buyerPubkey, "used")
          assertSignedHistoryCompatibleWithSavedInvoice(
            scope,
            saved,
            input.conversationEvidence,
            dependencies
          )
          return saved
        }
        if (!input.conversationEvidence) return null
        const reconciled = await reconcileConversationInvoiceHistory(
          scope,
          input.conversationEvidence,
          dependencies
        )
        return reconciled.state === "recoverable" ? reconciled.invoice : null
      })
    },
    async discardExpired(input: MerchantInvoiceScope): Promise<void> {
      const scope = validateScope(input)
      const scopeId = pendingInvoiceId(scope.merchantPubkey, scope.orderId)
      await runExclusiveInvoiceAction(dependencies, scopeId, async () => {
        const saved =
          uncertainRelayAcceptedInvoices.get(scopeId) ??
          (await dependencies.store.get(scope.merchantPubkey, scope.orderId))
        if (!saved) return
        if (saved.buyerPubkey !== scope.buyerPubkey) {
          throw new Error(
            "The saved invoice belongs to a different buyer and cannot be discarded."
          )
        }
        if (saved.invoiceExpiresAt > Math.floor(dependencies.now() / 1_000)) {
          throw new Error(
            "The saved invoice is not expired and cannot be replaced."
          )
        }
        await dependencies.store.delete(scope.merchantPubkey, scope.orderId)
        uncertainRelayAcceptedInvoices.delete(scopeId)
      })
    },
    async deliver(
      input: DeliverMerchantInvoiceInput
    ): Promise<DeliverMerchantInvoiceResult> {
      const scope = validateScope(input)
      const scopeId = pendingInvoiceId(scope.merchantPubkey, scope.orderId)
      return runExclusiveInvoiceAction(dependencies, scopeId, async () => {
        if (input.mode === "retry") {
          if (!input.conversationEvidence) {
            throw new MerchantInvoiceHistoryError(
              "history_incomplete",
              "Invoice history is unavailable. Refresh the order before retrying an invoice."
            )
          }
          const saved =
            uncertainRelayAcceptedInvoices.get(scopeId) ??
            (await dependencies.store.get(scope.merchantPubkey, scope.orderId))
          if (!saved) {
            throw new Error("No saved invoice is available for retry.")
          }
          if (saved.buyerPubkey !== scope.buyerPubkey) {
            throw new Error(
              "The saved invoice belongs to a different buyer and cannot be retried."
            )
          }
          if (saved.source !== "mock") {
            validateGeneratedInvoice(
              saved.invoice,
              saved.amountMsats,
              dependencies.now()
            )
          }
          assertSignedHistoryCompatibleWithSavedInvoice(
            scope,
            saved,
            input.conversationEvidence,
            dependencies
          )
          const refreshedConversationEvidence =
            await dependencies.refreshConversationEvidence(scope)
          const authorityCommittedByHistory =
            assertSignedHistoryCompatibleWithSavedInvoice(
              scope,
              saved,
              refreshedConversationEvidence,
              dependencies,
              true
            )
          const authorityCommitted =
            saved.deliveryState === "relay_accepted" ||
            authorityCommittedByHistory
          const deliveryRevalidation = getInvoiceDeliveryRevalidation(
            saved,
            dependencies,
            authorityCommitted
              ? undefined
              : getSavedInvoiceAuthorityRevalidator(
                  saved,
                  input.resolveCurrentNwcConnection,
                  dependencies
                ),
            authorityCommitted
          )
          // The history and authority reads above may outlive a short invoice.
          // Re-check immediately before recording a new delivery attempt.
          await deliveryRevalidation.beforeCheckpoint()
          const delivered =
            saved.deliveryState === "relay_accepted"
              ? await redeliverAcceptedInvoice(
                  saved,
                  dependencies,
                  uncertainRelayAcceptedInvoices,
                  deliveryRevalidation.beforeDelivery
                )
              : await deliverPendingInvoice(
                  saved,
                  dependencies,
                  uncertainRelayAcceptedInvoices,
                  deliveryRevalidation.beforeDelivery
                )
          return {
            invoice: delivered.invoice.invoice,
            source: delivered.invoice.source,
            reused: true,
            relayAcceptance: "accepted",
            ...(delivered.localCheckpointWarning
              ? { localCheckpointWarning: delivered.localCheckpointWarning }
              : {}),
          }
        }

        if (uncertainRelayAcceptedInvoices.has(scopeId)) {
          throw new Error(
            "This invoice already reached a recipient relay and cannot be replaced."
          )
        }

        const existing = await dependencies.store.get(
          scope.merchantPubkey,
          scope.orderId
        )
        if (existing) {
          assertSavedInvoiceBuyer(existing, scope.buyerPubkey, "replaced")
        }
        if (existing) {
          if (existing.deliveryState === "relay_accepted") {
            throw new Error(
              "This invoice already reached a recipient relay and cannot be replaced."
            )
          }
          throw new Error(
            "A saved invoice still needs delivery. Retry it before creating another."
          )
        }

        const reconciled = await reconcileConversationInvoiceHistory(
          scope,
          input.conversationEvidence,
          dependencies
        )
        if (reconciled.state === "recoverable") {
          throw new Error(
            "A signed invoice was recovered from this order. Retry that exact invoice before creating another."
          )
        }

        const amountMsats = assertAmount(input.amountSats)
        const acquired = await acquireInvoice(
          input.source,
          amountMsats,
          scope.merchantPubkey,
          scope.orderId,
          dependencies
        )
        const validated =
          acquired.source === "mock"
            ? {
                invoice: acquired.invoice,
                paymentHash: "mock",
                invoiceCreatedAt: Math.floor(dependencies.now() / 1_000),
                invoiceExpiresAt:
                  Math.floor(dependencies.now() / 1_000) + 3_600,
              }
            : validateGeneratedInvoice(
                acquired.invoice,
                amountMsats,
                dependencies.now()
              )
        const pending: MerchantPendingInvoice = {
          id: pendingInvoiceId(scope.merchantPubkey, scope.orderId),
          ...scope,
          ...validated,
          amountMsats,
          note: input.note?.trim() || undefined,
          delivery: input.delivery,
          source: acquired.source,
          ...(acquired.paymentAuthority
            ? { paymentAuthority: acquired.paymentAuthority }
            : {}),
          deliveryState: "pending",
          deliveryAttemptCount: 0,
          savedAt: dependencies.now(),
        }

        const refreshedConversationEvidence =
          await dependencies.refreshConversationEvidence(scope)
        assertSignedHistoryAllowsFreshInvoice(
          scope,
          refreshedConversationEvidence,
          dependencies
        )
        const deliveryRevalidation = getInvoiceDeliveryRevalidation(
          pending,
          dependencies,
          acquired.revalidate,
          false
        )
        // Payment authority and invoice expiry are rechecked immediately before
        // persistence, then again at each critical relay transport boundary.
        await deliveryRevalidation.beforeCheckpoint()
        await dependencies.store.put(pending)
        const delivered = await deliverPendingInvoice(
          pending,
          dependencies,
          uncertainRelayAcceptedInvoices,
          deliveryRevalidation.beforeDelivery
        )

        return {
          invoice: delivered.invoice.invoice,
          source: delivered.invoice.source,
          reused: false,
          relayAcceptance: "accepted",
          ...(delivered.localCheckpointWarning
            ? { localCheckpointWarning: delivered.localCheckpointWarning }
            : {}),
        }
      })
    },
  }
}

export function createDefaultMerchantInvoiceModule(
  store: MerchantPendingInvoiceStore = new DexieMerchantPendingInvoiceStore()
): MerchantInvoiceModule {
  return createMerchantInvoiceModule({
    store,
    fetchLnurlPayMetadata,
    fetchLnurlInvoice,
    makeWeblnInvoice: weblnMakeInvoice,
    getNwcInfo: (connection, timeoutMs) =>
      nwcGetInfo(connection, timeoutMs, "merchant"),
    makeNwcInvoice: (connection, input, timeoutMs) =>
      nwcMakeInvoice(connection, input, timeoutMs, "merchant"),
    makeMockInvoice: mockMakeInvoice,
    isMockPayments: canMockInvoice,
    resolveProfileLud16: async (merchantPubkey) => {
      try {
        const result = await getAuthoritativeProfileLud16(merchantPubkey)
        if (
          !result.data ||
          !result.authority.frontierConfirmed ||
          result.authority.degraded ||
          result.authority.capped
        ) {
          throw new Error("profile authority unavailable")
        }
        const frontierEventId = result.authority.frontierEventId
        if (!frontierEventId) {
          throw new Error("profile authority unavailable")
        }
        return { lud16: result.data, frontierEventId }
      } catch {
        throw new Error(
          "A current signed profile Lightning address is unavailable."
        )
      }
    },
    refreshConversationEvidence: loadCurrentMerchantConversationInvoiceEvidence,
    publish: publishMerchantOrderMessage,
    now: Date.now,
  })
}
