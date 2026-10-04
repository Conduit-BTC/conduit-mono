import {
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
  isAmountlessLightningInvoice,
  normalizeLightningInvoice,
  type CheckoutSparkNativeRetirementReader,
  type CheckoutSparkNativeTreasuryPlan,
  type CheckoutSparkNativeTreasuryObservation,
  type SparkCheckoutLightningReturnedInspection,
  type SparkCheckoutLightningReturnedInspectionInput,
  type SparkCheckoutLightningClosedReturnedInspection,
  type SparkCheckoutLightningClosedReturnedInspectionInput,
  type WalletPaymentFeeApproval,
} from "@conduit/core"

import {
  acquireSparkWalletManagerSessionLease,
  type SparkWalletSessionLease,
} from "./spark-wallet-lease"
import {
  createSparkDirectTransferSafetyStore,
  type SparkDirectTransferSafetyStore,
} from "./spark-direct-transfer-safety"
import {
  isValidSparkAccountNumber,
  normalizeSparkMnemonic,
} from "./spark-recovery"

export type SparkWalletNetwork = "mainnet" | "regtest"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface SparkPreparedPayment {
  paymentMethod: {
    type: string
    fee?: string
    lightningFeeSats?: number | bigint
  }
  amount: bigint
}

export interface SparkPaymentSummary {
  id: string
  paymentType: "send" | "receive"
  status: "completed" | "pending" | "failed"
  amountSats: number
  feeSats: number
  timestamp: number
  method: "lightning" | "spark" | "token" | "deposit" | "withdraw" | "unknown"
}

export interface SparkSdkPayment {
  id: string
  status: "completed" | "pending" | "failed"
  fees: bigint
  details?: {
    type: string
    htlcDetails?: {
      paymentHash: string
      preimage?: string
    }
  }
}

export interface SparkFundsState {
  availableSats: number
  ownedSats: number
  incomingSats: number
  observedAt: number
}

/** Unsigned request; authority is the independently approved static address. */
export type SparkCheckoutTreasuryRequest = CheckoutSparkNativeTreasuryPlan

export interface SparkCheckoutTreasuryPrepareInput {
  readonly network: SparkWalletNetwork
  readonly sparkAddress: string
  readonly receiverIdentityPublicKey?: string
  readonly senderIdentityPublicKey: string
  /** Derived and saved by Core before the funding request is exposed. */
  readonly invoiceId: string
}

export interface SparkCheckoutTreasuryDestination {
  readonly sparkAddress: string
  readonly receiverIdentityPublicKey: string
}

export interface SparkCheckoutTreasuryInput {
  readonly network: SparkWalletNetwork
  readonly nativeTreasury: SparkCheckoutTreasuryRequest
  readonly amountSats: number
  readonly authorizedDebitSats: number
  readonly providerTransferId?: string | null
}

export type SparkCheckoutTreasuryObservation =
  CheckoutSparkNativeTreasuryObservation

export type SparkCheckoutTreasuryPreflight =
  | "ready"
  | "fee_over_cap"
  | "insufficient_funds"
  | "unavailable"
  | "recipient_unverified"

export interface SparkCheckoutTreasurySendInput extends SparkCheckoutTreasuryInput {
  /** True after any previous provider admission, including a lost response. */
  readonly priorSendMayHaveOccurred: boolean
  /** Rechecks durable authority and commerce proof immediately before admission. */
  readonly assertBeforeSend?: () => Promise<void>
}

/** Neither a fulfill response nor an empty history query is settlement proof. */
export type SparkCheckoutTreasurySendResult = {
  readonly status: "submitted" | "ambiguous" | "not_sent"
}

export interface SparkCheckoutRetirementTarget {
  network: SparkWalletNetwork
  receiverIdentityPublicKey: string
}

/** Private, authenticated inspection only; cleanup never closes the wallet. */
export interface SparkCheckoutRetirementSession {
  reader: CheckoutSparkNativeRetirementReader
  sparkAddress: string
  cleanup(): Promise<void>
}

export interface SparkCheckoutReceiveRequest {
  walletId: string
  network: SparkWalletNetwork
  id: string
  paymentRequest: string
  paymentHash: string
  providerStatus: string
  requiredNetSats: number
  grossFundingSats: number
  expirySecs: number
  createdAt: number
  expiresAt: number
  /** Only a receive created from a same-wallet, exact feeless NET quote has this. */
  receiveQuotePolicy?: "same-wallet-feeless-net-v1"
  /** Ordinary receive; executable only in an opted-in local rehearsal. */
  receiveCanaryPolicy?: "local-loopback-unquoted-balance-gated-v1"
  /** Ordinary gross invoice; exact credited sats require a later transfer proof. */
  receiveSettledPolicy?: "ordinary-exact-credit-v3"
  /** Compressed exact receiver identity frozen before the v3 invoice is exposed. */
  receiverIdentityPublicKey?: string
}

export type SparkCheckoutReceiveState =
  "pending" | "funded_pending_claim" | "spendable" | "unresolved_failure"

export type SparkCheckoutReceiveFailureReason =
  | "invoice_expired_unresolved"
  | "provider_unresolved"
  | "receive_not_found"
  | "lookup_unavailable"
  | "conflicting_evidence"
  | "insufficient_available_funds"

export interface SparkCheckoutReceiveReconciliation {
  state: SparkCheckoutReceiveState
  providerStatus: string | null
  failureReason: SparkCheckoutReceiveFailureReason | null
  funds: SparkFundsState
}

/** Frozen receive identity available to either checkout actor after funding. */
export interface SparkCheckoutHistoricalReceiveTarget {
  walletId: string
  network: SparkWalletNetwork
  requestId: string
  paymentRequest: string
  paymentHash: string
  requiredNetSats: number
  grossFundingSats: number
  createdAt: number
  expiresAt: number
}

/** Historical receipt only: completion does not attest current spendable funds. */
export type SparkCheckoutHistoricalReceiveAttestation =
  | { status: "completed"; observedAt: number }
  | {
      status: "unconfirmed"
      reason:
        | "not_found"
        | "lookup_unavailable"
        | "conflicting_evidence"
        | "not_completed"
      observedAt: number
    }

export interface SparkCheckoutReceiveInput {
  description: string
  requiredNetSats: number
  grossFundingSats: number
  expirySecs: number
  /** Explicit local rehearsal mode; omitted means the production quote path. */
  receiveMode?: "local_unquoted_canary" | "ordinary_settled_v3"
}

export interface SparkLightningSendReconciliationInput {
  transferId: string
  paymentRequest: string
  amountSats: number
  maxFeeSats: number
  completionTimeoutSecs?: number
}

export interface SparkCheckoutLightningObligationInput extends SparkLightningSendReconciliationInput {
  network: SparkWalletNetwork
  /** Recheck actor/order/time authority after SDK reads, at the send boundary. */
  assertBeforeSend?: () => Promise<void>
}

/** Exact pre-freeze Lightning leg; a numeric estimate is not a payment quote. */
export interface SparkCheckoutLightningFeeEstimateInput {
  walletId: string
  network: SparkWalletNetwork
  paymentRequest: string
  paymentHash: string
  amountSats: number
}

export type SparkCheckoutLightningObligationSendResult =
  | { status: "paid"; payment: SparkSdkPayment }
  | { status: "terminal_failure"; payment: SparkSdkPayment }
  | {
      status: "not_sent"
      reason: "fee_over_cap" | "fee_unavailable" | "invoice_expired"
    }
  | { status: "ambiguous" }

export type SparkCheckoutLightningObligationPreflight =
  "ready" | "fee_over_cap" | "unavailable"

export interface SparkLightningSendAttempt {
  readonly schemaVersion: 1
  readonly walletId: string
  readonly network: SparkWalletNetwork
  readonly transferId: string
  readonly paymentRequest: string
  readonly amountSats: number
  readonly maxFeeSats: number
  readonly completionTimeoutSecs?: number
  readonly createdAt: number
}

export type SparkLightningSendReconciliation =
  | {
      status: "resolved"
      payment: SparkSdkPayment
      /** Exact provider transfer total, verified against invoice amount and observed fee. */
      verifiedTransferTotalSats?: number
    }
  | { status: "not_found" }
  | { status: "lookup_unavailable" }
  | { status: "conflicting_evidence"; reason: string }

export interface SparkSdkClient {
  addEventListener?(listener: () => void): Promise<string>
  removeEventListener?(listenerId: string): Promise<boolean>
  disconnect(): Promise<void>
  getInfo(request?: { ensureSynced?: boolean }): Promise<{
    balanceSats: number
  }>
  listPayments(request?: {
    offset?: number
    limit?: number
    sortAscending?: boolean
  }): Promise<{ payments: SparkPaymentSummary[] }>
  prepareSendPayment(request: {
    paymentRequest: { type: "input"; input: string }
    amount?: bigint
  }): Promise<SparkPreparedPayment>
  sendPayment(request: {
    prepareResponse: SparkPreparedPayment
    options?:
      | {
          type: "bolt11Invoice"
          preferSpark: boolean
          completionTimeoutSecs?: number
        }
      | {
          type: "sparkAddress"
        }
    idempotencyKey?: string
  }): Promise<{ payment: SparkSdkPayment }>
  reconcileLightningSend?(
    request: SparkLightningSendReconciliationInput
  ): Promise<SparkLightningSendReconciliation>
  /** Explicit renewal inspection; may recover native wallet keyshares. */
  inspectCheckoutLightningReturnedAttempt?(
    request: SparkCheckoutLightningReturnedInspectionInput,
    assertCurrent?: () => void
  ): Promise<SparkCheckoutLightningReturnedInspection>
  /** Terminal history only; no spendable-leaf or renewal authority. */
  inspectCheckoutLightningClosedReturnedAttempt?(
    request: SparkCheckoutLightningClosedReturnedInspectionInput,
    assertCurrent?: () => void
  ): Promise<SparkCheckoutLightningClosedReturnedInspection>
  preflightCheckoutLightningObligation?(
    request: SparkCheckoutLightningObligationInput
  ): Promise<SparkCheckoutLightningObligationPreflight>
  estimateCheckoutLightningFee?(
    request: SparkCheckoutLightningFeeEstimateInput
  ): Promise<number>
  sendCheckoutLightningObligation?(
    request: SparkCheckoutLightningObligationInput
  ): Promise<SparkCheckoutLightningObligationSendResult>
  inspectCheckoutTreasury?(
    request: SparkCheckoutTreasuryInput
  ): Promise<SparkCheckoutTreasuryObservation>
  preflightCheckoutTreasury?(
    request: SparkCheckoutTreasuryInput
  ): Promise<SparkCheckoutTreasuryPreflight>
  sendCheckoutTreasury?(
    request: SparkCheckoutTreasurySendInput
  ): Promise<SparkCheckoutTreasurySendResult>
  receivePayment(request: {
    paymentMethod:
      | {
          type: "bolt11Invoice"
          description: string
          amountSats?: number
          expirySecs?: number
        }
      | { type: "sparkAddress" }
  }): Promise<{ paymentRequest: string; fee: bigint }>
  getFundsState?(): Promise<SparkFundsState>
  openCheckoutRetirementReader?(
    target: SparkCheckoutRetirementTarget & { walletId: string }
  ): Promise<SparkCheckoutRetirementSession>
  createCheckoutReceive?(
    request: SparkCheckoutReceiveInput
  ): Promise<SparkCheckoutReceiveRequest>
  reconcileCheckoutReceive?(
    request: SparkCheckoutReceiveRequest
  ): Promise<SparkCheckoutReceiveReconciliation>
  attestCheckoutReceiveCredit?(
    request: SparkCheckoutReceiveRequest
  ): Promise<
    | import("./spark-checkout-receive-credit").SparkCheckoutReceiveCreditProof
    | null
  >
  attestCheckoutReceiveHistory?(
    target: SparkCheckoutHistoricalReceiveTarget
  ): Promise<SparkCheckoutHistoricalReceiveAttestation>
}

export interface SparkSdkFactory {
  readonly network: SparkWalletNetwork
  validateCheckoutTreasuryDestination?(
    input: Pick<SparkCheckoutTreasuryPrepareInput, "network" | "sparkAddress">
  ): Promise<SparkCheckoutTreasuryDestination>
  /** Pure encoding/validation; must not open a wallet or contact a provider. */
  prepareCheckoutTreasuryRequest?(
    input: SparkCheckoutTreasuryPrepareInput
  ): Promise<SparkCheckoutTreasuryRequest>
  open(input: {
    walletId: string
    mnemonic: string
    accountNumber: number
  }): Promise<SparkSdkClient>
}

export type SparkWalletSessionLeaseAcquirer = (
  walletId: string,
  identityKey: string
) => Promise<SparkWalletSessionLease>

export interface SparkPayInvoiceInput {
  invoice: string
  amountMsats: number
  idempotencyKey: string
  completionTimeoutSecs?: number
  approveFee?: WalletPaymentFeeApproval
  persistAttempt?: (attempt: SparkLightningSendAttempt) => Promise<void>
  beforeSend?: () => Promise<void>
}

export type SparkPayInvoiceResult =
  | {
      status: "paid"
      paymentId: string
      preimage: string
      paymentHash: string
      feeMsats: number
    }
  | {
      status: "pre_publish_failed"
      reason: string
    }
  | {
      status: "approval_declined"
      reason: string
    }
  | {
      status: "ambiguous"
      reason: string
    }

export type SparkSendRequest =
  | {
      destination: {
        type: "lightning_invoice"
        invoice: string
      }
      amount:
        | { type: "invoice" }
        | { type: "exact"; amountSats: number }
        | { type: "max" }
    }
  | {
      destination: {
        type: "spark_address"
        address: string
      }
      amount: { type: "exact"; amountSats: number }
    }

export interface SparkSendQuote {
  readonly id: string
  readonly method: "lightning" | "spark"
  readonly amountMode: SparkSendRequest["amount"]["type"]
  readonly amountSats: number
  readonly feeSats: number
  readonly totalSats: number
  readonly remainingSats: number
}

export type SparkSendResult =
  | {
      status: "sent"
      method: "lightning" | "spark"
      paymentId: string
      amountSats: number
      feeSats: number
      preimage?: string
      paymentHash?: string
    }
  | {
      status: "failed" | "ambiguous"
      reason: string
    }

export class SparkWalletManager {
  readonly #factory: SparkSdkFactory
  readonly #acquireSessionLease: SparkWalletSessionLeaseAcquirer
  readonly #sendSafety: SparkDirectTransferSafetyStore
  readonly #now: () => number
  readonly #clients = new Map<string, SparkSdkClient>()
  readonly #sessionLeases = new Map<string, SparkWalletSessionLease>()
  readonly #sendSafetyScopes = new Map<string, string>()
  readonly #quarantinedWallets = new Set<string>()
  readonly #disconnectedWallets = new Set<string>()
  readonly #eventListeners = new Map<
    string,
    {
      client: SparkSdkClient
      listenerId: string
      active: boolean
    }
  >()
  readonly #subscribers = new Set<(walletId: string) => void>()
  readonly #pendingInvalidations = new Set<string>()
  readonly #invoiceAttempts = new Map<
    string,
    {
      walletId: string
      result: Promise<SparkPayInvoiceResult>
    }
  >()
  #invalidationScheduled = false
  readonly #sendQuotes = new Map<
    string,
    {
      walletId: string
      safetyScope: string
      attemptId: string
      expiresAt: number | null
      prepared: SparkPreparedPayment
      quote: SparkSendQuote
    }
  >()
  readonly #sendAttempts = new Map<string, Promise<SparkSendResult>>()

  constructor(
    factory: SparkSdkFactory,
    acquireSessionLease: SparkWalletSessionLeaseAcquirer = acquireSparkWalletManagerSessionLease,
    sendSafety: SparkDirectTransferSafetyStore = createSparkDirectTransferSafetyStore(),
    now: () => number = Date.now
  ) {
    this.#factory = factory
    this.#acquireSessionLease = acquireSessionLease
    this.#sendSafety = sendSafety
    this.#now = now
  }

  async openWithMnemonic(input: {
    walletId: string
    mnemonic: string
    accountNumber: number
  }): Promise<void> {
    if (!isValidSparkAccountNumber(input.accountNumber)) {
      throw new Error("Enter a valid Spark account number.")
    }
    await this.#open({
      walletId: input.walletId,
      accountNumber: input.accountNumber,
      mnemonic: normalizeSparkMnemonic(input.mnemonic),
    })
  }

  async close(walletId: string): Promise<void> {
    this.#purgeInvoiceAttempts(walletId)
    this.#purgeSendQuotes(walletId)
    const client = this.#clients.get(walletId)
    if (!client) {
      this.#sendSafetyScopes.delete(walletId)
      return
    }
    this.#quarantinedWallets.add(walletId)
    const sessionLease = this.#sessionLeases.get(walletId)
    const eventListener = this.#eventListeners.get(walletId)
    const cleanupErrors: unknown[] = []
    if (eventListener) {
      eventListener.active = false
      if (eventListener.listenerId) {
        try {
          await client.removeEventListener?.(eventListener.listenerId)
          eventListener.listenerId = ""
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
    }

    if (!this.#disconnectedWallets.has(walletId)) {
      try {
        await client.disconnect()
        this.#disconnectedWallets.add(walletId)
      } catch (error) {
        cleanupErrors.push(error)
        throwCleanupErrors(
          cleanupErrors,
          "Portable Wallet disconnect was not confirmed; its session remains locked."
        )
      }
    }

    try {
      await sessionLease?.release()
    } catch (error) {
      cleanupErrors.push(error)
      throwCleanupErrors(
        cleanupErrors,
        "Portable Wallet session lock could not be released."
      )
    }

    this.#clients.delete(walletId)
    this.#sessionLeases.delete(walletId)
    this.#sendSafetyScopes.delete(walletId)
    this.#eventListeners.delete(walletId)
    this.#quarantinedWallets.delete(walletId)
    this.#disconnectedWallets.delete(walletId)
    this.#pendingInvalidations.delete(walletId)
    if (cleanupErrors.length > 0) {
      throwCleanupErrors(
        cleanupErrors,
        "Portable Wallet listener cleanup failed after disconnect."
      )
    }
  }

  async closeWalletsExcept(walletIds: ReadonlySet<string>): Promise<void> {
    const staleWalletIds = [...this.#clients.keys()].filter(
      (walletId) => !walletIds.has(walletId)
    )
    const results = await Promise.allSettled(
      staleWalletIds.map((walletId) => this.close(walletId))
    )
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (errors.length === 1) {
      throw errors[0]
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Removed Portable Wallet clients could not be closed."
      )
    }
  }

  isOpen(walletId: string): boolean {
    return (
      this.#clients.has(walletId) && !this.#quarantinedWallets.has(walletId)
    )
  }

  subscribe(listener: (walletId: string) => void): () => void {
    this.#subscribers.add(listener)
    return () => {
      this.#subscribers.delete(listener)
    }
  }

  async getBalance(walletId: string): Promise<number> {
    const info = await this.#getClient(walletId).getInfo({ ensureSynced: true })
    return info.balanceSats
  }

  async getFundsState(walletId: string): Promise<SparkFundsState> {
    const client = this.#getClient(walletId)
    if (!client.getFundsState) {
      throw new Error(
        "This Spark adapter cannot inspect complete checkout funds state."
      )
    }
    return client.getFundsState()
  }

  async openCheckoutRetirementReader(
    walletId: string,
    target: SparkCheckoutRetirementTarget
  ): Promise<SparkCheckoutRetirementSession> {
    const request = { ...target, walletId }
    if (request.network !== this.#factory.network) {
      throw new Error("Checkout Spark retirement belongs to another network.")
    }
    const client = this.#getClient(walletId)
    if (!client.openCheckoutRetirementReader) {
      throw new Error("This Spark adapter cannot inspect checkout retirement.")
    }
    const session = await client.openCheckoutRetirementReader(request)
    let closed = false
    const assertCurrent = () => {
      if (closed || this.#getClient(walletId) !== client) {
        throw new Error(
          "Checkout Spark retirement session is no longer current."
        )
      }
    }
    try {
      assertCurrent()
    } catch (error) {
      await session.cleanup()
      throw error
    }
    const read = async <T>(action: () => Promise<T>): Promise<T> => {
      assertCurrent()
      const result = await action()
      assertCurrent()
      return result
    }
    return {
      sparkAddress: session.sparkAddress,
      reader: {
        getTransfers: (input) => read(() => session.reader.getTransfers(input)),
        getPendingTransfers: (address) =>
          read(() => session.reader.getPendingTransfers(address)),
        getAvailableBalance: (address) =>
          read(() => session.reader.getAvailableBalance(address)),
        getOwnedBalance: (address) =>
          read(() => session.reader.getOwnedBalance(address)),
      },
      async cleanup() {
        closed = true
        await session.cleanup()
      },
    }
  }

  async createCheckoutReceive(
    walletId: string,
    input: SparkCheckoutReceiveInput
  ): Promise<SparkCheckoutReceiveRequest> {
    const client = this.#getClient(walletId)
    if (!client.createCheckoutReceive) {
      throw new Error(
        "This Spark adapter cannot create a recoverable checkout receive request."
      )
    }
    const request = await client.createCheckoutReceive(input)
    if (
      request.walletId !== walletId ||
      request.network !== this.#factory.network
    ) {
      throw new Error(
        "The Spark checkout receive request belongs to a different wallet or network."
      )
    }
    return request
  }

  async reconcileCheckoutReceive(
    walletId: string,
    request: SparkCheckoutReceiveRequest
  ): Promise<SparkCheckoutReceiveReconciliation> {
    if (
      request.walletId !== walletId ||
      request.network !== this.#factory.network
    ) {
      throw new Error(
        "The Spark checkout receive request belongs to a different wallet or network."
      )
    }
    const client = this.#getClient(walletId)
    if (!client.reconcileCheckoutReceive) {
      throw new Error(
        "This Spark adapter cannot reconcile a checkout receive request."
      )
    }
    return client.reconcileCheckoutReceive(request)
  }

  async attestCheckoutReceiveCredit(
    walletId: string,
    request: SparkCheckoutReceiveRequest
  ): Promise<
    | import("./spark-checkout-receive-credit").SparkCheckoutReceiveCreditProof
    | null
  > {
    if (
      request.walletId !== walletId ||
      request.network !== this.#factory.network ||
      request.receiveSettledPolicy !== "ordinary-exact-credit-v3"
    ) {
      throw new Error(
        "The settled checkout receive belongs to a different wallet or policy."
      )
    }
    const client = this.#getClient(walletId)
    if (!client.attestCheckoutReceiveCredit) {
      throw new Error(
        "This Spark adapter cannot attest an exact checkout credit."
      )
    }
    return client.attestCheckoutReceiveCredit(request)
  }

  async attestCheckoutReceiveHistory(
    walletId: string,
    target: SparkCheckoutHistoricalReceiveTarget
  ): Promise<SparkCheckoutHistoricalReceiveAttestation> {
    if (
      target.walletId !== walletId ||
      target.network !== this.#factory.network
    ) {
      throw new Error(
        "The Spark checkout receive target belongs to a different wallet or network."
      )
    }
    const client = this.#getClient(walletId)
    if (!client.attestCheckoutReceiveHistory) {
      throw new Error(
        "This Spark adapter cannot attest checkout receive history."
      )
    }
    return client.attestCheckoutReceiveHistory(target)
  }

  async listPayments(walletId: string): Promise<SparkPaymentSummary[]> {
    const result = await this.#getClient(walletId).listPayments({
      limit: 50,
      sortAscending: false,
    })
    return result.payments
  }

  async prepareSend(
    walletId: string,
    request: SparkSendRequest
  ): Promise<SparkSendQuote> {
    const client = this.#getClient(walletId)
    const safetyScope = this.#getSendSafetyScope(walletId)
    if (this.#sendSafety.get(safetyScope)) {
      throw new Error(
        "A previous Spark payment is unresolved. Check this wallet's payment history before clearing its safety lock."
      )
    }
    const balanceSats = (await client.getInfo({ ensureSynced: true }))
      .balanceSats

    if (request.destination.type === "spark_address") {
      const address = request.destination.address.trim()
      if (request.amount.type !== "exact") {
        throw new Error("Direct Spark transfers require an exact amount.")
      }
      const amountSats = request.amount.amountSats
      if (!address) {
        throw new Error("Enter a Spark address.")
      }
      if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
        throw new Error("Enter a whole-number amount greater than zero.")
      }
      const prepared = await client.prepareSendPayment({
        paymentRequest: { type: "input", input: address },
        amount: BigInt(amountSats),
      })
      if (
        prepared.paymentMethod.type !== "sparkAddress" ||
        typeof prepared.paymentMethod.fee !== "string"
      ) {
        throw new Error("The payment request is not a Spark address.")
      }
      if (prepared.amount !== BigInt(amountSats)) {
        throw new Error("Spark prepared a different transfer amount.")
      }
      const feeSats = Number(prepared.paymentMethod.fee)
      if (!Number.isSafeInteger(feeSats) || feeSats < 0) {
        throw new Error("Spark returned an invalid transfer fee.")
      }
      const totalSats = amountSats + feeSats
      if (totalSats > balanceSats) {
        throw new Error(
          "This wallet does not have enough bitcoin for the transfer and Spark fee."
        )
      }
      const quote: SparkSendQuote = {
        id: crypto.randomUUID(),
        method: "spark",
        amountMode: "exact",
        amountSats,
        feeSats,
        totalSats,
        remainingSats: balanceSats - totalSats,
      }
      this.#sendQuotes.set(quote.id, {
        walletId,
        safetyScope,
        attemptId: crypto.randomUUID(),
        expiresAt: null,
        prepared,
        quote: Object.freeze({ ...quote }),
      })
      return Object.freeze({ ...quote })
    }

    const invoice = normalizeLightningInvoice(request.destination.invoice)
    const decodedAmount = decodeLightningInvoiceMetadata(invoice)
    if (decodedAmount.createdAt === null) {
      throw new Error("Enter a valid BOLT11 Lightning invoice.")
    }
    if (!decodeLightningInvoicePaymentHash(invoice)) {
      throw new Error(
        "The Lightning invoice does not contain a valid payment hash."
      )
    }
    const invoiceNetwork = getLightningInvoiceNetwork(invoice)
    if (invoiceNetwork !== this.#factory.network) {
      throw new Error(
        "The Lightning invoice belongs to a different Bitcoin network."
      )
    }
    if (
      decodedAmount.expiresAt !== null &&
      decodedAmount.expiresAt <= Math.floor(this.#now() / 1_000)
    ) {
      throw new Error("The Lightning invoice is already expired.")
    }
    const amountlessInvoice = isAmountlessLightningInvoice(invoice)
    if (decodedAmount.msats === null && !amountlessInvoice) {
      throw new Error("The Lightning invoice contains an invalid amount.")
    }
    let amountSats: number
    let prepared: SparkPreparedPayment
    let feeSats: number
    if (request.amount.type === "invoice") {
      if (amountlessInvoice) {
        throw new Error(
          "Enter an amount for this amountless Lightning invoice."
        )
      }
      if (
        decodedAmount.sats === null ||
        !Number.isSafeInteger(decodedAmount.sats) ||
        decodedAmount.sats <= 0
      ) {
        throw new Error(
          "The Lightning invoice amount must be a whole number of sats."
        )
      }
      amountSats = decodedAmount.sats
      ;({ prepared, feeSats } = await this.#prepareLightningSend(
        client,
        invoice,
        amountSats
      ))
    } else if (request.amount.type === "exact") {
      if (
        !Number.isSafeInteger(request.amount.amountSats) ||
        request.amount.amountSats <= 0
      ) {
        throw new Error("Enter a whole-number amount greater than zero.")
      }
      if (
        decodedAmount.msats !== null &&
        decodedAmount.msats !== request.amount.amountSats * 1_000
      ) {
        throw new Error("Amount in invoice does not match amount in request.")
      }
      amountSats = request.amount.amountSats
      ;({ prepared, feeSats } = await this.#prepareLightningSend(
        client,
        invoice,
        amountSats
      ))
    } else {
      if (!amountlessInvoice) {
        throw new Error(
          "Maximum send requires an amountless Lightning invoice."
        )
      }
      ;({ prepared, feeSats, amountSats } =
        await this.#prepareMaximumLightningSend(client, invoice, balanceSats))
    }

    const totalSats = amountSats + feeSats
    if (totalSats > balanceSats) {
      throw new Error(
        "This wallet does not have enough bitcoin for the payment and Lightning fee."
      )
    }

    const quote: SparkSendQuote = {
      id: crypto.randomUUID(),
      method: "lightning",
      amountMode: request.amount.type,
      amountSats,
      feeSats,
      totalSats,
      remainingSats: balanceSats - totalSats,
    }
    this.#sendQuotes.set(quote.id, {
      walletId,
      safetyScope,
      attemptId: crypto.randomUUID(),
      expiresAt: decodedAmount.expiresAt,
      prepared,
      quote: Object.freeze({ ...quote }),
    })
    return Object.freeze({ ...quote })
  }

  async #prepareLightningSend(
    client: SparkSdkClient,
    invoice: string,
    amountSats: number
  ): Promise<{ prepared: SparkPreparedPayment; feeSats: number }> {
    const prepared = await client.prepareSendPayment({
      paymentRequest: {
        type: "input",
        input: invoice,
      },
      amount: BigInt(amountSats),
    })
    if (prepared.paymentMethod.type !== "bolt11Invoice") {
      throw new Error("Spark did not recognize the payment request as BOLT11.")
    }
    if (prepared.amount !== BigInt(amountSats)) {
      throw new Error("Spark prepared a different invoice amount.")
    }
    const feeSats = safeBigIntToNumber(prepared.paymentMethod.lightningFeeSats)
    if (feeSats === null) {
      throw new Error("Spark did not return a valid Lightning fee.")
    }
    return { prepared, feeSats }
  }

  async #prepareMaximumLightningSend(
    client: SparkSdkClient,
    invoice: string,
    balanceSats: number
  ): Promise<{
    prepared: SparkPreparedPayment
    feeSats: number
    amountSats: number
  }> {
    if (!Number.isSafeInteger(balanceSats) || balanceSats <= 0) {
      throw new Error("This wallet has no bitcoin available to send.")
    }

    const attemptedAmounts = new Set<number>()
    let candidateSats = balanceSats
    let bestAffordable:
      | {
          prepared: SparkPreparedPayment
          feeSats: number
          amountSats: number
        }
      | undefined

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (
        !Number.isSafeInteger(candidateSats) ||
        candidateSats <= 0 ||
        attemptedAmounts.has(candidateSats)
      ) {
        break
      }
      attemptedAmounts.add(candidateSats)
      const preparedQuote = await this.#prepareLightningSend(
        client,
        invoice,
        candidateSats
      )
      const totalSats = candidateSats + preparedQuote.feeSats
      if (
        totalSats <= balanceSats &&
        (!bestAffordable || candidateSats > bestAffordable.amountSats)
      ) {
        bestAffordable = {
          ...preparedQuote,
          amountSats: candidateSats,
        }
      }
      if (totalSats === balanceSats) {
        return {
          ...preparedQuote,
          amountSats: candidateSats,
        }
      }
      candidateSats = balanceSats - preparedQuote.feeSats
    }

    if (bestAffordable) {
      return bestAffordable
    }
    throw new Error(
      "Spark could not prepare a maximum payment with a stable Lightning fee. Enter an amount instead."
    )
  }

  confirmSend(walletId: string, quoteId: string): Promise<SparkSendResult> {
    const preparedQuote = this.#sendQuotes.get(quoteId)
    if (!preparedQuote || preparedQuote.walletId !== walletId) {
      return Promise.resolve({
        status: "failed",
        reason: "This Spark send quote is no longer available.",
      })
    }
    const existingAttempt = this.#sendAttempts.get(quoteId)
    if (existingAttempt) {
      return existingAttempt
    }
    const attempt = this.#confirmSend(walletId, quoteId, preparedQuote)
    this.#sendAttempts.set(quoteId, attempt)
    void attempt.then((result) => {
      if (result.status !== "ambiguous") {
        this.#sendAttempts.delete(quoteId)
      }
    })
    return attempt
  }

  hasUnresolvedSend(walletId: string): boolean {
    return this.#sendSafety.get(this.#getSendSafetyScope(walletId)) !== null
  }

  acknowledgeUnresolvedSend(walletId: string): void {
    this.#sendSafety.delete(this.#getSendSafetyScope(walletId))
    this.#purgeSendQuotes(walletId)
  }

  discardSendQuote(walletId: string, quoteId: string): void {
    const quote = this.#sendQuotes.get(quoteId)
    if (quote?.walletId === walletId && !this.#sendAttempts.has(quoteId)) {
      this.#sendQuotes.delete(quoteId)
    }
  }

  async #confirmSend(
    walletId: string,
    quoteId: string,
    preparedQuote: {
      walletId: string
      safetyScope: string
      attemptId: string
      expiresAt: number | null
      prepared: SparkPreparedPayment
      quote: SparkSendQuote
    }
  ): Promise<SparkSendResult> {
    if (
      preparedQuote.expiresAt !== null &&
      preparedQuote.expiresAt <= Math.floor(this.#now() / 1_000)
    ) {
      this.#sendQuotes.delete(quoteId)
      return {
        status: "failed",
        reason:
          "This Lightning invoice expired during review. Request a new invoice.",
      }
    }
    try {
      if (this.#sendSafety.get(preparedQuote.safetyScope)) {
        return {
          status: "ambiguous",
          reason:
            "A previous Spark payment is unresolved. Check payment history before trying again.",
        }
      }
      this.#sendSafety.put(preparedQuote.safetyScope, {
        attemptId: preparedQuote.attemptId,
        createdAt: this.#now(),
      })
    } catch {
      this.#sendQuotes.delete(quoteId)
      return {
        status: "failed",
        reason:
          "Conduit could not create the local Spark payment safety lock. Nothing was sent.",
      }
    }

    try {
      const { payment } = await this.#getClient(walletId).sendPayment({
        prepareResponse: preparedQuote.prepared,
        options:
          preparedQuote.quote.method === "lightning"
            ? {
                type: "bolt11Invoice",
                preferSpark: false,
              }
            : { type: "sparkAddress" },
        idempotencyKey: preparedQuote.attemptId,
      })
      const proof =
        payment.details?.type === "lightning"
          ? payment.details.htlcDetails
          : undefined
      if (payment.status === "failed") {
        this.#clearSendSafety(
          preparedQuote.safetyScope,
          preparedQuote.attemptId
        )
        this.#sendQuotes.delete(quoteId)
        return {
          status: "failed",
          reason: "Spark reported that the payment failed.",
        }
      }
      if (payment.status !== "completed") {
        return {
          status: "ambiguous",
          reason:
            "Spark payment is still pending. Check wallet history before trying again.",
        }
      }
      if (
        preparedQuote.quote.method === "lightning" &&
        (!proof?.preimage || !proof.paymentHash)
      ) {
        return {
          status: "ambiguous",
          reason:
            "Spark returned no Lightning payment proof. Check wallet history before trying again.",
        }
      }
      const feeSats = safeBigIntToNumber(payment.fees)
      if (feeSats === null) {
        return {
          status: "ambiguous",
          reason:
            "Spark returned an invalid payment fee. Check wallet history before trying again.",
        }
      }
      this.#clearSendSafety(preparedQuote.safetyScope, preparedQuote.attemptId)
      this.#sendQuotes.delete(quoteId)
      this.#sendAttempts.delete(quoteId)
      this.#invalidate(walletId)
      const result: SparkSendResult = {
        status: "sent",
        method: preparedQuote.quote.method,
        paymentId: payment.id,
        amountSats: preparedQuote.quote.amountSats,
        feeSats,
      }
      if (result.method === "lightning" && proof) {
        result.preimage = proof.preimage
        result.paymentHash = proof.paymentHash
      }
      return result
    } catch (error) {
      return {
        status: "ambiguous",
        reason: `${getErrorMessage(
          error,
          "Spark payment status is unknown."
        )} Check wallet history before trying again.`,
      }
    }
  }

  #clearSendSafety(safetyScope: string, attemptId: string): void {
    const marker = this.#sendSafety.get(safetyScope)
    if (marker?.attemptId === attemptId) {
      this.#sendSafety.delete(safetyScope)
    }
  }

  async receiveLightning(
    walletId: string,
    input: { description: string; amountSats?: number; expirySecs?: number }
  ): Promise<{ paymentRequest: string; feeSats: number }> {
    const result = await this.#getClient(walletId).receivePayment({
      paymentMethod: {
        type: "bolt11Invoice",
        description: input.description,
        amountSats: input.amountSats,
        expirySecs: input.expirySecs,
      },
    })
    return {
      paymentRequest: result.paymentRequest,
      feeSats: Number(result.fee),
    }
  }

  async getSparkAddress(walletId: string): Promise<string> {
    const result = await this.#getClient(walletId).receivePayment({
      paymentMethod: { type: "sparkAddress" },
    })
    return result.paymentRequest
  }

  payInvoice(
    walletId: string,
    input: SparkPayInvoiceInput
  ): Promise<SparkPayInvoiceResult> {
    const attemptKey = JSON.stringify([walletId, input.idempotencyKey])
    const existing = this.#invoiceAttempts.get(attemptKey)
    if (existing) {
      return existing.result
    }
    const attempt = this.#payInvoice(walletId, input)
    const record = { walletId, result: attempt }
    this.#invoiceAttempts.set(attemptKey, record)
    void attempt.then(
      (result) => {
        if (
          (result.status === "pre_publish_failed" ||
            result.status === "approval_declined") &&
          this.#invoiceAttempts.get(attemptKey) === record
        ) {
          this.#invoiceAttempts.delete(attemptKey)
        }
      },
      () => {
        if (this.#invoiceAttempts.get(attemptKey) === record) {
          this.#invoiceAttempts.delete(attemptKey)
        }
      }
    )
    return attempt
  }

  async reconcileInvoiceAttempt(
    walletId: string,
    attempt: SparkLightningSendAttempt
  ): Promise<SparkLightningSendReconciliation> {
    const conflictReason = getSparkLightningSendAttemptConflict(
      walletId,
      this.#factory.network,
      attempt
    )
    if (conflictReason) {
      return { status: "conflicting_evidence", reason: conflictReason }
    }
    const client = this.#clients.get(walletId)
    if (
      !client ||
      this.#quarantinedWallets.has(walletId) ||
      !client.reconcileLightningSend
    ) {
      return { status: "lookup_unavailable" }
    }
    try {
      return await client.reconcileLightningSend({
        transferId: attempt.transferId,
        paymentRequest: attempt.paymentRequest,
        amountSats: attempt.amountSats,
        maxFeeSats: attempt.maxFeeSats,
        ...(attempt.completionTimeoutSecs === undefined
          ? {}
          : { completionTimeoutSecs: attempt.completionTimeoutSecs }),
      })
    } catch {
      return {
        status: "conflicting_evidence",
        reason:
          "Spark payment recovery did not return classified provider evidence.",
      }
    }
  }

  /**
   * Read-only fee preflight before the checkout runner persists possible-send.
   * A ready result is not permission to skip the runner's exact-history read.
   */
  async preflightCheckoutLightningObligation(
    walletId: string,
    request: SparkCheckoutLightningObligationInput
  ): Promise<SparkCheckoutLightningObligationPreflight> {
    const client = this.#checkoutLightningClient(walletId, request)
    if (!client.preflightCheckoutLightningObligation) {
      throw new Error("This Spark adapter cannot preflight a checkout leg.")
    }
    return client.preflightCheckoutLightningObligation(request)
  }

  /** Freeze the request without unlocking or initializing any wallet. */
  async prepareCheckoutTreasuryRequest(
    input: SparkCheckoutTreasuryPrepareInput
  ): Promise<SparkCheckoutTreasuryRequest> {
    if (input.network !== this.#factory.network) {
      throw new Error("Checkout Spark payment belongs to another network.")
    }
    if (!this.#factory.prepareCheckoutTreasuryRequest) {
      throw new Error("This Spark adapter cannot freeze a treasury request.")
    }
    return this.#factory.prepareCheckoutTreasuryRequest(input)
  }

  async validateCheckoutTreasuryDestination(
    input: Pick<SparkCheckoutTreasuryPrepareInput, "network" | "sparkAddress">
  ): Promise<SparkCheckoutTreasuryDestination> {
    if (input.network !== this.#factory.network) {
      throw new Error("Checkout Spark payment belongs to another network.")
    }
    if (!this.#factory.validateCheckoutTreasuryDestination) {
      throw new Error("This Spark adapter cannot validate a treasury address.")
    }
    return this.#factory.validateCheckoutTreasuryDestination(input)
  }

  async inspectCheckoutTreasury(
    walletId: string,
    request: SparkCheckoutTreasuryInput
  ): Promise<SparkCheckoutTreasuryObservation> {
    const client = this.#checkoutTreasuryClient(walletId, request)
    if (!client.inspectCheckoutTreasury) {
      return {
        invoiceId: request.nativeTreasury.invoiceId,
        status: "lookup_unavailable",
      }
    }
    return client.inspectCheckoutTreasury(request)
  }

  async preflightCheckoutTreasury(
    walletId: string,
    request: SparkCheckoutTreasuryInput
  ): Promise<SparkCheckoutTreasuryPreflight> {
    const client = this.#checkoutTreasuryClient(walletId, request)
    return client.preflightCheckoutTreasury?.(request) ?? "unavailable"
  }

  async sendCheckoutTreasury(
    walletId: string,
    request: SparkCheckoutTreasurySendInput
  ): Promise<SparkCheckoutTreasurySendResult> {
    const client = this.#checkoutTreasuryClient(walletId, request)
    if (!client.sendCheckoutTreasury) return { status: "not_sent" }
    return client.sendCheckoutTreasury(request)
  }

  #checkoutTreasuryClient(
    walletId: string,
    request: SparkCheckoutTreasuryInput
  ): SparkSdkClient {
    if (request.network !== this.#factory.network) {
      throw new Error("Checkout Spark payment belongs to another network.")
    }
    return this.#getClient(walletId)
  }

  /** Explicit native renewal inspection; not a passive history/preview read. */
  async inspectCheckoutLightningReturnedAttempt(
    walletId: string,
    request: SparkCheckoutLightningReturnedInspectionInput,
    assertCurrent?: () => void
  ): Promise<SparkCheckoutLightningReturnedInspection> {
    if (request.network !== this.#factory.network) {
      return { status: "conflicting" }
    }
    const client = this.#getClient(walletId)
    if (!client.inspectCheckoutLightningReturnedAttempt) {
      return { status: "unavailable" }
    }
    return client.inspectCheckoutLightningReturnedAttempt(
      request,
      assertCurrent
    )
  }

  /** Re-prove old return generations after their successor consumed the leaves. */
  async inspectCheckoutLightningClosedReturnedAttempt(
    walletId: string,
    request: SparkCheckoutLightningClosedReturnedInspectionInput,
    assertCurrent?: () => void
  ): Promise<SparkCheckoutLightningClosedReturnedInspection> {
    if (request.network !== this.#factory.network)
      return { status: "conflicting" }
    const client = this.#getClient(walletId)
    if (!client.inspectCheckoutLightningClosedReturnedAttempt)
      return { status: "unavailable" }
    return client.inspectCheckoutLightningClosedReturnedAttempt(
      request,
      assertCurrent
    )
  }

  /** Read-only exact-invoice estimate before a separate per-leg cap is frozen. */
  async estimateCheckoutLightningFee(
    request: SparkCheckoutLightningFeeEstimateInput
  ): Promise<number> {
    if (request.network !== this.#factory.network) {
      throw new Error("Checkout Spark payment belongs to another network.")
    }
    const client = this.#getClient(request.walletId)
    if (!client.estimateCheckoutLightningFee) {
      throw new Error("This Spark adapter cannot estimate a checkout leg.")
    }
    return client.estimateCheckoutLightningFee(request)
  }

  /**
   * Execute one already-approved, frozen checkout leg. Unlike payInvoice this
   * does not re-quote a user-facing fee approval or choose a new transfer ID.
   * The caller persists possible-send state before entering this method.
   */
  async sendCheckoutLightningObligation(
    walletId: string,
    request: SparkCheckoutLightningObligationInput
  ): Promise<SparkCheckoutLightningObligationSendResult> {
    const client = this.#checkoutLightningClient(walletId, request)
    if (!client.sendCheckoutLightningObligation) {
      throw new Error("This Spark adapter cannot execute a checkout leg.")
    }
    return client.sendCheckoutLightningObligation(request)
  }

  #checkoutLightningClient(
    walletId: string,
    request: SparkCheckoutLightningObligationInput
  ): SparkSdkClient {
    if (request.network !== this.#factory.network) {
      throw new Error("Checkout Spark payment belongs to another network.")
    }
    const conflict = getSparkLightningSendAttemptConflict(
      walletId,
      request.network,
      {
        schemaVersion: 1,
        walletId,
        network: request.network,
        transferId: request.transferId,
        paymentRequest: request.paymentRequest,
        amountSats: request.amountSats,
        maxFeeSats: request.maxFeeSats,
        createdAt: this.#now(),
        ...(request.completionTimeoutSecs === undefined
          ? {}
          : { completionTimeoutSecs: request.completionTimeoutSecs }),
      }
    )
    if (conflict) throw new Error(conflict)
    return this.#getClient(walletId)
  }

  async #payInvoice(
    walletId: string,
    input: SparkPayInvoiceInput
  ): Promise<SparkPayInvoiceResult> {
    const client = this.#clients.get(walletId)
    if (!client || this.#quarantinedWallets.has(walletId)) {
      return {
        status: "pre_publish_failed",
        reason: "Portable Wallet is locked on this device.",
      }
    }
    const amountSats = input.amountMsats / 1_000
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
      return {
        status: "pre_publish_failed",
        reason: "Spark payment amount must be a positive whole number of sats.",
      }
    }
    if (input.persistAttempt && isAmountlessLightningInvoice(input.invoice)) {
      return {
        status: "pre_publish_failed",
        reason:
          "Amountless Lightning invoices cannot use durable Spark payment recovery.",
      }
    }

    let prepared: SparkPreparedPayment
    let feeSats: number
    try {
      ;({ prepared, feeSats } = await this.#prepareLightningSend(
        client,
        input.invoice,
        amountSats
      ))
    } catch (error) {
      return {
        status: "pre_publish_failed",
        reason: getErrorMessage(error, "Spark could not prepare the payment."),
      }
    }

    if (!input.approveFee) {
      return {
        status: "pre_publish_failed",
        reason: "Review the Spark fee before sending this payment.",
      }
    }
    let approved: boolean
    try {
      approved = await input.approveFee({
        amountSats,
        feeSats,
        totalSats: amountSats + feeSats,
      })
    } catch (error) {
      return {
        status: "pre_publish_failed",
        reason: getErrorMessage(
          error,
          "Spark fee review could not be completed."
        ),
      }
    }
    if (!approved) {
      return {
        status: "approval_declined",
        reason: "Spark payment was not approved.",
      }
    }

    const attempt: SparkLightningSendAttempt = Object.freeze({
      schemaVersion: 1,
      walletId,
      network: this.#factory.network,
      transferId: input.idempotencyKey,
      paymentRequest: input.invoice,
      amountSats,
      maxFeeSats: feeSats,
      ...(input.completionTimeoutSecs === undefined
        ? {}
        : { completionTimeoutSecs: input.completionTimeoutSecs }),
      createdAt: this.#now(),
    })
    if (
      input.persistAttempt &&
      getSparkLightningSendAttemptConflict(
        walletId,
        this.#factory.network,
        attempt
      )
    ) {
      return {
        status: "pre_publish_failed",
        reason: "Spark payment attempt is not recoverable.",
      }
    }
    try {
      await input.persistAttempt?.(attempt)
    } catch (error) {
      return {
        status: "pre_publish_failed",
        reason: getErrorMessage(
          error,
          "Spark payment attempt could not be saved."
        ),
      }
    }

    try {
      await input.beforeSend?.()
    } catch (error) {
      return {
        status: "pre_publish_failed",
        reason: getErrorMessage(error, "Payment is no longer authorized."),
      }
    }

    try {
      const { payment } = await client.sendPayment({
        prepareResponse: prepared,
        options: {
          type: "bolt11Invoice",
          preferSpark: false,
          completionTimeoutSecs: input.completionTimeoutSecs,
        },
        idempotencyKey: input.idempotencyKey,
      })
      const proof =
        payment.details?.type === "lightning"
          ? payment.details.htlcDetails
          : undefined
      if (
        payment.status === "completed" &&
        proof?.preimage &&
        proof.paymentHash
      ) {
        return {
          status: "paid",
          paymentId: payment.id,
          preimage: proof.preimage,
          paymentHash: proof.paymentHash,
          feeMsats: Number(payment.fees) * 1_000,
        }
      }
      return {
        status: "ambiguous",
        reason:
          payment.status === "pending"
            ? "Spark payment is still pending. Check the wallet before retrying."
            : "Spark returned no Lightning payment proof. Check the wallet before retrying.",
      }
    } catch (error) {
      return {
        status: "ambiguous",
        reason: `${getErrorMessage(
          error,
          "Spark payment status is unknown."
        )} Check the wallet before retrying.`,
      }
    }
  }

  async #open(input: {
    walletId: string
    mnemonic: string
    accountNumber: number
  }): Promise<void> {
    await this.close(input.walletId)
    const identityKey = await getSparkWalletIdentityKey(
      input.mnemonic,
      input.accountNumber,
      this.#factory.network
    )
    const sendSafetyScope = await getSparkSendSafetyScope(identityKey)
    const sessionLease = await this.#acquireSessionLease(
      input.walletId,
      identityKey
    )
    let client: SparkSdkClient | undefined
    let eventListener:
      | {
          client: SparkSdkClient
          listenerId: string
          active: boolean
        }
      | undefined
    try {
      client = await this.#factory.open(input)
      if (client.addEventListener) {
        eventListener = {
          client,
          listenerId: "",
          active: true,
        }
        eventListener.listenerId = await client.addEventListener(() => {
          if (
            eventListener?.active &&
            this.#clients.get(input.walletId) === eventListener.client
          ) {
            this.#invalidate(input.walletId)
          }
        })
      }
      this.#clients.set(input.walletId, client)
      this.#sessionLeases.set(input.walletId, sessionLease)
      this.#sendSafetyScopes.set(input.walletId, sendSafetyScope)
      this.#quarantinedWallets.delete(input.walletId)
      this.#disconnectedWallets.delete(input.walletId)
      if (eventListener) {
        this.#eventListeners.set(input.walletId, eventListener)
      }
    } catch (error) {
      const cleanupErrors: unknown[] = []
      if (eventListener) {
        eventListener.active = false
        if (eventListener.listenerId) {
          try {
            await client?.removeEventListener?.(eventListener.listenerId)
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError)
          }
        }
      }
      let disconnected = !client
      if (client) {
        try {
          await client.disconnect()
          disconnected = true
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }

      if (disconnected) {
        try {
          await sessionLease.release()
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
          if (client) {
            this.#clients.set(input.walletId, client)
            this.#sessionLeases.set(input.walletId, sessionLease)
            this.#quarantinedWallets.add(input.walletId)
            this.#disconnectedWallets.add(input.walletId)
            if (eventListener) {
              this.#eventListeners.set(input.walletId, eventListener)
            }
          }
        }
      } else if (client) {
        this.#clients.set(input.walletId, client)
        this.#sessionLeases.set(input.walletId, sessionLease)
        this.#quarantinedWallets.add(input.walletId)
        if (eventListener) {
          this.#eventListeners.set(input.walletId, eventListener)
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Could not open or clean up the Portable Wallet session.",
          { cause: error }
        )
      }
      throw error
    }
  }

  #invalidate(walletId: string): void {
    this.#pendingInvalidations.add(walletId)
    if (this.#invalidationScheduled) {
      return
    }
    this.#invalidationScheduled = true
    queueMicrotask(() => {
      this.#invalidationScheduled = false
      const walletIds = [...this.#pendingInvalidations]
      this.#pendingInvalidations.clear()
      for (const invalidatedWalletId of walletIds) {
        if (
          !this.#clients.has(invalidatedWalletId) ||
          this.#quarantinedWallets.has(invalidatedWalletId)
        ) {
          continue
        }
        for (const subscriber of this.#subscribers) {
          subscriber(invalidatedWalletId)
        }
      }
    })
  }

  #getClient(walletId: string): SparkSdkClient {
    const client = this.#clients.get(walletId)
    if (!client || this.#quarantinedWallets.has(walletId)) {
      throw new Error("Portable Wallet is locked on this device.")
    }
    return client
  }

  #getSendSafetyScope(walletId: string): string {
    this.#getClient(walletId)
    const safetyScope = this.#sendSafetyScopes.get(walletId)
    if (!safetyScope) {
      throw new Error(
        "Spark payment safety state is unavailable. Sending is disabled."
      )
    }
    return safetyScope
  }

  #purgeInvoiceAttempts(walletId: string): void {
    for (const [attemptKey, attempt] of this.#invoiceAttempts) {
      if (attempt.walletId === walletId) {
        this.#invoiceAttempts.delete(attemptKey)
      }
    }
  }

  #purgeSendQuotes(walletId: string): void {
    for (const [quoteId, quote] of this.#sendQuotes) {
      if (quote.walletId === walletId) {
        this.#sendAttempts.delete(quoteId)
        this.#sendQuotes.delete(quoteId)
      }
    }
  }
}

function getSparkLightningSendAttemptConflict(
  walletId: string,
  network: SparkWalletNetwork,
  attempt: SparkLightningSendAttempt
): string | null {
  if (!attempt || typeof attempt !== "object") {
    return "The persisted Spark payment attempt is invalid."
  }
  if (attempt.walletId !== walletId) {
    return "The persisted Spark payment attempt belongs to another wallet."
  }
  if (attempt.network !== network) {
    return "The persisted Spark payment attempt belongs to another network."
  }
  if (
    attempt.schemaVersion !== 1 ||
    typeof attempt.transferId !== "string" ||
    !UUID_PATTERN.test(attempt.transferId) ||
    typeof attempt.paymentRequest !== "string" ||
    !attempt.paymentRequest.trim() ||
    !Number.isSafeInteger(attempt.amountSats) ||
    attempt.amountSats <= 0 ||
    !Number.isSafeInteger(attempt.maxFeeSats) ||
    attempt.maxFeeSats < 0 ||
    !Number.isSafeInteger(attempt.createdAt) ||
    attempt.createdAt < 0 ||
    (attempt.completionTimeoutSecs !== undefined &&
      (typeof attempt.completionTimeoutSecs !== "number" ||
        !Number.isFinite(attempt.completionTimeoutSecs) ||
        attempt.completionTimeoutSecs < 0))
  ) {
    return "The persisted Spark payment attempt is invalid."
  }
  const approvedAmountMsats = attempt.amountSats * 1_000
  const invoice = normalizeLightningInvoice(attempt.paymentRequest)
  const metadata = decodeLightningInvoiceMetadata(invoice)
  if (
    !Number.isSafeInteger(approvedAmountMsats) ||
    metadata.createdAt === null ||
    !decodeLightningInvoicePaymentHash(invoice) ||
    getLightningInvoiceNetwork(invoice) !== network ||
    metadata.msats !== approvedAmountMsats
  ) {
    return "The persisted Spark payment attempt contains an invalid Lightning invoice."
  }
  return null
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function throwCleanupErrors(errors: unknown[], message: string): never {
  if (errors.length === 1 && errors[0] instanceof Error) {
    throw errors[0]
  }
  throw new AggregateError(errors, message)
}

function safeBigIntToNumber(value: number | bigint | undefined): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value !== "bigint" || value < 0n) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

async function getSparkWalletIdentityKey(
  mnemonic: string,
  accountNumber: number,
  network: SparkWalletNetwork
): Promise<string> {
  // This domain-separated digest exists only in memory and Web Locks so two
  // registrations cannot open the same native wallet concurrently. It is
  // never persisted, logged, or emitted as telemetry.
  return hashSensitiveScope(
    `conduit:spark-wallet-identity:v2\0${network}\0${accountNumber}\0mnemonic\0${mnemonic}`
  )
}

async function getSparkSendSafetyScope(identityKey: string): Promise<string> {
  // A separate domain prevents the Web Locks identity from becoming a storage
  // identifier. The legacy domain string remains stable so unresolved direct
  // transfers from earlier builds also block the unified send flow. Restoring
  // the same Spark identity cannot bypass this local duplicate-send lock. The
  // scope must never enter logs, telemetry, or wallet descriptors.
  return hashSensitiveScope(
    `conduit:spark-direct-transfer-safety-scope:v1\0${identityKey}`
  )
}

async function hashSensitiveScope(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value)
  try {
    const digest = await crypto.subtle.digest("SHA-256", encoded.slice().buffer)
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  } finally {
    encoded.fill(0)
  }
}
