import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"
import type {
  CheckoutSparkNativeTreasuryPlan,
  CheckoutSparkNativeTreasuryObservation,
} from "./checkout-spark-treasury-finalization"

export const CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY =
  "spark-sdk-0.13.0-invoice-zero-fee-v1" as const

/** Dependency upgrades require a fresh review of native fee/debit semantics. */
export function getCheckoutSparkNativeTreasuryPolicyForSdkVersion(
  version: unknown
): typeof CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY | undefined {
  return version === "0.13.0"
    ? CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY
    : undefined
}

export type CheckoutSparkNativeTreasurySdkNetwork = "MAINNET" | "REGTEST"
export interface CheckoutSparkNativeTreasurySdkPrepareInput {
  readonly network: CheckoutSparkNetwork
  readonly sparkAddress: string
  readonly receiverIdentityPublicKey?: string
  readonly senderIdentityPublicKey: string
  readonly invoiceId: string
}
export interface CheckoutSparkNativeTreasurySdkDestination {
  readonly sparkAddress: string
  readonly receiverIdentityPublicKey: string
}
export interface CheckoutSparkNativeTreasurySdkInput {
  readonly network: CheckoutSparkNetwork
  readonly nativeTreasury: CheckoutSparkNativeTreasuryPlan
  readonly amountSats: number
  readonly authorizedDebitSats: number
  readonly providerTransferId?: string | null
}
export interface CheckoutSparkNativeTreasurySdkSendInput extends CheckoutSparkNativeTreasurySdkInput {
  /** Set from durable prior admission, never inferred from an empty query. */
  readonly priorSendMayHaveOccurred: boolean
  readonly assertBeforeSend?: () => Promise<void>
}
export type CheckoutSparkNativeTreasurySdkPreflight =
  | "ready"
  | "fee_over_cap"
  | "insufficient_funds"
  | "unavailable"
  | "recipient_unverified"
export type CheckoutSparkNativeTreasurySdkSendResult = {
  readonly status: "submitted" | "ambiguous" | "not_sent"
  readonly providerTransferId?: string
  /** Content-free observation only; never permission to retry an admitted send. */
  readonly reason?: CheckoutSparkNativeTreasurySdkSendReason
}
export type CheckoutSparkNativeTreasurySdkSendReason =
  | "invoice_rejected"
  | "provider_validation"
  | "provider_request"
  | "provider_authentication"
  | "provider_error"
  | "provider_unavailable"
  | "unrecognized_result"
export interface CheckoutSparkNativeTreasurySdkTransfer {
  readonly id: string
  readonly status: string
  readonly totalValue: number
  readonly type: string
  readonly transferDirection: string
  readonly receiverIdentityPublicKey?: string
  readonly senderIdentityPublicKey?: string
  readonly valueSentByWallet?: number
  readonly valueReceivedByWallet?: number
  readonly sparkInvoice?: string
  readonly senders?: Array<{ identityPublicKey: string }>
  readonly receivers?: Array<{
    identityPublicKey: string
    amountSats: number
    status: string
  }>
}
export interface CheckoutSparkNativeTreasurySdkInvoiceQuery {
  readonly invoiceStatuses: Array<{
    invoice: string
    status: number
    transferType?:
      | { $case: "satsTransfer"; satsTransfer: { transferId: Uint8Array } }
      | {
          $case: "tokenTransfer"
          tokenTransfer: { finalTokenTransactionHash: Uint8Array }
        }
  }>
}
export interface CheckoutSparkNativeTreasurySdkWallet {
  getIdentityPublicKey(): Promise<string>
  getBalance(): Promise<{
    satsBalance: { available: bigint; owned: bigint; incoming: bigint }
  }>
  getTransfer(
    id: string
  ): Promise<CheckoutSparkNativeTreasurySdkTransfer | undefined>
  querySparkInvoices?(
    invoices: string[]
  ): Promise<CheckoutSparkNativeTreasurySdkInvoiceQuery>
  /** Public sats fulfillment only; deliberately no invented caller transfer ID. */
  fulfillSparkInvoice?(
    invoices: Array<{ invoice: string; amount: bigint }>
  ): Promise<unknown>
}
export interface CheckoutSparkNativeTreasurySdkCodec {
  readonly nativeTreasuryPolicy?: typeof CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY
  parseTransferId(value: string): {
    toString(): string
    readonly bytes: Uint8Array
  }
  encodeSparkAddress?(payload: {
    identityPublicKey: string
    network: CheckoutSparkNativeTreasurySdkNetwork
    sparkInvoiceFields: {
      version: number
      id: Uint8Array
      paymentType: { $case: "satsPayment"; satsPayment: { amount: undefined } }
      senderPublicKey: Uint8Array
    }
  }): string
  decodeSparkAddress(
    address: string,
    network: CheckoutSparkNativeTreasurySdkNetwork
  ): { sparkInvoiceFields?: unknown; identityPublicKey?: string }
  isValidSparkAddress(address: string): boolean
  getNetworkFromSparkAddress(address: string): string
}
function toNativeNetwork(
  network: CheckoutSparkNetwork
): CheckoutSparkNativeTreasurySdkNetwork {
  if (network !== "mainnet" && network !== "regtest") {
    throw new Error("Checkout Spark treasury network is invalid.")
  }
  return network === "mainnet" ? "MAINNET" : "REGTEST"
}

/** Static-address authority is independent of any invoice embedded by a caller. */
export function validateCheckoutSparkNativeTreasuryDestination(
  module: CheckoutSparkNativeTreasurySdkCodec,
  request: Pick<
    CheckoutSparkNativeTreasurySdkPrepareInput,
    "network" | "sparkAddress"
  >
): CheckoutSparkNativeTreasurySdkDestination {
  const network = toNativeNetwork(request.network)
  if (
    typeof request.sparkAddress !== "string" ||
    request.sparkAddress.length > 16_384 ||
    request.sparkAddress !== request.sparkAddress.trim() ||
    !module.isValidSparkAddress(request.sparkAddress) ||
    module.getNetworkFromSparkAddress(request.sparkAddress) !== network
  ) {
    throw new Error("Checkout Spark treasury address is invalid.")
  }
  const decoded = module.decodeSparkAddress(request.sparkAddress, network)
  if (
    decoded.sparkInvoiceFields !== undefined ||
    typeof decoded.identityPublicKey !== "string" ||
    !/^(02|03)[0-9a-f]{64}$/.test(decoded.identityPublicKey)
  ) {
    throw new Error(
      "Checkout Spark treasury must use a static receiving address."
    )
  }
  return Object.freeze({
    sparkAddress: request.sparkAddress,
    receiverIdentityPublicKey: decoded.identityPublicKey,
  })
}

/** Public pure codec only: deliberately no receiver signature, expiry or amount. */
export function prepareCheckoutSparkNativeTreasuryRequest(
  module: CheckoutSparkNativeTreasurySdkCodec,
  request: CheckoutSparkNativeTreasurySdkPrepareInput
): CheckoutSparkNativeTreasuryPlan {
  if (!module.encodeSparkAddress) {
    throw new Error("This Spark adapter cannot encode a treasury request.")
  }
  const destination = validateCheckoutSparkNativeTreasuryDestination(
    module,
    request
  )
  const invoiceId = module.parseTransferId(request.invoiceId)
  if (
    invoiceId.toString() !== request.invoiceId ||
    !(invoiceId.bytes instanceof Uint8Array) ||
    invoiceId.bytes.length !== 16 ||
    (request.receiverIdentityPublicKey !== undefined &&
      request.receiverIdentityPublicKey !==
        destination.receiverIdentityPublicKey) ||
    !/^(02|03)[0-9a-f]{64}$/.test(request.senderIdentityPublicKey) ||
    request.senderIdentityPublicKey === destination.receiverIdentityPublicKey
  ) {
    throw new Error("Checkout Spark treasury request authority is invalid.")
  }
  const invoiceRequest = module.encodeSparkAddress({
    identityPublicKey: destination.receiverIdentityPublicKey,
    network: toNativeNetwork(request.network),
    sparkInvoiceFields: {
      version: 1,
      id: invoiceId.bytes,
      paymentType: { $case: "satsPayment", satsPayment: { amount: undefined } },
      senderPublicKey: Uint8Array.from(
        request.senderIdentityPublicKey.match(/.{2}/g)!,
        (byte) => Number.parseInt(byte, 16)
      ),
    },
  })
  return Object.freeze({
    schemaVersion: 1,
    ...destination,
    senderIdentityPublicKey: request.senderIdentityPublicKey,
    invoiceId: request.invoiceId,
    invoiceRequest,
    feePolicy: "zero_required",
    residualPolicy: "unused_commerce_reserves",
  })
}

function validateCheckoutTreasuryInput(
  module: CheckoutSparkNativeTreasurySdkCodec,
  network: CheckoutSparkNativeTreasurySdkNetwork,
  request: CheckoutSparkNativeTreasurySdkInput
): CheckoutSparkNativeTreasurySdkInput {
  if (
    toNativeNetwork(request.network) !== network ||
    !Number.isSafeInteger(request.amountSats) ||
    request.amountSats <= 0 ||
    request.authorizedDebitSats !== request.amountSats ||
    request.nativeTreasury?.schemaVersion !== 1 ||
    request.nativeTreasury.feePolicy !== "zero_required" ||
    request.nativeTreasury.residualPolicy !== "unused_commerce_reserves"
  ) {
    throw new Error("Checkout Spark treasury amount or policy is invalid.")
  }
  const nativeTreasury = prepareCheckoutSparkNativeTreasuryRequest(module, {
    network: request.network,
    ...request.nativeTreasury,
  })
  // Re-encoding excludes hidden amounts, signatures, expiry, sender substitutions
  // and alternative invoice bytes even when their invoice UUID happens to match.
  if (nativeTreasury.invoiceRequest !== request.nativeTreasury.invoiceRequest) {
    throw new Error("Checkout Spark treasury request changed.")
  }
  const providerTransferId = request.providerTransferId ?? null
  if (
    providerTransferId !== null &&
    module.parseTransferId(providerTransferId).toString() !== providerTransferId
  ) {
    throw new Error("Checkout Spark treasury transfer identity is invalid.")
  }
  return Object.freeze({
    network: request.network,
    nativeTreasury,
    amountSats: request.amountSats,
    authorizedDebitSats: request.authorizedDebitSats,
    providerTransferId,
  })
}

function nativeTransferIdFromBytes(
  module: CheckoutSparkNativeTreasurySdkCodec,
  bytes: Uint8Array
): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) {
    throw new Error("Checkout Spark treasury transfer identity is invalid.")
  }
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return module
    .parseTransferId(
      [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20),
      ].join("-")
    )
    .toString()
}

// Spark can cancel only before the sender key tweak. These states prove the
// exact debit is committed even when the receiver claims it after going online.
const IRREVERSIBLY_COMMITTED_TRANSFER_STATUSES = new Set([
  "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
  "TRANSFER_STATUS_RECEIVER_KEY_TWEAKED",
  "TRANSFER_STATUS_RECEIVER_REFUND_SIGNED",
  "TRANSFER_STATUS_RECEIVER_KEY_TWEAK_LOCKED",
  "TRANSFER_STATUS_RECEIVER_KEY_TWEAK_APPLIED",
])
const COMMITTED_RECEIVER_STATUSES = new Set([
  "TRANSFER_RECEIVER_STATUS_CLAIM_PENDING",
  "TRANSFER_RECEIVER_STATUS_KEY_TWEAKED",
  "TRANSFER_RECEIVER_STATUS_KEY_TWEAK_LOCKED",
  "TRANSFER_RECEIVER_STATUS_KEY_TWEAK_APPLIED",
  "TRANSFER_RECEIVER_STATUS_REFUND_SIGNED",
  "TRANSFER_RECEIVER_STATUS_COMPLETED",
])

function exactCheckoutTreasuryTransfer(
  request: CheckoutSparkNativeTreasurySdkInput,
  providerTransferId: string,
  transfer: CheckoutSparkNativeTreasurySdkTransfer
): CheckoutSparkNativeTreasuryObservation {
  const invoiceId = request.nativeTreasury.invoiceId
  const sender = request.nativeTreasury.senderIdentityPublicKey
  const receiver = request.nativeTreasury.receiverIdentityPublicKey
  if (
    transfer.id !== providerTransferId ||
    transfer.sparkInvoice !== request.nativeTreasury.invoiceRequest ||
    transfer.type !== "TRANSFER" ||
    transfer.transferDirection !== "OUTGOING" ||
    transfer.totalValue !== request.amountSats ||
    transfer.valueSentByWallet !== request.authorizedDebitSats ||
    transfer.valueReceivedByWallet !== 0 ||
    transfer.senders?.length !== 1 ||
    transfer.senders[0]?.identityPublicKey !== sender ||
    transfer.receivers?.length !== 1 ||
    transfer.receivers[0]?.identityPublicKey !== receiver ||
    transfer.receivers[0]?.amountSats !== request.amountSats ||
    (transfer.senderIdentityPublicKey &&
      transfer.senderIdentityPublicKey !== sender) ||
    (transfer.receiverIdentityPublicKey &&
      transfer.receiverIdentityPublicKey !== receiver)
  )
    return { invoiceId, status: "conflicting_evidence" }
  if (
    transfer.status === "TRANSFER_STATUS_RETURNED" ||
    transfer.status === "TRANSFER_STATUS_EXPIRED"
  ) {
    // A failure/return is attention evidence, not proof of an available refund.
    return { invoiceId, providerTransferId, status: "terminal_failure" }
  }
  if (transfer.status === "TRANSFER_STATUS_COMPLETED") {
    if (transfer.receivers[0].status !== "TRANSFER_RECEIVER_STATUS_COMPLETED") {
      return { invoiceId, status: "conflicting_evidence" }
    }
    return {
      invoiceId,
      providerTransferId,
      status: "paid",
      finalFeeSats: 0,
      finalDebitSats: request.authorizedDebitSats,
    }
  }
  if (IRREVERSIBLY_COMMITTED_TRANSFER_STATUSES.has(transfer.status)) {
    if (!COMMITTED_RECEIVER_STATUSES.has(transfer.receivers[0].status)) {
      return { invoiceId, status: "conflicting_evidence" }
    }
    return {
      invoiceId,
      providerTransferId,
      status: "paid",
      finalFeeSats: 0,
      finalDebitSats: request.authorizedDebitSats,
    }
  }
  const pendingPhases = {
    TRANSFER_STATUS_SENDER_INITIATED: "sender",
    TRANSFER_STATUS_SENDER_KEY_TWEAK_PENDING: "sender",
    TRANSFER_STATUS_SENDER_INITIATED_COORDINATOR: "sender",
    TRANSFER_STATUS_APPLYING_SENDER_KEY_TWEAK: "sender",
  } as const
  return typeof transfer.status === "string" &&
    Object.hasOwn(pendingPhases, transfer.status)
    ? {
        invoiceId,
        providerTransferId,
        status: "pending",
        pendingPhase:
          pendingPhases[transfer.status as keyof typeof pendingPhases],
      }
    : { invoiceId, status: "conflicting_evidence" }
}

/** Diagnostic observations only: none grants settlement, retry or spend authority. */
export type CheckoutSparkNativeTreasuryHistoryDiagnostic =
  | "unavailable"
  | "no_exact_match_in_bounded_history"
  | "multiple_matches"
  | "exact_pending"
  | "exact_returned"
  | "history_commit_invoice_unresolved"
  | "exact_commit_and_finalized_invoice"
  | "conflicting"

export interface CheckoutSparkNativeTreasuryHistoryDiagnosticInput {
  readonly codec: CheckoutSparkNativeTreasurySdkCodec
  readonly network: CheckoutSparkNativeTreasurySdkNetwork
  readonly request: CheckoutSparkNativeTreasurySdkInput
  readonly walletIdentityPublicKey: string
  readonly invoiceQuery: CheckoutSparkNativeTreasurySdkInvoiceQuery | null
  /** Caller-owned bounded authenticated history, not a complete-absence proof. */
  readonly transfers: readonly CheckoutSparkNativeTreasurySdkTransfer[] | null
  /** Fresh exact-ID read; caller enforces session, network and read deadlines. */
  getTransfer(
    id: string
  ): Promise<CheckoutSparkNativeTreasurySdkTransfer | undefined>
}

/**
 * Inspect a frozen native attempt without changing its financial state. Raw
 * provider records stay within this invocation; only a content-free enum leaves
 * it. The caller owns authenticated reads, pagination bounds and session checks.
 */
export async function inspectCheckoutSparkNativeTreasuryHistory(
  input: CheckoutSparkNativeTreasuryHistoryDiagnosticInput
): Promise<CheckoutSparkNativeTreasuryHistoryDiagnostic> {
  let exact: CheckoutSparkNativeTreasurySdkInput
  let candidate: CheckoutSparkNativeTreasurySdkTransfer
  let candidateStatus: CheckoutSparkNativeTreasuryObservation["status"]
  let invoiceStatus: number
  let queriedTransferId: string | null = null
  try {
    exact = validateCheckoutTreasuryInput(
      input.codec,
      input.network,
      input.request
    )
    if (
      input.walletIdentityPublicKey !==
      exact.nativeTreasury.senderIdentityPublicKey
    )
      return "conflicting"
    if (input.invoiceQuery === null || input.transfers === null)
      return "unavailable"
    const entries = input.invoiceQuery.invoiceStatuses
    if (!Array.isArray(entries) || entries.length !== 1) return "conflicting"
    const entry = entries[0]!
    if (
      entry.invoice !== exact.nativeTreasury.invoiceRequest ||
      ![0, 1, 2, 4].includes(entry.status)
    )
      return "conflicting"
    invoiceStatus = entry.status
    if (entry.status === 0) {
      if (entry.transferType) return "conflicting"
    } else {
      if (entry.transferType?.$case !== "satsTransfer") return "conflicting"
      queriedTransferId = nativeTransferIdFromBytes(
        input.codec,
        entry.transferType.satsTransfer.transferId
      )
    }
    const matches = new Map<string, CheckoutSparkNativeTreasurySdkTransfer>()
    for (const transfer of input.transfers) {
      if (transfer.sparkInvoice !== exact.nativeTreasury.invoiceRequest)
        continue
      const previous = matches.get(transfer.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(transfer))
        return "conflicting"
      matches.set(transfer.id, transfer)
    }
    if (matches.size === 0) return "no_exact_match_in_bounded_history"
    if (matches.size !== 1) return "multiple_matches"
    candidate = structuredClone(matches.values().next().value!)
    if (
      input.codec.parseTransferId(candidate.id).toString() !== candidate.id ||
      (exact.providerTransferId && exact.providerTransferId !== candidate.id) ||
      (queriedTransferId && queriedTransferId !== candidate.id)
    )
      return "conflicting"
    candidateStatus = exactCheckoutTreasuryTransfer(
      exact,
      candidate.id,
      candidate
    ).status
    if (candidateStatus === "conflicting_evidence") return "conflicting"
  } catch {
    return "conflicting"
  }
  let fresh: CheckoutSparkNativeTreasurySdkTransfer | undefined
  try {
    fresh = await input.getTransfer(candidate.id)
  } catch {
    return "unavailable"
  }
  if (!fresh) return "unavailable"
  try {
    const observed = exactCheckoutTreasuryTransfer(exact, candidate.id, fresh)
    if (
      (candidateStatus === "paid" || candidateStatus === "terminal_failure") &&
      observed.status !== candidateStatus
    )
      return "conflicting"
    if (observed.status === "terminal_failure")
      return invoiceStatus === 2 ? "conflicting" : "exact_returned"
    if (observed.status === "pending" && [0, 1].includes(invoiceStatus))
      return "exact_pending"
    if (observed.status === "paid" && invoiceStatus === 0)
      return "history_commit_invoice_unresolved"
    return observed.status === "paid" &&
      invoiceStatus === 2 &&
      queriedTransferId === candidate.id
      ? "exact_commit_and_finalized_invoice"
      : "conflicting"
  } catch {
    return "conflicting"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Names are an allowlisted diagnostic, not provider or retry authority. Never
 * inspect SDK error messages/context: those may embed invoices and identities.
 */
function fulfillmentErrorReason(
  error: unknown,
  fallback: "provider_error" | "provider_unavailable"
): CheckoutSparkNativeTreasurySdkSendReason {
  try {
    if (!record(error)) return fallback
    switch (error.name) {
      case "SparkValidationError":
        return "provider_validation"
      case "SparkRequestError":
        return "provider_request"
      case "SparkAuthenticationError":
        return "provider_authentication"
    }
  } catch {
    // An opaque rejection must not turn classification into another rejection.
  }
  return fallback
}

/** SDK 0.13.0 fulfills batches with structured successes/errors, not a success
 * boolean or a thrown error for every refusal. Even its sats error branch can
 * follow provider admission. All non-success results therefore remain ambiguous.
 */
function normalizeTreasuryFulfillment(
  module: CheckoutSparkNativeTreasurySdkCodec,
  request: CheckoutSparkNativeTreasurySdkInput,
  response: unknown
): CheckoutSparkNativeTreasurySdkSendResult {
  const unrecognized = {
    status: "ambiguous",
    reason: "unrecognized_result",
  } as const
  if (!record(response)) return unrecognized
  const {
    satsTransactionSuccess: successes,
    satsTransactionErrors: errors,
    tokenTransactionSuccess: tokenSuccesses,
    tokenTransactionErrors: tokenErrors,
    invalidInvoices: invalid,
  } = response
  if (
    !Array.isArray(successes) ||
    !Array.isArray(errors) ||
    !Array.isArray(tokenSuccesses) ||
    !Array.isArray(tokenErrors) ||
    !Array.isArray(invalid) ||
    tokenSuccesses.length !== 0 ||
    tokenErrors.length !== 0
  )
    return unrecognized
  const invoice = request.nativeTreasury.invoiceRequest
  if (invalid.length === 1 && successes.length === 0 && errors.length === 0) {
    return record(invalid[0]) &&
      invalid[0].invoice === invoice &&
      record(invalid[0].error)
      ? { status: "ambiguous", reason: "invoice_rejected" }
      : unrecognized
  }
  if (errors.length === 1 && successes.length === 0 && invalid.length === 0) {
    return record(errors[0]) &&
      errors[0].invoice === invoice &&
      record(errors[0].error)
      ? {
          status: "ambiguous",
          reason: fulfillmentErrorReason(errors[0].error, "provider_error"),
        }
      : unrecognized
  }
  if (successes.length !== 1 || errors.length !== 0 || invalid.length !== 0)
    return unrecognized
  const success: unknown = successes[0]
  if (
    !record(success) ||
    success.invoice !== invoice ||
    !record(success.transferResponse) ||
    typeof success.transferResponse.id !== "string" ||
    !Array.isArray(success.transferResponse.senders) ||
    !Array.isArray(success.transferResponse.receivers)
  )
    return unrecognized
  const transfer = success.transferResponse
  let providerTransferId: string
  try {
    providerTransferId = module
      .parseTransferId(transfer.id as string)
      .toString()
    if (providerTransferId !== transfer.id) return unrecognized
  } catch {
    return unrecognized
  }
  const observed = exactCheckoutTreasuryTransfer(
    request,
    providerTransferId,
    transfer as unknown as CheckoutSparkNativeTreasurySdkTransfer
  )
  // Immediate response binding can retain the actual ID, but only independent
  // exact invoice/transfer reads may establish payment or completion.
  return observed.status === "paid" || observed.status === "pending"
    ? { status: "submitted", providerTransferId }
    : unrecognized
}

/** Pure injected provider boundary shared by shopper and Merchant recovery.
 * No keys, initialization, SDK imports, live fee quote or rail fallback.
 * Source duplicate guards are not universal deployment proof; after admission
 * callers must persist possible-send and permit only exact-history recovery.
 */
export function createCheckoutSparkNativeTreasurySdkAdapter(input: {
  readonly wallet: CheckoutSparkNativeTreasurySdkWallet
  readonly codec: CheckoutSparkNativeTreasurySdkCodec
  readonly network: CheckoutSparkNativeTreasurySdkNetwork
  readonly isClosed?: () => boolean
  readonly read: <T>(read: () => Promise<T>) => Promise<T>
}) {
  const admittedTreasuryInvoices = new Set<string>()
  const treasuryRead = async <T>(read: () => Promise<T>): Promise<T> => {
    if (input.isClosed?.()) throw new Error("Checkout Spark wallet is closed.")
    const result = await input.read(read)
    if (input.isClosed?.()) throw new Error("Checkout Spark wallet is closed.")
    return result
  }
  const hasTreasuryCapability = () =>
    input.codec.nativeTreasuryPolicy ===
      CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY &&
    Boolean(input.codec.encodeSparkAddress && input.wallet.querySparkInvoices)

  const inspectCheckoutTreasury = async (
    request: CheckoutSparkNativeTreasurySdkInput
  ): Promise<CheckoutSparkNativeTreasuryObservation> => {
    const invoiceId = request.nativeTreasury.invoiceId
    let exact: CheckoutSparkNativeTreasurySdkInput
    try {
      exact = validateCheckoutTreasuryInput(input.codec, input.network, request)
    } catch {
      return { invoiceId, status: "conflicting_evidence" }
    }
    if (!hasTreasuryCapability())
      return { invoiceId, status: "lookup_unavailable" }
    let query: CheckoutSparkNativeTreasurySdkInvoiceQuery
    try {
      const identity = await treasuryRead(() =>
        input.wallet.getIdentityPublicKey()
      )
      if (identity !== exact.nativeTreasury.senderIdentityPublicKey) {
        return { invoiceId, status: "conflicting_evidence" }
      }
      query = await treasuryRead(() =>
        input.wallet.querySparkInvoices!([exact.nativeTreasury.invoiceRequest])
      )
    } catch {
      return { invoiceId, status: "lookup_unavailable" }
    }
    if (
      !query ||
      !Array.isArray(query.invoiceStatuses) ||
      query.invoiceStatuses.length !== 1
    ) {
      return { invoiceId, status: "conflicting_evidence" }
    }
    const entry = query.invoiceStatuses[0]!
    if (
      !entry ||
      entry.invoice !== exact.nativeTreasury.invoiceRequest ||
      ![0, 1, 2, 4].includes(entry.status)
    ) {
      return { invoiceId, status: "conflicting_evidence" }
    }
    if (entry.status === 0) {
      if (entry.transferType)
        return { invoiceId, status: "conflicting_evidence" }
      // A possibly-sent request must never be retried because of this scoped
      // absence. The durable runner, and the send seam below, preserve that.
      return {
        invoiceId,
        status: exact.providerTransferId ? "lookup_unavailable" : "not_found",
      }
    }
    if (entry.transferType?.$case !== "satsTransfer") {
      return { invoiceId, status: "conflicting_evidence" }
    }
    let providerTransferId: string
    try {
      providerTransferId = nativeTransferIdFromBytes(
        input.codec,
        entry.transferType.satsTransfer.transferId
      )
    } catch {
      return { invoiceId, status: "conflicting_evidence" }
    }
    if (
      exact.providerTransferId &&
      exact.providerTransferId !== providerTransferId
    ) {
      return { invoiceId, status: "conflicting_evidence" }
    }
    let transfer: CheckoutSparkNativeTreasurySdkTransfer | undefined
    try {
      // Invoice FINALIZED includes sender commitment: it is not proof that
      // the recipient claimed. Always read the exact native transfer afresh.
      transfer = await treasuryRead(() =>
        input.wallet.getTransfer(providerTransferId)
      )
    } catch {
      return { invoiceId, providerTransferId, status: "lookup_unavailable" }
    }
    if (!transfer)
      return { invoiceId, providerTransferId, status: "lookup_unavailable" }
    const observed = exactCheckoutTreasuryTransfer(
      exact,
      providerTransferId,
      transfer
    )
    if (observed.status === "paid" && entry.status !== 2) {
      return { invoiceId, status: "conflicting_evidence" }
    }
    if (entry.status === 4 && observed.status !== "terminal_failure") {
      return { invoiceId, status: "conflicting_evidence" }
    }
    return observed
  }

  const preflightCheckoutTreasury = async (
    request: CheckoutSparkNativeTreasurySdkInput
  ): Promise<CheckoutSparkNativeTreasurySdkPreflight> => {
    let exact: CheckoutSparkNativeTreasurySdkInput
    try {
      exact = validateCheckoutTreasuryInput(input.codec, input.network, request)
    } catch {
      return "recipient_unverified"
    }
    if (!hasTreasuryCapability() || !input.wallet.fulfillSparkInvoice)
      return "unavailable"
    try {
      const identity = await treasuryRead(() =>
        input.wallet.getIdentityPublicKey()
      )
      if (identity !== exact.nativeTreasury.senderIdentityPublicKey)
        return "recipient_unverified"
      const funds = await treasuryRead(() => input.wallet.getBalance())
      if (
        [
          funds.satsBalance.available,
          funds.satsBalance.owned,
          funds.satsBalance.incoming,
        ].some((value) => typeof value !== "bigint")
      )
        return "unavailable"
      const availableSats = Number(funds.satsBalance.available)
      const ownedSats = Number(funds.satsBalance.owned)
      const incomingSats = Number(funds.satsBalance.incoming)
      if (
        ![availableSats, ownedSats, incomingSats].every(
          (value) => Number.isSafeInteger(value) && value >= 0
        )
      )
        return "unavailable"
      if (incomingSats !== 0 || ownedSats !== availableSats)
        return "unavailable"
      return availableSats < exact.authorizedDebitSats
        ? "insufficient_funds"
        : availableSats === exact.authorizedDebitSats
          ? "ready"
          : "unavailable"
    } catch {
      return "unavailable"
    }
  }

  const sendCheckoutTreasury = async (
    request: CheckoutSparkNativeTreasurySdkSendInput
  ): Promise<CheckoutSparkNativeTreasurySdkSendResult> => {
    let exact: CheckoutSparkNativeTreasurySdkInput
    try {
      exact = validateCheckoutTreasuryInput(input.codec, input.network, request)
    } catch {
      return { status: "not_sent" }
    }
    const invoiceId = exact.nativeTreasury.invoiceId
    const prior = await inspectCheckoutTreasury(exact)
    if (prior.status !== "not_found") {
      return {
        status:
          prior.status === "paid" || prior.status === "pending"
            ? "submitted"
            : "ambiguous",
      }
    }
    if (
      request.priorSendMayHaveOccurred !== false ||
      admittedTreasuryInvoices.has(invoiceId)
    ) {
      return { status: "ambiguous" }
    }
    if ((await preflightCheckoutTreasury(exact)) !== "ready")
      return { status: "not_sent" }
    try {
      await request.assertBeforeSend?.()
    } catch {
      return { status: "not_sent" }
    }
    if (admittedTreasuryInvoices.has(invoiceId)) return { status: "ambiguous" }
    if (input.isClosed?.()) return { status: "not_sent" }
    // The provider source has a single-active invoice guard, but its deployed
    // version is not proved here. Persist possible-send before this call;
    // after any SDK admission (including timeout/errors), recovery is read-only.
    admittedTreasuryInvoices.add(invoiceId)
    try {
      // A read deadline must not detach this admitted financial operation:
      // callers retain the SDK wallet until fulfillment actually settles.
      const response = await input.wallet.fulfillSparkInvoice!([
        {
          invoice: exact.nativeTreasury.invoiceRequest,
          amount: BigInt(exact.amountSats),
        },
      ])
      return normalizeTreasuryFulfillment(input.codec, exact, response)
    } catch (error) {
      return {
        status: "ambiguous",
        reason: fulfillmentErrorReason(error, "provider_unavailable"),
      }
    }
  }

  return {
    inspectCheckoutTreasury,
    preflightCheckoutTreasury,
    sendCheckoutTreasury,
  }
}
