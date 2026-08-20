import {
  config,
  decodeLightningInvoiceAmount,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
  getWalletNetworkFromLightningConfig,
  isAmountlessLightningInvoice,
  type WalletNetwork,
} from "@conduit/core"

import {
  SparkWalletManager,
  type SparkPreparedPayment,
  type SparkPayInvoiceInput,
  type SparkSdkClient,
  type SparkSdkFactory,
  type SparkSdkPayment,
} from "./spark-wallet"
import { isSparkWalletSessionCoordinationAvailable } from "./spark-wallet-lease"

export type SparkNetwork = WalletNetwork
export type SupportedSparkNetwork = Extract<SparkNetwork, "mainnet" | "regtest">
export type SparkNativeNetwork = "MAINNET" | "TESTNET" | "SIGNET" | "REGTEST"

interface SparkNativeWalletSettings {
  privateEnabled: boolean
}

interface SparkNativeCurrencyAmount {
  originalValue: number
  originalUnit: string
}

interface SparkNativeTransfer {
  id: string
  status: string
  totalValue: number
  type: string
  transferDirection: string
  createdTime?: Date
  updatedTime?: Date
  userRequest?: unknown
}

interface SparkNativeLightningSendRequest {
  id: string
  status: string
  fee: SparkNativeCurrencyAmount
  paymentPreimage?: string
}

export interface SparkNativeWallet {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  cleanup(): Promise<void>
  setPrivacyEnabled(
    enabled: boolean
  ): Promise<SparkNativeWalletSettings | undefined>
  getWalletSettings(): Promise<SparkNativeWalletSettings | undefined>
  getBalance(): Promise<{ balance: bigint }>
  getTransfers(
    limit?: number,
    offset?: number
  ): Promise<{ transfers: SparkNativeTransfer[]; offset: number }>
  getSparkAddress(): Promise<string>
  transfer(input: {
    amountSats: number
    receiverSparkAddress: string
  }): Promise<SparkNativeTransfer>
  getTransfer(id: string): Promise<SparkNativeTransfer | undefined>
  createLightningInvoice(input: {
    amountSats: number
    memo?: string
    expirySeconds?: number
    includeSparkInvoice?: boolean
  }): Promise<{
    id: string
    status: string
    invoice: { encodedInvoice: string }
  }>
  getLightningSendFeeEstimate(input: {
    encodedInvoice: string
    amountSats?: number
  }): Promise<number>
  payLightningInvoice(input: {
    invoice: string
    maxFeeSats: number
    preferSpark: boolean
    amountSatsToSend?: number
    idempotencyKey?: string
  }): Promise<SparkNativeLightningSendRequest | SparkNativeTransfer>
  getLightningSendRequest(
    id: string
  ): Promise<SparkNativeLightningSendRequest | null>
}

export interface SparkNativeReadonlyClient {
  getAvailableBalance(sparkAddress: string): Promise<bigint>
  getOwnedBalance(sparkAddress: string): Promise<bigint>
  getTransfers(input: {
    sparkAddress: string
    limit?: number
    offset?: number
  }): Promise<{ transfers: unknown[]; offset: number }>
}

interface SparkNativeInitializeInput {
  mnemonicOrSeed: string
  accountNumber: number
  options: {
    log: false
    network: SparkNativeNetwork
  }
}

export interface SparkNativeModule {
  readonly eventNames: readonly string[]
  createPublicReadonlyClient(options: {
    log: false
    network: SparkNativeNetwork
  }): SparkNativeReadonlyClient
  initialize(input: SparkNativeInitializeInput): Promise<{
    wallet: SparkNativeWallet
  }>
  decodeSparkAddress(
    address: string,
    network: SparkNativeNetwork
  ): { sparkInvoiceFields?: unknown }
  isValidSparkAddress(address: string): boolean
  getNetworkFromSparkAddress(address: string): string
}

interface FirstPartySparkSdkFactoryOptions {
  network: SupportedSparkNetwork
  loadModule?: () => Promise<SparkNativeModule>
  pollIntervalMs?: number
  transferCompletionTimeoutSecs?: number
  privacyConvergenceTimeoutMs?: number
  privacyReadTimeoutMs?: number
  privacyObservationIntervalMs?: number
  privacyRequiredConsecutiveObservations?: number
  privacyReadWithTimeout?: <T>(
    read: Promise<T>,
    timeoutMs: number,
    label: string
  ) => Promise<T>
  wait?: (milliseconds: number) => Promise<void>
  now?: () => number
}

type PreparedNativePayment =
  | {
      type: "spark"
      address: string
      amountSats: number
    }
  | {
      type: "lightning"
      invoice: string
      amountSats: number
      amountSatsToSend?: number
      feeSats: number
      expectedPaymentHash: Uint8Array
    }

const LIGHTNING_FAILURE_STATUSES = new Set([
  "USER_TRANSFER_VALIDATION_FAILED",
  "LIGHTNING_PAYMENT_FAILED",
  "PREIMAGE_PROVIDING_FAILED",
  "TRANSFER_FAILED",
  "USER_SWAP_RETURNED",
  "USER_SWAP_RETURN_FAILED",
])

export class FirstPartySparkSdkFactory implements SparkSdkFactory {
  readonly network: SupportedSparkNetwork
  readonly #loadModule: () => Promise<SparkNativeModule>
  readonly #pollIntervalMs: number
  readonly #transferCompletionTimeoutSecs: number
  readonly #privacyConvergenceTimeoutMs: number
  readonly #privacyReadTimeoutMs: number
  readonly #privacyObservationIntervalMs: number
  readonly #privacyRequiredConsecutiveObservations: number
  readonly #privacyReadWithTimeout: <T>(
    read: Promise<T>,
    timeoutMs: number,
    label: string
  ) => Promise<T>
  readonly #wait: (milliseconds: number) => Promise<void>
  readonly #now: () => number
  #modulePromise: Promise<SparkNativeModule> | null = null

  constructor(input: FirstPartySparkSdkFactoryOptions) {
    this.network = input.network
    this.#loadModule = input.loadModule ?? loadFirstPartySparkModule
    this.#pollIntervalMs = input.pollIntervalMs ?? 500
    this.#transferCompletionTimeoutSecs =
      input.transferCompletionTimeoutSecs ?? 60
    this.#privacyConvergenceTimeoutMs =
      input.privacyConvergenceTimeoutMs ?? 60_000
    this.#privacyReadTimeoutMs = input.privacyReadTimeoutMs ?? 5_000
    this.#privacyObservationIntervalMs =
      input.privacyObservationIntervalMs ?? 500
    this.#privacyRequiredConsecutiveObservations =
      input.privacyRequiredConsecutiveObservations ?? 5
    this.#privacyReadWithTimeout =
      input.privacyReadWithTimeout ?? withReadTimeout
    this.#wait = input.wait ?? wait
    this.#now = input.now ?? Date.now
  }

  async open(input: {
    walletId: string
    mnemonic: string
    accountNumber: number
  }): Promise<SparkSdkClient> {
    const module = await this.#getModule()
    const { wallet } = await module.initialize({
      mnemonicOrSeed: input.mnemonic,
      accountNumber: input.accountNumber,
      options: {
        log: false,
        network: toNativeNetwork(this.network),
      },
    })

    try {
      await wallet.setPrivacyEnabled(true)
      const settings = await wallet.getWalletSettings()
      if (settings?.privateEnabled !== true) {
        throw new Error("Spark private mode could not be verified.")
      }
      const sparkAddress = await wallet.getSparkAddress()
      const publicClient = module.createPublicReadonlyClient({
        log: false,
        network: toNativeNetwork(this.network),
      })
      await waitForPrivacyConvergence({
        publicClient,
        sparkAddress,
        convergenceTimeoutMs: this.#privacyConvergenceTimeoutMs,
        readTimeoutMs: this.#privacyReadTimeoutMs,
        observationIntervalMs: this.#privacyObservationIntervalMs,
        requiredConsecutiveObservations:
          this.#privacyRequiredConsecutiveObservations,
        readWithTimeout: this.#privacyReadWithTimeout,
        wait: this.#wait,
        now: this.#now,
      })
      return adaptFirstPartySparkWallet({
        wallet,
        module,
        network: toNativeNetwork(this.network),
        pollIntervalMs: this.#pollIntervalMs,
        transferCompletionTimeoutSecs: this.#transferCompletionTimeoutSecs,
        wait: this.#wait,
        now: this.#now,
      })
    } catch (error) {
      try {
        await wallet.cleanup()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Spark private mode failed and the wallet could not be cleaned up.",
          { cause: cleanupError }
        )
      }
      throw error
    }
  }

  #getModule(): Promise<SparkNativeModule> {
    this.#modulePromise ??= this.#loadModule().catch((error: unknown) => {
      this.#modulePromise = null
      throw error
    })
    return this.#modulePromise
  }
}

async function waitForPrivacyConvergence(input: {
  publicClient: SparkNativeReadonlyClient
  sparkAddress: string
  convergenceTimeoutMs: number
  readTimeoutMs: number
  observationIntervalMs: number
  requiredConsecutiveObservations: number
  readWithTimeout: <T>(
    read: Promise<T>,
    timeoutMs: number,
    label: string
  ) => Promise<T>
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}): Promise<void> {
  const deadline = input.now() + input.convergenceTimeoutMs
  let consecutiveHiddenObservations = 0

  /*
   * Zero/empty public reads cannot cryptographically prove privacy for a
   * brand-new wallet with no balance or history. Requiring multiple spaced
   * observations still gives the provider setting time to converge before
   * Conduit exposes the address for display or funding. Restored wallets with
   * funds or history positively verify that those public records become hidden.
   */
  while (input.now() < deadline) {
    const remainingMs = deadline - input.now()
    const readTimeoutMs = Math.min(input.readTimeoutMs, remainingMs)

    try {
      const [availableBalance, ownedBalance, history] = await Promise.all([
        input.readWithTimeout(
          input.publicClient.getAvailableBalance(input.sparkAddress),
          readTimeoutMs,
          "Spark public available-balance read"
        ),
        input.readWithTimeout(
          input.publicClient.getOwnedBalance(input.sparkAddress),
          readTimeoutMs,
          "Spark public owned-balance read"
        ),
        input.readWithTimeout(
          input.publicClient.getTransfers({
            sparkAddress: input.sparkAddress,
            limit: 1,
            offset: 0,
          }),
          readTimeoutMs,
          "Spark public transfer-history read"
        ),
      ])
      const isHidden =
        availableBalance === 0n &&
        ownedBalance === 0n &&
        history.transfers.length === 0
      consecutiveHiddenObservations = isHidden
        ? consecutiveHiddenObservations + 1
        : 0
      if (
        consecutiveHiddenObservations >= input.requiredConsecutiveObservations
      ) {
        return
      }
    } catch {
      consecutiveHiddenObservations = 0
    }

    const remainingAfterReadMs = deadline - input.now()
    if (remainingAfterReadMs <= 0) break
    await input.wait(
      Math.min(input.observationIntervalMs, remainingAfterReadMs)
    )
  }

  throw new Error(
    "Spark private mode could not be confirmed before the readiness deadline."
  )
}

function adaptFirstPartySparkWallet(input: {
  wallet: SparkNativeWallet
  module: SparkNativeModule
  network: SparkNativeNetwork
  pollIntervalMs: number
  transferCompletionTimeoutSecs: number
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}): SparkSdkClient {
  const preparedPayments = new WeakMap<
    SparkPreparedPayment,
    PreparedNativePayment
  >()
  const listeners = new Map<
    string,
    {
      eventNames: string[]
      nativeListener: (...args: unknown[]) => void
    }
  >()
  let nextListenerId = 0

  return {
    async addEventListener(listener) {
      const listenerId = `spark-listener-${++nextListenerId}`
      const nativeListener = () => {
        listener()
      }
      const eventNames = [...input.module.eventNames]
      for (const eventName of eventNames) {
        input.wallet.on(eventName, nativeListener)
      }
      listeners.set(listenerId, { eventNames, nativeListener })
      return listenerId
    },
    async removeEventListener(listenerId) {
      const registration = listeners.get(listenerId)
      if (!registration) return false
      for (const eventName of registration.eventNames) {
        input.wallet.off(eventName, registration.nativeListener)
      }
      listeners.delete(listenerId)
      return true
    },
    async disconnect() {
      listeners.clear()
      await input.wallet.cleanup()
    },
    async getInfo() {
      return {
        balanceSats: bigintToSafeNumber(
          (await input.wallet.getBalance()).balance,
          "Spark returned a balance outside the browser's safe range."
        ),
      }
    },
    async listPayments(request) {
      const result = await input.wallet.getTransfers(
        request?.limit ?? 50,
        request?.offset ?? 0
      )
      const payments = result.transfers.map(mapNativeTransfer)
      if (request?.sortAscending) {
        payments.sort((left, right) => left.timestamp - right.timestamp)
      } else {
        payments.sort((left, right) => right.timestamp - left.timestamp)
      }
      return { payments }
    },
    async prepareSendPayment(request) {
      const amountSats = bigintToSafeNumber(
        request.amount ?? 0n,
        "Spark payment amount is outside the browser's safe range."
      )
      if (amountSats <= 0) {
        throw new Error("Spark payment amount must be greater than zero.")
      }
      const paymentRequest = request.paymentRequest.input.trim()

      if (isSparkAddress(input.module, paymentRequest)) {
        if (
          input.module.getNetworkFromSparkAddress(paymentRequest) !==
          input.network
        ) {
          throw new Error(
            "The Spark address belongs to a different Bitcoin network."
          )
        }
        if (
          input.module.decodeSparkAddress(paymentRequest, input.network)
            .sparkInvoiceFields !== undefined
        ) {
          throw new Error(
            "Spark invoices are not supported for direct transfers. Use a plain Spark address."
          )
        }
        const prepared: SparkPreparedPayment = {
          paymentMethod: {
            type: "sparkAddress",
            fee: "0",
          },
          amount: BigInt(amountSats),
        }
        preparedPayments.set(prepared, {
          type: "spark",
          address: paymentRequest,
          amountSats,
        })
        return prepared
      }

      const invoiceNetwork = getLightningInvoiceNetwork(paymentRequest)
      if (
        invoiceNetwork !== "unknown" &&
        invoiceNetwork !== fromNativeNetwork(input.network)
      ) {
        throw new Error(
          "The Lightning invoice belongs to a different Bitcoin network."
        )
      }
      const decodedAmount = decodeLightningInvoiceAmount(paymentRequest)
      const amountlessInvoice = isAmountlessLightningInvoice(paymentRequest)
      if (decodedAmount.msats === null && !amountlessInvoice) {
        throw new Error("The Lightning invoice contains an invalid amount.")
      }
      const paymentHash = decodeLightningInvoicePaymentHash(paymentRequest)
      if (!paymentHash) {
        throw new Error(
          "The Lightning invoice does not contain a valid payment hash."
        )
      }
      if (
        decodedAmount.msats !== null &&
        decodedAmount.msats !== amountSats * 1_000
      ) {
        throw new Error("Amount in invoice does not match amount in request.")
      }
      const amountSatsToSend = amountlessInvoice ? amountSats : undefined
      const estimatedFeeSats = await input.wallet.getLightningSendFeeEstimate({
        encodedInvoice: paymentRequest,
        ...(amountSatsToSend === undefined
          ? {}
          : { amountSats: amountSatsToSend }),
      })
      if (!Number.isSafeInteger(estimatedFeeSats) || estimatedFeeSats < 0) {
        throw new Error("Spark returned an invalid Lightning fee.")
      }
      const feeSats = Math.max(
        estimatedFeeSats,
        getRecommendedLightningMaxFeeSats(amountSats)
      )
      const prepared: SparkPreparedPayment = {
        paymentMethod: {
          type: "bolt11Invoice",
          lightningFeeSats: feeSats,
        },
        amount: BigInt(amountSats),
      }
      preparedPayments.set(prepared, {
        type: "lightning",
        invoice: paymentRequest,
        amountSats,
        ...(amountSatsToSend === undefined ? {} : { amountSatsToSend }),
        feeSats,
        expectedPaymentHash: decodeHex32(
          paymentHash,
          "The Lightning invoice contains an invalid payment hash."
        ).bytes,
      })
      return prepared
    },
    async sendPayment(request) {
      const prepared = preparedPayments.get(request.prepareResponse)
      if (!prepared) {
        throw new Error("This Spark payment quote is no longer available.")
      }

      if (prepared.type === "spark") {
        if (request.options?.type !== "sparkAddress") {
          throw new Error("Spark transfer confirmation is invalid.")
        }
        const transfer = await input.wallet.transfer({
          amountSats: prepared.amountSats,
          receiverSparkAddress: prepared.address,
        })
        preparedPayments.delete(request.prepareResponse)
        return {
          payment: await reconcileSparkTransfer({
            wallet: input.wallet,
            initial: transfer,
            timeoutSecs: input.transferCompletionTimeoutSecs,
            pollIntervalMs: input.pollIntervalMs,
            wait: input.wait,
            now: input.now,
          }),
        }
      }

      if (request.options?.type !== "bolt11Invoice") {
        throw new Error("Lightning payment confirmation is invalid.")
      }
      const initial = await input.wallet.payLightningInvoice({
        invoice: prepared.invoice,
        maxFeeSats: prepared.feeSats,
        preferSpark: false,
        ...(prepared.amountSatsToSend === undefined
          ? {}
          : { amountSatsToSend: prepared.amountSatsToSend }),
        ...(request.idempotencyKey
          ? { idempotencyKey: request.idempotencyKey }
          : {}),
      })
      preparedPayments.delete(request.prepareResponse)
      if (isNativeTransfer(initial)) {
        throw new Error(
          "Spark returned an unexpected direct transfer for a Lightning payment."
        )
      }
      return {
        payment: await reconcileLightningPayment({
          wallet: input.wallet,
          initial,
          maxFeeSats: prepared.feeSats,
          expectedPaymentHash: prepared.expectedPaymentHash,
          timeoutSecs: request.options.completionTimeoutSecs ?? 60,
          pollIntervalMs: input.pollIntervalMs,
          wait: input.wait,
          now: input.now,
        }),
      }
    },
    async receivePayment(request) {
      if (request.paymentMethod.type === "sparkAddress") {
        const paymentRequest = validateSparkReceiveAddress({
          module: input.module,
          network: input.network,
          paymentRequest: await input.wallet.getSparkAddress(),
        })
        return {
          paymentRequest,
          fee: 0n,
        }
      }
      const amountSats = request.paymentMethod.amountSats ?? 0
      const result = await input.wallet.createLightningInvoice({
        amountSats,
        memo: request.paymentMethod.description,
        expirySeconds: request.paymentMethod.expirySecs,
        includeSparkInvoice: true,
      })
      return {
        paymentRequest: validateLightningReceiveInvoice({
          amountSats,
          network: input.network,
          paymentRequest: result.invoice.encodedInvoice,
        }),
        fee: 0n,
      }
    },
  }
}

function getRecommendedLightningMaxFeeSats(amountSats: number): number {
  return Math.max(5, Math.ceil(amountSats * 0.0017))
}

async function reconcileSparkTransfer(input: {
  wallet: SparkNativeWallet
  initial: SparkNativeTransfer
  timeoutSecs: number
  pollIntervalMs: number
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}): Promise<SparkSdkPayment> {
  const deadline = input.now() + Math.max(0, input.timeoutSecs) * 1_000
  let transfer = input.initial

  while (true) {
    const status = mapTransferStatus(transfer.status)
    if (status !== "pending") {
      return {
        id: transfer.id,
        status,
        fees: 0n,
      }
    }

    const remainingMs = deadline - input.now()
    if (remainingMs <= 0) {
      return {
        id: transfer.id,
        status: "pending",
        fees: 0n,
      }
    }
    await input.wait(Math.min(input.pollIntervalMs, remainingMs))
    const next = await input.wallet.getTransfer(transfer.id)
    if (next) transfer = next
  }
}

async function reconcileLightningPayment(input: {
  wallet: SparkNativeWallet
  initial: SparkNativeLightningSendRequest
  maxFeeSats: number
  expectedPaymentHash: Uint8Array
  timeoutSecs: number
  pollIntervalMs: number
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}): Promise<SparkSdkPayment> {
  const deadline = input.now() + Math.max(0, input.timeoutSecs) * 1_000
  let request = input.initial

  while (true) {
    const feeSats = readNativeLightningFeeSats(request.fee, input.maxFeeSats)
    if (request.paymentPreimage) {
      const preimage = decodePaymentPreimage(request.paymentPreimage)
      const paymentHash = await sha256Bytes(preimage.bytes)
      if (!equalBytesNoEarlyExit(paymentHash, input.expectedPaymentHash)) {
        throw new Error(
          "Spark returned a Lightning preimage that does not match the prepared invoice."
        )
      }
      return {
        id: request.id,
        status: "completed",
        fees: BigInt(feeSats),
        details: {
          type: "lightning",
          htlcDetails: {
            preimage: preimage.hex,
            paymentHash: bytesToHex(paymentHash),
          },
        },
      }
    }
    if (LIGHTNING_FAILURE_STATUSES.has(request.status)) {
      return {
        id: request.id,
        status: "failed",
        fees: BigInt(feeSats),
        details: { type: "lightning" },
      }
    }

    const remainingMs = deadline - input.now()
    if (remainingMs <= 0) {
      return {
        id: request.id,
        status: "pending",
        fees: BigInt(feeSats),
        details: { type: "lightning" },
      }
    }
    await input.wait(Math.min(input.pollIntervalMs, remainingMs))
    const next = await input.wallet.getLightningSendRequest(request.id)
    if (next) request = next
  }
}

function mapNativeTransfer(
  transfer: SparkNativeTransfer
): Awaited<ReturnType<SparkSdkClient["listPayments"]>>["payments"][number] {
  return {
    id: transfer.id,
    paymentType: transfer.transferDirection === "OUTGOING" ? "send" : "receive",
    status: mapTransferStatus(transfer.status),
    amountSats: safeNumber(transfer.totalValue),
    feeSats: readTransferFeeSats(transfer.userRequest),
    timestamp:
      transfer.createdTime?.getTime() ??
      transfer.updatedTime?.getTime() ??
      Date.now(),
    method: getTransferMethod(transfer),
  }
}

function mapTransferStatus(status: string): "completed" | "pending" | "failed" {
  if (status === "TRANSFER_STATUS_COMPLETED") return "completed"
  if (
    status === "TRANSFER_STATUS_EXPIRED" ||
    status === "TRANSFER_STATUS_RETURNED"
  ) {
    return "failed"
  }
  return "pending"
}

function getTransferMethod(
  transfer: SparkNativeTransfer
): "lightning" | "spark" | "token" | "deposit" | "withdraw" | "unknown" {
  const userRequest = asRecord(transfer.userRequest)
  const typename =
    typeof userRequest?.typename === "string" ? userRequest.typename : ""
  if (
    typename === "LightningSendRequest" ||
    typename === "LightningReceiveRequest" ||
    transfer.type === "PREIMAGE_SWAP"
  ) {
    return "lightning"
  }
  if (transfer.type === "TRANSFER") return "spark"
  if (transfer.type === "COOPERATIVE_EXIT") return "withdraw"
  if (transfer.type === "UTXO_SWAP") return "deposit"
  return "unknown"
}

function readTransferFeeSats(userRequest: unknown): number {
  const fee = asRecord(asRecord(userRequest)?.fee)
  if (!fee) return 0
  const value = fee.originalValue
  const unit = fee.originalUnit
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0
  }
  if (unit === "SATOSHI") return Math.ceil(value)
  if (unit === "MILLISATOSHI") return Math.ceil(value / 1_000)
  return 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null
}

function isNativeTransfer(
  value: SparkNativeLightningSendRequest | SparkNativeTransfer
): value is SparkNativeTransfer {
  return "transferDirection" in value
}

function safeNumber(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function bigintToSafeNumber(value: bigint, message: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(message)
  }
  return number
}

function readNativeLightningFeeSats(
  fee: SparkNativeCurrencyAmount,
  maxFeeSats: number
): number {
  if (!Number.isFinite(fee.originalValue) || fee.originalValue < 0) {
    throw new Error("Spark returned an invalid Lightning payment fee.")
  }
  const feeSats =
    fee.originalUnit === "SATOSHI"
      ? Math.ceil(fee.originalValue)
      : fee.originalUnit === "MILLISATOSHI"
        ? Math.ceil(fee.originalValue / 1_000)
        : Number.NaN
  if (!Number.isSafeInteger(feeSats) || feeSats < 0 || feeSats > maxFeeSats) {
    throw new Error(
      feeSats > maxFeeSats
        ? "Spark returned a Lightning fee above the approved maximum."
        : "Spark returned an invalid Lightning payment fee."
    )
  }
  return feeSats
}

function isSparkAddress(
  module: SparkNativeModule,
  paymentRequest: string
): boolean {
  try {
    return module.isValidSparkAddress(paymentRequest) === true
  } catch {
    return false
  }
}

function validateSparkReceiveAddress(input: {
  module: SparkNativeModule
  network: SparkNativeNetwork
  paymentRequest: string
}): string {
  const paymentRequest = input.paymentRequest.trim()
  if (!paymentRequest || !isSparkAddress(input.module, paymentRequest)) {
    throw new Error("Spark returned an invalid receive address.")
  }

  let actualNetwork: string
  try {
    actualNetwork = input.module.getNetworkFromSparkAddress(paymentRequest)
  } catch (error) {
    throw new Error("Spark returned an invalid receive address.", {
      cause: error,
    })
  }
  if (actualNetwork !== input.network) {
    throw new Error(
      "Spark returned a receive address for a different Bitcoin network."
    )
  }

  try {
    if (
      input.module.decodeSparkAddress(paymentRequest, input.network)
        .sparkInvoiceFields !== undefined
    ) {
      throw new Error(
        "Spark returned an invoice instead of a plain receive address."
      )
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "Spark returned an invoice instead of a plain receive address."
    ) {
      throw error
    }
    throw new Error("Spark returned an invalid receive address.", {
      cause: error,
    })
  }

  return paymentRequest
}

function validateLightningReceiveInvoice(input: {
  amountSats: number
  network: SparkNativeNetwork
  paymentRequest: string
}): string {
  const paymentRequest = input.paymentRequest.trim()
  const expectedNetwork = fromNativeNetwork(input.network)
  if (getLightningInvoiceNetwork(paymentRequest) !== expectedNetwork) {
    throw new Error(
      "Spark returned a Lightning invoice for a different Bitcoin network."
    )
  }

  if (!decodeLightningInvoicePaymentHash(paymentRequest)) {
    throw new Error(
      "Spark returned a Lightning invoice without a valid payment hash."
    )
  }

  const decodedAmount = decodeLightningInvoiceAmount(paymentRequest)
  if (input.amountSats === 0) {
    if (
      !isAmountlessLightningInvoice(paymentRequest) ||
      decodedAmount.msats !== null
    ) {
      throw new Error(
        "Spark returned an amount when an amountless Lightning invoice was requested."
      )
    }
    return paymentRequest
  }

  const expectedAmountMsats = input.amountSats * 1_000
  if (
    !Number.isSafeInteger(expectedAmountMsats) ||
    decodedAmount.msats !== expectedAmountMsats
  ) {
    throw new Error(
      "Spark returned a Lightning invoice with a different amount."
    )
  }

  return paymentRequest
}

function toNativeNetwork(network: SupportedSparkNetwork): SparkNativeNetwork {
  switch (network) {
    case "mainnet":
      return "MAINNET"
    case "regtest":
      return "REGTEST"
  }
}

function fromNativeNetwork(network: SparkNativeNetwork): SparkNetwork {
  switch (network) {
    case "MAINNET":
      return "mainnet"
    case "TESTNET":
      return "testnet"
    case "SIGNET":
      return "signet"
    case "REGTEST":
      return "regtest"
  }
}

function decodePaymentPreimage(value: string): {
  hex: string
  bytes: Uint8Array
} {
  return decodeHex32(
    value,
    "Spark returned an invalid Lightning payment preimage."
  )
}

function decodeHex32(
  value: string,
  invalidMessage: string
): {
  hex: string
  bytes: Uint8Array
} {
  const hex = value.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(invalidMessage)
  }
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  )
  return { hex, bytes }
}

async function sha256Bytes(value: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", value.slice().buffer)
  return new Uint8Array(digest)
}

function equalBytesNoEarlyExit(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function withReadTimeout<T>(
  read: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} exceeded ${timeoutMs}ms.`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function loadFirstPartySparkModule(): Promise<SparkNativeModule> {
  const module = await import("@buildonspark/spark-sdk")
  const eventNames = Object.values(module.SparkWalletEvent).filter(
    (eventName) => eventName !== module.SparkWalletEvent.All
  )
  return {
    eventNames,
    createPublicReadonlyClient(options) {
      return module.SparkReadonlyClient.createPublic(options)
    },
    decodeSparkAddress: module.decodeSparkAddress,
    getNetworkFromSparkAddress: module.getNetworkFromSparkAddress,
    isValidSparkAddress: module.isValidSparkAddress,
    async initialize(input) {
      const { wallet } = await module.SparkWallet.initialize(input)
      return {
        wallet: {
          on(event, listener) {
            wallet.on(
              event as import("@buildonspark/spark-sdk").SparkWalletEventType,
              listener
            )
          },
          off(event, listener) {
            wallet.off(
              event as import("@buildonspark/spark-sdk").SparkWalletEventType,
              listener
            )
          },
          cleanup: () => wallet.cleanup(),
          setPrivacyEnabled: (enabled) => wallet.setPrivacyEnabled(enabled),
          getWalletSettings: () => wallet.getWalletSettings(),
          getBalance: async () => {
            const balance = await wallet.getBalance()
            return { balance: balance.satsBalance.available }
          },
          getTransfers: (limit, offset) => wallet.getTransfers(limit, offset),
          getSparkAddress: () => wallet.getSparkAddress(),
          transfer: (request) => wallet.transfer(request),
          getTransfer: (id) => wallet.getTransfer(id),
          createLightningInvoice: (request) =>
            wallet.createLightningInvoice(request),
          getLightningSendFeeEstimate: (request) =>
            wallet.getLightningSendFeeEstimate(request),
          payLightningInvoice: (request) => wallet.payLightningInvoice(request),
          getLightningSendRequest: (id) => wallet.getLightningSendRequest(id),
        },
      }
    },
  }
}

export function getSparkNetwork(): SparkNetwork {
  return getWalletNetworkFromLightningConfig(config.lightningNetwork)
}

export function getDefaultSparkAccountNumber(network: SparkNetwork): number {
  return network === "regtest" ? 0 : 1
}

export type SparkConfiguration =
  | {
      status: "ready"
      network: SupportedSparkNetwork
    }
  | { status: "unavailable"; reason: string }

export function getSparkConfigurationForNetwork(
  network: SparkNetwork
): SparkConfiguration {
  if (network !== "mainnet" && network !== "regtest") {
    return {
      status: "unavailable",
      reason: `Spark Portable Wallets are not supported on ${network} by the installed first-party SDK.`,
    }
  }

  return { status: "ready", network }
}

export function getSparkConfiguration(
  options: {
    network?: SparkNetwork
    sessionCoordinationAvailable?: boolean
  } = {}
): SparkConfiguration {
  const networkConfiguration = getSparkConfigurationForNetwork(
    options.network ?? getSparkNetwork()
  )
  if (networkConfiguration.status === "unavailable") {
    return networkConfiguration
  }

  const sessionCoordinationAvailable =
    options.sessionCoordinationAvailable ??
    isSparkWalletSessionCoordinationAvailable()
  if (!sessionCoordinationAvailable) {
    return {
      status: "unavailable",
      reason:
        "This browser cannot safely coordinate Portable Wallet sessions across tabs.",
    }
  }

  return networkConfiguration
}

let sparkWalletManager: SparkWalletManager | null = null

export function getSparkWalletManager(): SparkWalletManager | null {
  const configuration = getSparkConfiguration()
  if (configuration.status === "unavailable") {
    return null
  }
  sparkWalletManager ??= new SparkWalletManager(
    new FirstPartySparkSdkFactory({
      network: configuration.network,
    })
  )
  return sparkWalletManager
}

/** Report local manager state without initializing Spark. */
export function isSparkWalletManagerInitialized(): boolean {
  return sparkWalletManager !== null
}

export async function payInvoiceWithSparkWallet(
  walletId: string,
  input: SparkPayInvoiceInput
) {
  const manager = getSparkWalletManager()
  if (!manager) {
    return {
      status: "pre_publish_failed" as const,
      reason: "Spark is unavailable in this Market build.",
    }
  }
  return manager.payInvoice(walletId, input)
}
