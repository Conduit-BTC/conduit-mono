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
}
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
  const pendingStatuses = [
    "TRANSFER_STATUS_SENDER_INITIATED",
    "TRANSFER_STATUS_SENDER_KEY_TWEAK_PENDING",
    "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
    "TRANSFER_STATUS_RECEIVER_KEY_TWEAKED",
    "TRANSFER_STATUS_RECEIVER_REFUND_SIGNED",
    "TRANSFER_STATUS_SENDER_INITIATED_COORDINATOR",
    "TRANSFER_STATUS_RECEIVER_KEY_TWEAK_LOCKED",
    "TRANSFER_STATUS_RECEIVER_KEY_TWEAK_APPLIED",
    "TRANSFER_STATUS_APPLYING_SENDER_KEY_TWEAK",
  ]
  return pendingStatuses.includes(transfer.status)
    ? { invoiceId, providerTransferId, status: "pending" }
    : { invoiceId, status: "conflicting_evidence" }
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
      await treasuryRead(() =>
        input.wallet.fulfillSparkInvoice!([
          {
            invoice: exact.nativeTreasury.invoiceRequest,
            amount: BigInt(exact.amountSats),
          },
        ])
      )
      return { status: "submitted" }
    } catch {
      return { status: "ambiguous" }
    }
  }

  return {
    inspectCheckoutTreasury,
    preflightCheckoutTreasury,
    sendCheckoutTreasury,
  }
}
