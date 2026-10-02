import {
  config,
  decodeLightningInvoiceAmount,
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  ensureSparkPrivateModeReady,
  getLightningInvoiceNetwork,
  getWalletNetworkFromLightningConfig,
  hasCheckoutSparkProviderSendWindow,
  isAmountlessLightningInvoice,
  isValidLightningInvoice,
  normalizeLightningInvoice,
  readExactSparkLightningRecoveredTransfer,
  verifyExactSparkLightningRequestDebit,
  type CheckoutSparkNativeRetirementReader,
  type WalletNetwork,
} from "@conduit/core"

import {
  SparkWalletManager,
  type SparkCheckoutLightningObligationInput,
  type SparkCheckoutLightningFeeEstimateInput,
  type SparkCheckoutReceiveInput,
  type SparkCheckoutReceiveFailureReason,
  type SparkCheckoutHistoricalReceiveAttestation,
  type SparkCheckoutHistoricalReceiveTarget,
  type SparkCheckoutReceiveReconciliation,
  type SparkCheckoutReceiveRequest,
  type SparkCheckoutRetirementSession,
  type SparkFundsState,
  type SparkPreparedPayment,
  type SparkPayInvoiceInput,
  type SparkSdkClient,
  type SparkSdkFactory,
  type SparkSdkPayment,
} from "./spark-wallet"
import { isSparkWalletSessionCoordinationAvailable } from "./spark-wallet-lease"
import { canUseCheckoutSparkLocalRouterCanary } from "./checkout-spark-local-router-canary"
import { CHECKOUT_SPARK_LOCAL_UNQUOTED_RECEIVE_POLICY } from "./checkout-spark-unquoted-canary"
import { proveSparkCheckoutReceiveCredit } from "./spark-checkout-receive-credit"

export type SparkNetwork = WalletNetwork
export type SupportedSparkNetwork = Extract<SparkNetwork, "mainnet" | "regtest">
export type SparkNativeNetwork = "MAINNET" | "TESTNET" | "SIGNET" | "REGTEST"
type SparkNativeTransferId = import("@buildonspark/spark-sdk").UUID
type SparkNativeReceiveQuote =
  import("@buildonspark/spark-sdk").LightningReceiveQuote

interface SparkNativeWalletSettings {
  privateEnabled: boolean
}

interface SparkNativeCurrencyAmount {
  originalValue: number
  originalUnit: string
}

interface SparkNativeInvoice {
  encodedInvoice: string
  bitcoinNetwork: string
  paymentHash: string
  amount: SparkNativeCurrencyAmount
  createdAt: string
  expiresAt: string
}

interface SparkNativeLightningReceiveRequest {
  id: string
  status: string
  network: string
  invoice: SparkNativeInvoice
  transfer?: {
    sparkId?: string
    totalAmount: SparkNativeCurrencyAmount
    userRequestId?: string
  }
}

interface SparkNativeTransfer {
  id: string
  status: string
  totalValue: number
  type: string
  transferDirection: string
  receiverIdentityPublicKey?: string
  receivers?: Array<{
    identityPublicKey: string
    amountSats: number
    status: string
  }>
  createdTime?: Date
  updatedTime?: Date
  userRequest?: unknown
}

interface SparkNativeSspTransfer {
  sparkId?: string
  totalAmount?: SparkNativeCurrencyAmount
  userRequest?: unknown
}

interface SparkNativeLightningSendRequest {
  id: string
  status: string
  fee: SparkNativeCurrencyAmount
  paymentPreimage?: string | null
}

export interface SparkNativeWallet {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
  cleanup(): Promise<void>
  setPrivacyEnabled(
    enabled: boolean
  ): Promise<SparkNativeWalletSettings | undefined>
  getWalletSettings(): Promise<SparkNativeWalletSettings | undefined>
  getBalance(): Promise<{
    balance: bigint
    satsBalance: {
      available: bigint
      owned: bigint
      incoming: bigint
    }
  }>
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
  getTransferFromSsp(id: string): Promise<SparkNativeSspTransfer | undefined>
  createLightningInvoice(input: {
    amountSats: number
    memo?: string
    expirySeconds?: number
    includeSparkAddress?: boolean
    includeSparkInvoice?: boolean
    receiverIdentityPubkey?: string
    quote?: SparkNativeReceiveQuote
  }): Promise<SparkNativeLightningReceiveRequest>
  getIdentityPublicKey(): Promise<string>
  /** Uses this initialized wallet's signer; never a public privacy-filtered reader. */
  openRetirementReader?(): Promise<{
    reader: CheckoutSparkNativeRetirementReader
    cleanup(): Promise<void>
  }>
  getLightningReceiveQuote(input: {
    amountSats: number
    amountBasis: "NET"
  }): Promise<SparkNativeReceiveQuote>
  getLightningReceiveRequest(
    id: string
  ): Promise<SparkNativeLightningReceiveRequest | null>
  getLightningSendFeeEstimate(input: {
    encodedInvoice: string
    amountSats?: number
  }): Promise<number>
  payLightningInvoice(input: {
    invoice: string
    maxFeeSats: number
    preferSpark: boolean
    amountSatsToSend?: number
    transferId?: SparkNativeTransferId
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
  parseTransferId(value: string): SparkNativeTransferId
  inspectLightningReceiveQuote(input: {
    quote: SparkNativeReceiveQuote
    receiverIdentityPubkey: string
    network: SparkNativeNetwork
  }): {
    grossSats: number
    netSats: number
    feeSats: number
    feeComponents: number
    expiresAt: number
  }
  isPreSendFeeCapError(error: unknown): boolean
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
  ): { sparkInvoiceFields?: unknown; identityPublicKey?: string }
  isValidSparkAddress(address: string): boolean
  getNetworkFromSparkAddress(address: string): string
}

interface FirstPartySparkSdkFactoryOptions {
  network: SupportedSparkNetwork
  loadModule?: () => Promise<SparkNativeModule>
  pollIntervalMs?: number
  retirementReadTimeoutMs?: number
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

const LIGHTNING_RECOVERY_CONFLICT_MESSAGES = new Set([
  "Spark returned an invalid Lightning payment fee.",
  "Spark returned a Lightning fee above the approved maximum.",
  "Spark returned a conflicting Lightning transfer total.",
  "Spark returned a conflicting Lightning request identity.",
  "Spark returned an invalid Lightning payment preimage.",
  "Spark returned a Lightning preimage that does not match the prepared invoice.",
])

const EXACT_LIGHTNING_TRANSFER_CONFLICT_MESSAGES = new Set([
  "Spark returned a conflicting transfer identity.",
  "Spark returned invalid Lightning recovery evidence.",
  "Spark returned a conflicting Lightning payment identity.",
  "Spark returned a different Lightning invoice.",
])

class SparkLightningLookupUnavailableError extends Error {
  constructor() {
    super("Spark payment status could not be checked.")
    this.name = "SparkLightningLookupUnavailableError"
  }
}

function canonicalLightningInvoice(invoice: string): string | null {
  const normalized = normalizeLightningInvoice(invoice)
  const hasLowercase = /[a-z]/.test(normalized)
  const hasUppercase = /[A-Z]/.test(normalized)
  return hasLowercase && hasUppercase ? null : normalized.toLowerCase()
}

export class FirstPartySparkSdkFactory implements SparkSdkFactory {
  readonly network: SupportedSparkNetwork
  readonly #loadModule: () => Promise<SparkNativeModule>
  readonly #pollIntervalMs: number
  readonly #retirementReadTimeoutMs: number
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
    this.#retirementReadTimeoutMs = input.retirementReadTimeoutMs ?? 5_000
    if (
      !Number.isSafeInteger(this.#retirementReadTimeoutMs) ||
      this.#retirementReadTimeoutMs < 1 ||
      this.#retirementReadTimeoutMs > 5_000
    ) {
      throw new Error("Spark retirement read timeout is invalid.")
    }
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
      await ensureSparkPrivateModeReady({
        wallet,
        createPublicReader: () =>
          module.createPublicReadonlyClient({
            log: false,
            network: toNativeNetwork(this.network),
          }),
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
        walletId: input.walletId,
        wallet,
        module,
        network: toNativeNetwork(this.network),
        pollIntervalMs: this.#pollIntervalMs,
        retirementReadTimeoutMs: this.#retirementReadTimeoutMs,
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

function adaptFirstPartySparkWallet(input: {
  walletId: string
  wallet: SparkNativeWallet
  module: SparkNativeModule
  network: SparkNativeNetwork
  pollIntervalMs: number
  retirementReadTimeoutMs: number
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
  let disconnected = false
  const retirementSessions = new Set<SparkCheckoutRetirementSession>()

  const openCheckoutRetirementReader: NonNullable<
    SparkSdkClient["openCheckoutRetirementReader"]
  > = async (target) => {
    const expected = { ...target }
    const assertCurrent = () => {
      if (disconnected)
        throw new Error("Checkout Spark retirement session is closed.")
    }
    const boundedRead = async <T>(action: () => Promise<T>): Promise<T> => {
      assertCurrent()
      const result = await withReadTimeout(
        action(),
        input.retirementReadTimeoutMs,
        "Checkout Spark retirement read"
      )
      assertCurrent()
      return result
    }
    if (
      expected.walletId !== input.walletId ||
      toNativeNetwork(expected.network) !== input.network ||
      !/^(02|03)[0-9a-f]{64}$/.test(expected.receiverIdentityPublicKey)
    ) {
      throw new Error("Checkout Spark retirement wallet does not match.")
    }
    if (!input.wallet.openRetirementReader) {
      throw new Error(
        "Authenticated Spark retirement inspection is unavailable."
      )
    }
    const identity = await boundedRead(() =>
      input.wallet.getIdentityPublicKey()
    )
    const sparkAddress = await boundedRead(() => input.wallet.getSparkAddress())
    if (
      identity !== expected.receiverIdentityPublicKey ||
      !isSparkAddress(input.module, sparkAddress) ||
      input.module.getNetworkFromSparkAddress(sparkAddress) !== input.network ||
      input.module.decodeSparkAddress(sparkAddress, input.network)
        .identityPublicKey !== identity
    ) {
      throw new Error("Checkout Spark retirement wallet does not match.")
    }
    // A late open after timeout/disconnect must still release its own connections.
    let openingAbandoned = false
    const opening = input.wallet
      .openRetirementReader()
      .then(async (session) => {
        if (openingAbandoned || disconnected) {
          await session.cleanup()
          throw new Error(
            "Checkout Spark retirement reader opening was cancelled."
          )
        }
        return session
      })
    let native: Awaited<typeof opening>
    try {
      native = await withReadTimeout(
        opening,
        input.retirementReadTimeoutMs,
        "Checkout Spark retirement read"
      )
    } catch (error) {
      openingAbandoned = true
      throw error
    }
    let closed = false
    let cleanupPromise: Promise<void> | undefined
    const session: SparkCheckoutRetirementSession = {
      sparkAddress,
      reader: {
        getTransfers: (params) =>
          read(params.sparkAddress, () =>
            native.reader.getTransfers({ ...params, types: [...params.types] })
          ),
        getPendingTransfers: (address) =>
          read(address, () => native.reader.getPendingTransfers(address)),
        getAvailableBalance: (address) =>
          read(address, () => native.reader.getAvailableBalance(address)),
        getOwnedBalance: (address) =>
          read(address, () => native.reader.getOwnedBalance(address)),
      },
      cleanup() {
        closed = true
        cleanupPromise ??= native
          .cleanup()
          .then(() => {
            retirementSessions.delete(session)
          })
          .catch((error: unknown) => {
            cleanupPromise = undefined
            throw error
          })
        return cleanupPromise
      },
    }
    async function read<T>(
      address: string,
      action: () => Promise<T>
    ): Promise<T> {
      if (closed || address !== sparkAddress)
        throw new Error("Checkout Spark retirement reader is out of scope.")
      const result = await boundedRead(action)
      if (closed) throw new Error("Checkout Spark retirement reader is closed.")
      return result
    }
    retirementSessions.add(session)
    try {
      assertCurrent()
      return session
    } catch (error) {
      await session.cleanup()
      throw error
    }
  }

  const readFundsState = async (): Promise<SparkFundsState> => {
    const balance = await input.wallet.getBalance()
    const availableSats = bigintToSafeNumber(
      balance.satsBalance.available,
      "Spark returned an available balance outside the browser's safe range."
    )
    const ownedSats = bigintToSafeNumber(
      balance.satsBalance.owned,
      "Spark returned an owned balance outside the browser's safe range."
    )
    const incomingSats = bigintToSafeNumber(
      balance.satsBalance.incoming,
      "Spark returned an incoming balance outside the browser's safe range."
    )
    if (ownedSats < availableSats) {
      throw new Error("Spark returned an inconsistent funds state.")
    }
    const observedAt = input.now()
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new Error("Spark returned an invalid funds observation time.")
    }
    return { availableSats, ownedSats, incomingSats, observedAt }
  }

  const createCheckoutReceive = async (
    request: SparkCheckoutReceiveInput
  ): Promise<SparkCheckoutReceiveRequest> => {
    validateCheckoutReceiveInput(request)
    if (request.grossFundingSats !== request.requiredNetSats) {
      throw new Error(
        "Spark checkout funding requires an exact net receive quote."
      )
    }
    if (request.receiveMode === "local_unquoted_canary") {
      if (!canUseCheckoutSparkLocalRouterCanary()) {
        throw new Error("Spark local unquoted checkout is unavailable.")
      }
      let result: SparkNativeLightningReceiveRequest
      try {
        result = await input.wallet.createLightningInvoice({
          amountSats: request.grossFundingSats,
          memo: request.description,
          expirySeconds: request.expirySecs,
          includeSparkAddress: false,
          includeSparkInvoice: false,
        })
      } catch {
        throw new Error("Spark checkout funding invoice is unavailable.")
      }
      return {
        ...mapNativeCheckoutReceive({
          native: result,
          walletId: input.walletId,
          network: input.network,
          requiredNetSats: request.requiredNetSats,
          grossFundingSats: request.grossFundingSats,
          expirySecs: request.expirySecs,
        }),
        receiveCanaryPolicy: CHECKOUT_SPARK_LOCAL_UNQUOTED_RECEIVE_POLICY,
      }
    }
    if (request.receiveMode === "ordinary_settled_v3") {
      const receiverIdentityPublicKey = (
        await input.wallet.getIdentityPublicKey()
      ).toLowerCase()
      if (!/^(02|03)[0-9a-f]{64}$/.test(receiverIdentityPublicKey)) {
        throw new Error("Spark settled checkout wallet identity is invalid.")
      }
      let result: SparkNativeLightningReceiveRequest
      try {
        result = await input.wallet.createLightningInvoice({
          amountSats: request.grossFundingSats,
          memo: request.description,
          expirySeconds: request.expirySecs,
          includeSparkAddress: false,
          includeSparkInvoice: false,
        })
      } catch {
        throw new Error("Spark checkout funding invoice is unavailable.")
      }
      if (
        (await input.wallet.getIdentityPublicKey()).toLowerCase() !==
        receiverIdentityPublicKey
      ) {
        throw new Error("Spark settled checkout wallet identity changed.")
      }
      return {
        ...mapNativeCheckoutReceive({
          native: result,
          walletId: input.walletId,
          network: input.network,
          requiredNetSats: request.requiredNetSats,
          grossFundingSats: request.grossFundingSats,
          expirySecs: request.expirySecs,
        }),
        receiveSettledPolicy: "ordinary-exact-credit-v3",
        receiverIdentityPublicKey,
      }
    }
    // Query and attest on the same open wallet that creates the invoice.
    // Never estimate a receive fee by opening a second ephemeral wallet.
    const receiverIdentityPubkey = await input.wallet.getIdentityPublicKey()
    let quote: SparkNativeReceiveQuote
    try {
      // The dated mainnet SSP schema defaults the quote receiver to its caller.
      // Explicit receiver_identity_pubkey is RC-only; verify the signed quote
      // against this same wallet's identity below instead of sending that field.
      quote = await input.wallet.getLightningReceiveQuote({
        amountSats: request.requiredNetSats,
        amountBasis: "NET",
      })
    } catch {
      // Provider errors may include identity keys or request details.
      throw new Error("Spark checkout receive quote is unavailable.")
    }
    if (
      quote.amountSats !== request.requiredNetSats ||
      quote.amountBasis !== "NET" ||
      !quote.serializedManifest ||
      !quote.issuerSignature
    ) {
      throw new Error("Spark checkout receive quote is incomplete or changed.")
    }
    const quoted = input.module.inspectLightningReceiveQuote({
      quote,
      receiverIdentityPubkey,
      network: input.network,
    })
    if (
      quoted.grossSats !== request.grossFundingSats ||
      quoted.netSats !== request.requiredNetSats ||
      quoted.feeSats !== 0 ||
      quoted.feeComponents !== 0 ||
      !Number.isSafeInteger(quoted.expiresAt) ||
      quoted.expiresAt <= Date.now()
    ) {
      throw new Error(
        "Spark checkout receive quote has an unsupported fee or amount."
      )
    }
    if (
      (await input.wallet.getIdentityPublicKey()) !== receiverIdentityPubkey
    ) {
      throw new Error("Spark checkout receive wallet identity changed.")
    }
    let result: SparkNativeLightningReceiveRequest
    try {
      result = await input.wallet.createLightningInvoice({
        amountSats: request.grossFundingSats,
        memo: request.description,
        expirySeconds: request.expirySecs,
        includeSparkAddress: false,
        includeSparkInvoice: false,
        receiverIdentityPubkey,
        quote,
      })
    } catch {
      // Do not expose provider response metadata through checkout errors.
      throw new Error("Spark checkout funding invoice is unavailable.")
    }
    const received = mapNativeCheckoutReceive({
      native: result,
      walletId: input.walletId,
      network: input.network,
      requiredNetSats: request.requiredNetSats,
      grossFundingSats: request.grossFundingSats,
      expirySecs: request.expirySecs,
    })
    return {
      ...received,
      receiveQuotePolicy: "same-wallet-feeless-net-v1",
    }
  }

  const reconcileCheckoutReceive = async (
    request: SparkCheckoutReceiveRequest
  ): Promise<SparkCheckoutReceiveReconciliation> => {
    validateCheckoutReceiveRequest(request)
    if (
      request.walletId !== input.walletId ||
      request.network !== fromNativeNetwork(input.network)
    ) {
      throw new Error(
        "The Spark checkout receive request belongs to a different wallet or network."
      )
    }
    let native: SparkNativeLightningReceiveRequest | null
    try {
      native = await input.wallet.getLightningReceiveRequest(request.id)
    } catch {
      return {
        state: "unresolved_failure",
        providerStatus: null,
        failureReason: "lookup_unavailable",
        funds: await readFundsState(),
      }
    }
    let funds = await readFundsState()
    if (!native) {
      return {
        state: "unresolved_failure",
        providerStatus: null,
        failureReason: "receive_not_found",
        funds,
      }
    }

    let current: SparkCheckoutReceiveRequest
    try {
      current = mapNativeCheckoutReceive({
        native,
        walletId: input.walletId,
        network: input.network,
        requiredNetSats: request.requiredNetSats,
        grossFundingSats: request.grossFundingSats,
        expirySecs: request.expirySecs,
      })
      assertSameCheckoutReceiveRequest(request, current)
    } catch {
      return {
        state: "unresolved_failure",
        providerStatus: normalizeProviderStatus(native.status),
        failureReason: "conflicting_evidence",
        funds,
      }
    }
    // Spark can report the exact receive as completed before a separate
    // balance read reflects its spendable leaves. Re-read both pieces of
    // evidence briefly; never submit another payment or infer funds from the
    // payer's proof alone. A persistent shortfall still fails closed.
    for (
      let attempt = 0;
      attempt < 10 &&
      current.providerStatus === "TRANSFER_COMPLETED" &&
      funds.availableSats < request.requiredNetSats;
      attempt += 1
    ) {
      await input.wait(Math.max(input.pollIntervalMs, 500))
      let refreshed: SparkNativeLightningReceiveRequest | null
      try {
        refreshed = await input.wallet.getLightningReceiveRequest(request.id)
      } catch {
        return {
          state: "unresolved_failure",
          providerStatus: null,
          failureReason: "lookup_unavailable",
          funds,
        }
      }
      funds = await readFundsState()
      if (!refreshed) {
        return {
          state: "unresolved_failure",
          providerStatus: null,
          failureReason: "receive_not_found",
          funds,
        }
      }
      try {
        current = mapNativeCheckoutReceive({
          native: refreshed,
          walletId: input.walletId,
          network: input.network,
          requiredNetSats: request.requiredNetSats,
          grossFundingSats: request.grossFundingSats,
          expirySecs: request.expirySecs,
        })
        assertSameCheckoutReceiveRequest(request, current)
      } catch {
        return {
          state: "unresolved_failure",
          providerStatus: normalizeProviderStatus(refreshed.status),
          failureReason: "conflicting_evidence",
          funds,
        }
      }
    }
    const outcome = mapCheckoutReceiveState(current.providerStatus, {
      availableSats: funds.availableSats,
      requiredNetSats: request.requiredNetSats,
      observedAt: funds.observedAt,
      expiresAt: request.expiresAt,
    })
    return {
      state: outcome.state,
      providerStatus: current.providerStatus,
      failureReason: outcome.failureReason,
      funds,
    }
  }

  const attestCheckoutReceiveCredit = async (
    request: SparkCheckoutReceiveRequest
  ) => {
    validateCheckoutReceiveRequest(request)
    if (
      request.walletId !== input.walletId ||
      request.network !== fromNativeNetwork(input.network) ||
      request.receiveSettledPolicy !== "ordinary-exact-credit-v3" ||
      !/^(02|03)[0-9a-f]{64}$/.test(request.receiverIdentityPublicKey ?? "") ||
      request.receiveQuotePolicy !== undefined ||
      request.receiveCanaryPolicy !== undefined
    ) {
      throw new Error("Spark settled checkout receive identity is invalid.")
    }
    let native: SparkNativeLightningReceiveRequest | null
    try {
      native = await input.wallet.getLightningReceiveRequest(request.id)
    } catch {
      throw new Error("Spark settled checkout receive lookup is unavailable.")
    }
    if (!native) return null
    try {
      const current = mapNativeCheckoutReceive({
        native,
        walletId: input.walletId,
        network: input.network,
        requiredNetSats: request.requiredNetSats,
        grossFundingSats: request.grossFundingSats,
        expirySecs: request.expirySecs,
        allowSettledShortfall: true,
      })
      assertSameCheckoutReceiveRequest(request, current)
    } catch {
      throw new Error(
        "Spark settled checkout receive evidence conflicts with its invoice."
      )
    }
    if (native.status !== "TRANSFER_COMPLETED") return null
    const transferId = native.transfer?.sparkId
    if (!transferId) return null
    let transfer: SparkNativeTransfer | undefined
    let walletIdentityPublicKey: string
    try {
      ;[transfer, walletIdentityPublicKey] = await Promise.all([
        input.wallet.getTransfer(transferId),
        input.wallet.getIdentityPublicKey(),
      ])
    } catch {
      throw new Error("Spark settled checkout transfer lookup is unavailable.")
    }
    if (!transfer) return null
    if (
      walletIdentityPublicKey.toLowerCase() !==
      request.receiverIdentityPublicKey
    ) {
      throw new Error("Spark settled checkout receiver identity changed.")
    }
    const userRequest = asRecord(transfer.userRequest)
    return proveSparkCheckoutReceiveCredit({
      expectedRequest: request,
      expectedReceive: { mode: "ordinary_v3" },
      walletIdentityPublicKey,
      receive: native,
      transfer: {
        ...transfer,
        userRequest:
          typeof userRequest?.id === "string"
            ? { id: userRequest.id }
            : undefined,
      },
    })
  }

  const attestCheckoutReceiveHistory = async (
    target: SparkCheckoutHistoricalReceiveTarget
  ): Promise<SparkCheckoutHistoricalReceiveAttestation> => {
    const expected = validateCheckoutHistoricalReceiveTarget(target, {
      walletId: input.walletId,
      network: input.network,
    })
    const observedAt = () => {
      const value = input.now()
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Spark checkout receive observation time is invalid.")
      }
      return value
    }
    const unconfirmed = (
      reason: Extract<
        SparkCheckoutHistoricalReceiveAttestation,
        { status: "unconfirmed" }
      >["reason"]
    ): SparkCheckoutHistoricalReceiveAttestation => ({
      status: "unconfirmed",
      reason,
      observedAt: observedAt(),
    })
    let native: SparkNativeLightningReceiveRequest | null
    try {
      native = await input.wallet.getLightningReceiveRequest(target.requestId)
    } catch {
      return unconfirmed("lookup_unavailable")
    }
    if (!native) return unconfirmed("not_found")
    let current: SparkCheckoutReceiveRequest
    try {
      current = mapNativeCheckoutReceive({
        native,
        walletId: input.walletId,
        network: input.network,
        requiredNetSats: expected.requiredNetSats,
        grossFundingSats: expected.grossFundingSats,
        expirySecs: expected.expirySecs,
      })
      assertSameCheckoutReceiveRequest(expected, current)
    } catch {
      return unconfirmed("conflicting_evidence")
    }
    if (current.providerStatus !== "TRANSFER_COMPLETED") {
      return unconfirmed("not_completed")
    }
    return { status: "completed", observedAt: observedAt() }
  }

  const client: SparkSdkClient = {
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
      disconnected = true
      listeners.clear()
      const results = await Promise.allSettled([
        input.wallet.cleanup(),
        ...[...retirementSessions].map((session) => session.cleanup()),
      ])
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      )
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          "Spark wallet and retirement readers could not be closed."
        )
    },
    async getInfo() {
      const funds = await readFundsState()
      return {
        balanceSats: funds.availableSats,
      }
    },
    getFundsState: readFundsState,
    openCheckoutRetirementReader,
    createCheckoutReceive,
    reconcileCheckoutReceive,
    attestCheckoutReceiveCredit,
    attestCheckoutReceiveHistory,
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
          ? { transferId: input.module.parseTransferId(request.idempotencyKey) }
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
    async reconcileLightningSend(request) {
      const approvedAmountMsats = request.amountSats * 1_000
      if (
        !Number.isSafeInteger(request.amountSats) ||
        request.amountSats <= 0 ||
        !Number.isSafeInteger(approvedAmountMsats)
      ) {
        throw new Error("The approved Lightning amount is invalid.")
      }
      if (!Number.isSafeInteger(request.maxFeeSats) || request.maxFeeSats < 0) {
        throw new Error("The approved Lightning fee limit is invalid.")
      }
      const transferId = input.module
        .parseTransferId(request.transferId)
        .toString()
      const paymentHash = decodeLightningInvoicePaymentHash(
        request.paymentRequest
      )
      if (!paymentHash) {
        throw new Error(
          "The Lightning invoice does not contain a valid payment hash."
        )
      }
      if (isAmountlessLightningInvoice(request.paymentRequest)) {
        return {
          status: "conflicting_evidence",
          reason:
            "Spark cannot safely reconcile an amountless Lightning invoice.",
        }
      }
      const decodedAmount = decodeLightningInvoiceAmount(request.paymentRequest)
      if (decodedAmount.msats !== approvedAmountMsats) {
        return {
          status: "conflicting_evidence",
          reason:
            "The persisted Lightning invoice does not match the approved amount.",
        }
      }

      let transfer: SparkNativeSspTransfer | undefined
      try {
        transfer = await input.wallet.getTransferFromSsp(transferId)
      } catch {
        return { status: "lookup_unavailable" }
      }
      if (!transfer) return { status: "not_found" }
      if (transfer.sparkId !== transferId) {
        return {
          status: "conflicting_evidence",
          reason: "Spark returned a conflicting transfer identity.",
        }
      }

      if (transfer.userRequest === undefined || transfer.userRequest === null) {
        return { status: "lookup_unavailable" }
      }

      let recovered: ReturnType<typeof readExactSparkLightningRecoveredTransfer>
      try {
        recovered = readExactSparkLightningRecoveredTransfer({
          transferId,
          paymentRequest: request.paymentRequest,
          transfer,
        })
      } catch (error) {
        return {
          status: "conflicting_evidence",
          reason:
            error instanceof Error &&
            EXACT_LIGHTNING_TRANSFER_CONFLICT_MESSAGES.has(error.message)
              ? error.message
              : "Spark returned invalid Lightning recovery evidence.",
        }
      }

      try {
        const recoveredRequestId = recovered.request.id
        let verifiedTransferTotalSats: number | null = null
        const payment = await reconcileLightningPayment({
          wallet: input.wallet,
          initial: recovered.request,
          maxFeeSats: request.maxFeeSats,
          expectedPaymentHash: decodeHex32(
            paymentHash,
            "The Lightning invoice contains an invalid payment hash."
          ).bytes,
          validateRequest: (nativeRequest) => {
            verifiedTransferTotalSats = verifyExactSparkLightningRequestDebit({
              requestId: recoveredRequestId,
              totalAmount: recovered.totalAmount,
              amountSats: request.amountSats,
              maxFeeSats: request.maxFeeSats,
              request: nativeRequest,
            })
          },
          timeoutSecs: request.completionTimeoutSecs ?? 60,
          pollIntervalMs: input.pollIntervalMs,
          wait: input.wait,
          now: input.now,
        })
        if (verifiedTransferTotalSats === null) {
          throw new Error(
            "Spark returned a conflicting Lightning transfer total."
          )
        }
        return { status: "resolved", payment, verifiedTransferTotalSats }
      } catch (error) {
        if (error instanceof SparkLightningLookupUnavailableError) {
          return { status: "lookup_unavailable" }
        }
        const reason =
          error instanceof Error &&
          LIGHTNING_RECOVERY_CONFLICT_MESSAGES.has(error.message)
            ? error.message
            : "Spark returned conflicting Lightning payment evidence."
        return { status: "conflicting_evidence", reason }
      }
    },
    async sendCheckoutLightningObligation(request) {
      validateFrozenCheckoutLightningSend(request, input.network)
      const transferId = input.module.parseTransferId(request.transferId)

      // Another origin may have sent this exact leg already. Never issue a new
      // provider send when exact history is paid, pending, unavailable, or in
      // conflict; only an initial successful empty query may reach the send.
      const prior = await client.reconcileLightningSend!(request)
      if (prior.status !== "not_found") {
        return resolvedCheckoutResult(prior)
      }

      const feePreflight =
        await client.preflightCheckoutLightningObligation!(request)
      if (feePreflight !== "ready") {
        return {
          status: "not_sent",
          reason:
            feePreflight === "fee_over_cap"
              ? "fee_over_cap"
              : "fee_unavailable",
        }
      }

      // History and fee reads can outlive the shopper's signer, order, or
      // takeover authority. Recheck after both awaits, at the last app-owned
      // boundary before the SDK may move funds.
      await request.assertBeforeSend?.()
      // The adapter's own history, fee and authority awaits may outlive the
      // runner's earlier expiry check. This rejection is before SDK admission;
      // an expiry error after admission must still remain possibly sent.
      if (
        !hasCheckoutSparkProviderSendWindow({
          paymentRequest: request.paymentRequest,
          nowMs: input.now(),
        })
      ) {
        return { status: "not_sent", reason: "invoice_expired" }
      }

      // The first-party SDK re-estimates the fee and rejects if this fixed
      // maximum no longer covers it. Never substitute a new fee or transfer ID.
      let initial: SparkNativeLightningSendRequest | SparkNativeTransfer
      try {
        initial = await input.wallet.payLightningInvoice({
          invoice: request.paymentRequest,
          maxFeeSats: request.maxFeeSats,
          preferSpark: false,
          transferId,
        })
      } catch (error) {
        // In pinned Spark SDK 0.11.0, this exact validation happens before
        // selectLeavesAndExecute. All other SDK errors may follow a send.
        if (input.module.isPreSendFeeCapError(error)) {
          return { status: "not_sent", reason: "fee_over_cap" }
        }
        throw error
      }
      if (isNativeTransfer(initial)) return { status: "ambiguous" }

      // The immediate send response is not independent settlement proof. An
      // unavailable or lagging exact-history lookup remains ambiguous.
      return resolvedCheckoutResult(
        await client.reconcileLightningSend!(request)
      )
    },
    async preflightCheckoutLightningObligation(request) {
      validateFrozenCheckoutLightningSend(request, input.network)
      input.module.parseTransferId(request.transferId)
      let estimatedFeeSats: number
      try {
        estimatedFeeSats = await input.wallet.getLightningSendFeeEstimate({
          encodedInvoice: request.paymentRequest,
        })
      } catch {
        return "unavailable"
      }
      // A zero-sat estimate is valid in Spark SDK 0.11.0; only malformed or
      // negative estimates prevent a safe comparison with the frozen cap.
      if (!Number.isSafeInteger(estimatedFeeSats) || estimatedFeeSats < 0) {
        return "unavailable"
      }
      return estimatedFeeSats > request.maxFeeSats ? "fee_over_cap" : "ready"
    },
    async estimateCheckoutLightningFee(request) {
      validateCheckoutLightningFeeEstimate(request, {
        walletId: input.walletId,
        network: input.network,
        nowMs: input.now(),
      })
      const estimatedFeeSats = await input.wallet.getLightningSendFeeEstimate({
        encodedInvoice: request.paymentRequest,
      })
      validateCheckoutLightningFeeEstimate(request, {
        walletId: input.walletId,
        network: input.network,
        nowMs: input.now(),
      })
      if (!Number.isSafeInteger(estimatedFeeSats) || estimatedFeeSats < 0) {
        throw new Error("Spark returned an invalid Lightning fee estimate.")
      }
      return estimatedFeeSats
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
  return client
}

function validateFrozenCheckoutLightningSend(
  request: SparkCheckoutLightningObligationInput,
  network: SparkNativeNetwork
): void {
  const invoice = canonicalLightningInvoice(request.paymentRequest)
  if (
    request.network !== fromNativeNetwork(network) ||
    !invoice ||
    isAmountlessLightningInvoice(invoice) ||
    getLightningInvoiceNetwork(invoice) !== request.network ||
    !decodeLightningInvoicePaymentHash(invoice) ||
    !Number.isSafeInteger(request.amountSats) ||
    request.amountSats <= 0 ||
    !Number.isSafeInteger(request.amountSats * 1_000) ||
    decodeLightningInvoiceAmount(invoice).msats !==
      request.amountSats * 1_000 ||
    !Number.isSafeInteger(request.maxFeeSats) ||
    request.maxFeeSats < 0
  ) {
    throw new Error("The frozen checkout Lightning leg is invalid.")
  }
}

function validateCheckoutLightningFeeEstimate(
  request: SparkCheckoutLightningFeeEstimateInput,
  context: {
    walletId: string
    network: SparkNativeNetwork
    nowMs: number
  }
): void {
  const invoice = canonicalLightningInvoice(request.paymentRequest)
  const metadata = invoice ? decodeLightningInvoiceMetadata(invoice) : null
  if (
    request.walletId !== context.walletId ||
    request.network !== fromNativeNetwork(context.network) ||
    !invoice ||
    invoice !== request.paymentRequest ||
    !isValidLightningInvoice(invoice) ||
    getLightningInvoiceNetwork(invoice) !== request.network ||
    !Number.isSafeInteger(request.amountSats) ||
    request.amountSats <= 0 ||
    !Number.isSafeInteger(request.amountSats * 1_000) ||
    metadata?.msats !== request.amountSats * 1_000 ||
    !/^[0-9a-f]{64}$/.test(request.paymentHash) ||
    decodeLightningInvoicePaymentHash(invoice) !== request.paymentHash ||
    !Number.isSafeInteger(context.nowMs) ||
    context.nowMs < 0 ||
    metadata?.expiresAt === null ||
    metadata?.expiresAt === undefined ||
    !Number.isSafeInteger(metadata.expiresAt * 1_000) ||
    metadata.expiresAt * 1_000 <= context.nowMs
  ) {
    throw new Error("The checkout Lightning fee-estimate invoice is invalid.")
  }
}

function resolvedCheckoutResult(
  observation: Awaited<
    ReturnType<NonNullable<SparkSdkClient["reconcileLightningSend"]>>
  >
): Awaited<
  ReturnType<NonNullable<SparkSdkClient["sendCheckoutLightningObligation"]>>
> {
  if (observation.status !== "resolved") return { status: "ambiguous" }
  if (observation.payment.status === "completed") {
    return { status: "paid", payment: observation.payment }
  }
  if (observation.payment.status === "failed") {
    return { status: "terminal_failure", payment: observation.payment }
  }
  return { status: "ambiguous" }
}

function validateCheckoutReceiveTerms(
  request: Pick<
    SparkCheckoutReceiveInput,
    "requiredNetSats" | "grossFundingSats" | "expirySecs"
  >
): void {
  if (
    !Number.isSafeInteger(request.requiredNetSats) ||
    request.requiredNetSats <= 0
  ) {
    throw new Error("Checkout receive net amount must be positive whole sats.")
  }
  if (
    !Number.isSafeInteger(request.grossFundingSats) ||
    request.grossFundingSats < request.requiredNetSats
  ) {
    throw new Error(
      "Checkout receive funding amount must cover the required net sats."
    )
  }
  if (!Number.isSafeInteger(request.expirySecs) || request.expirySecs <= 0) {
    throw new Error("Checkout receive expiry must be a positive whole number.")
  }
}

function validateCheckoutReceiveInput(
  request: SparkCheckoutReceiveInput
): void {
  validateCheckoutReceiveTerms(request)
  if (typeof request.description !== "string") {
    throw new Error("Checkout receive description is invalid.")
  }
  if (
    request.receiveMode !== undefined &&
    request.receiveMode !== "local_unquoted_canary" &&
    request.receiveMode !== "ordinary_settled_v3"
  ) {
    throw new Error("Checkout receive mode is invalid.")
  }
}

function validateCheckoutReceiveRequest(
  request: SparkCheckoutReceiveRequest
): void {
  validateCheckoutReceiveTerms({
    requiredNetSats: request.requiredNetSats,
    grossFundingSats: request.grossFundingSats,
    expirySecs: request.expirySecs,
  })
  if (
    !request.walletId.trim() ||
    !request.id.trim() ||
    !request.providerStatus.trim()
  ) {
    throw new Error("Checkout receive identity is invalid.")
  }
  if (request.network !== "mainnet" && request.network !== "regtest") {
    throw new Error("Checkout receive network is invalid.")
  }
  decodeHex32(request.paymentHash, "Checkout receive payment hash is invalid.")
  if (
    !Number.isSafeInteger(request.createdAt) ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.createdAt < 0 ||
    request.expiresAt <= request.createdAt
  ) {
    throw new Error("Checkout receive timestamps are invalid.")
  }
}

function validateCheckoutHistoricalReceiveTarget(
  target: SparkCheckoutHistoricalReceiveTarget,
  binding: { walletId: string; network: SparkNativeNetwork }
): SparkCheckoutReceiveRequest {
  const expiryMs = target.expiresAt - target.createdAt
  const expirySecs = expiryMs / 1_000
  const expected: SparkCheckoutReceiveRequest = {
    walletId: target.walletId,
    network: target.network,
    id: target.requestId,
    paymentRequest: target.paymentRequest,
    paymentHash: target.paymentHash,
    providerStatus: "HISTORICAL_LOOKUP",
    requiredNetSats: target.requiredNetSats,
    grossFundingSats: target.grossFundingSats,
    expirySecs,
    createdAt: target.createdAt,
    expiresAt: target.expiresAt,
  }
  try {
    validateCheckoutReceiveRequest(expected)
    if (
      target.walletId !== binding.walletId ||
      target.network !== fromNativeNetwork(binding.network) ||
      target.requestId.trim() !== target.requestId ||
      target.paymentRequest.trim() !== target.paymentRequest
    ) {
      throw new Error("Invalid checkout receive binding")
    }
    const invoice = validateLightningReceiveInvoice({
      amountSats: target.grossFundingSats,
      network: binding.network,
      paymentRequest: target.paymentRequest,
    })
    const paymentHash = decodeLightningInvoicePaymentHash(invoice)
    const metadata = decodeLightningInvoiceMetadata(invoice)
    if (
      !paymentHash ||
      target.paymentHash !== paymentHash.toLowerCase() ||
      secondsToMilliseconds(metadata.createdAt, "Invalid creation time") !==
        target.createdAt ||
      secondsToMilliseconds(metadata.expiresAt, "Invalid expiry") !==
        target.expiresAt
    ) {
      throw new Error("Invalid checkout receive invoice")
    }
  } catch {
    throw new Error("Checkout historical receive target is invalid.")
  }
  return expected
}

function mapNativeCheckoutReceive(input: {
  native: SparkNativeLightningReceiveRequest
  walletId: string
  network: SparkNativeNetwork
  requiredNetSats: number
  grossFundingSats: number
  expirySecs: number
  allowSettledShortfall?: boolean
}): SparkCheckoutReceiveRequest {
  const id = input.native.id.trim()
  const providerStatus = input.native.status.trim()
  if (!id || !providerStatus) {
    throw new Error("Spark returned an invalid checkout receive identity.")
  }
  if (
    input.native.network !== input.network ||
    input.native.invoice.bitcoinNetwork !== input.network
  ) {
    throw new Error("Spark returned conflicting checkout network evidence.")
  }
  const paymentRequest = validateLightningReceiveInvoice({
    amountSats: input.grossFundingSats,
    network: input.network,
    paymentRequest: input.native.invoice.encodedInvoice,
  })
  const invoicePaymentHash = decodeLightningInvoicePaymentHash(paymentRequest)
  const paymentHash = decodeHex32(
    invoicePaymentHash ?? "",
    "Spark returned a checkout invoice without a valid payment hash."
  ).hex
  const providerPaymentHash = decodeHex32(
    input.native.invoice.paymentHash,
    "Spark returned an invalid checkout receive payment hash."
  ).hex
  if (providerPaymentHash !== paymentHash) {
    throw new Error("Spark returned conflicting checkout receive identity.")
  }
  if (
    readNativeInvoiceAmountSats(input.native.invoice.amount) !==
    input.grossFundingSats
  ) {
    throw new Error("Spark returned a different checkout funding amount.")
  }
  if (
    providerStatus === "TRANSFER_COMPLETED" &&
    input.native.transfer !== undefined
  ) {
    const transfer = input.native.transfer
    if (
      !transfer ||
      (transfer.userRequestId !== undefined && transfer.userRequestId !== id) ||
      !transfer.totalAmount ||
      (input.allowSettledShortfall
        ? readNativeInvoiceAmountSats(transfer.totalAmount) <= 0 ||
          readNativeInvoiceAmountSats(transfer.totalAmount) >
            input.grossFundingSats
        : readNativeInvoiceAmountSats(transfer.totalAmount) !==
          input.grossFundingSats)
    ) {
      throw new Error(
        "Spark returned conflicting checkout receive transfer evidence."
      )
    }
  }
  const providerCreatedAt = parseNativeTimestamp(
    input.native.invoice.createdAt,
    "Spark returned an invalid checkout receive creation time."
  )
  const providerExpiresAt = parseNativeTimestamp(
    input.native.invoice.expiresAt,
    "Spark returned an invalid checkout receive expiry."
  )
  if (providerExpiresAt <= providerCreatedAt) {
    throw new Error("Spark returned an expired checkout receive interval.")
  }
  const invoiceMetadata = decodeLightningInvoiceMetadata(paymentRequest)
  const invoiceCreatedAt = secondsToMilliseconds(
    invoiceMetadata.createdAt,
    "Spark returned a checkout invoice without a valid creation time."
  )
  const invoiceExpiresAt = secondsToMilliseconds(
    invoiceMetadata.expiresAt,
    "Spark returned a checkout invoice without a valid expiry."
  )
  const createdAt = Math.floor(providerCreatedAt / 1_000) * 1_000
  const expiresAt = Math.floor(providerExpiresAt / 1_000) * 1_000
  if (
    createdAt !== invoiceCreatedAt ||
    expiresAt !== invoiceExpiresAt ||
    expiresAt - createdAt !== input.expirySecs * 1_000
  ) {
    throw new Error("Spark returned conflicting checkout expiry evidence.")
  }
  const network = fromNativeNetwork(input.network)
  if (network !== "mainnet" && network !== "regtest") {
    throw new Error("Spark returned an unsupported checkout network.")
  }
  return {
    walletId: input.walletId,
    network,
    id,
    paymentRequest,
    paymentHash,
    providerStatus,
    requiredNetSats: input.requiredNetSats,
    grossFundingSats: input.grossFundingSats,
    expirySecs: input.expirySecs,
    createdAt,
    expiresAt,
  }
}

function assertSameCheckoutReceiveRequest(
  expected: SparkCheckoutReceiveRequest,
  current: SparkCheckoutReceiveRequest
): void {
  if (
    current.id !== expected.id ||
    current.walletId !== expected.walletId ||
    current.network !== expected.network ||
    current.paymentRequest !== expected.paymentRequest ||
    current.paymentHash !== expected.paymentHash ||
    current.requiredNetSats !== expected.requiredNetSats ||
    current.grossFundingSats !== expected.grossFundingSats ||
    current.expirySecs !== expected.expirySecs ||
    current.createdAt !== expected.createdAt ||
    current.expiresAt !== expected.expiresAt
  ) {
    throw new Error("Spark returned conflicting checkout receive evidence.")
  }
}

function mapCheckoutReceiveState(
  providerStatus: string,
  input: {
    availableSats: number
    requiredNetSats: number
    observedAt: number
    expiresAt: number
  }
): {
  state: SparkCheckoutReceiveReconciliation["state"]
  failureReason: SparkCheckoutReceiveFailureReason | null
} {
  if (providerStatus === "INVOICE_CREATED") {
    return input.observedAt < input.expiresAt
      ? { state: "pending", failureReason: null }
      : {
          state: "unresolved_failure",
          failureReason: "invoice_expired_unresolved",
        }
  }
  if (
    providerStatus === "TRANSFER_CREATED" ||
    providerStatus === "PAYMENT_PREIMAGE_RECOVERED" ||
    providerStatus === "LIGHTNING_PAYMENT_RECEIVED"
  ) {
    return { state: "funded_pending_claim", failureReason: null }
  }
  if (
    providerStatus === "TRANSFER_COMPLETED" &&
    input.availableSats >= input.requiredNetSats
  ) {
    return { state: "spendable", failureReason: null }
  }
  if (providerStatus === "TRANSFER_COMPLETED") {
    return {
      state: "unresolved_failure",
      failureReason: "insufficient_available_funds",
    }
  }
  return {
    state: "unresolved_failure",
    failureReason: "provider_unresolved",
  }
}

function normalizeProviderStatus(value: string): string | null {
  const normalized = value.trim()
  return normalized || null
}

function readNativeInvoiceAmountSats(
  amount: SparkNativeCurrencyAmount
): number {
  if (!Number.isSafeInteger(amount.originalValue) || amount.originalValue < 0) {
    throw new Error("Spark returned an invalid checkout funding amount.")
  }
  const sats =
    amount.originalUnit === "SATOSHI"
      ? amount.originalValue
      : amount.originalUnit === "MILLISATOSHI"
        ? amount.originalValue / 1_000
        : Number.NaN
  if (!Number.isSafeInteger(sats) || sats < 0) {
    throw new Error("Spark returned an invalid checkout funding amount.")
  }
  return sats
}

function parseNativeTimestamp(value: string, message: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(message)
  }
  return timestamp
}

function secondsToMilliseconds(value: number | null, message: string): number {
  if (value === null) throw new Error(message)
  const milliseconds = value * 1_000
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error(message)
  }
  return milliseconds
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
  validateRequest?: (request: SparkNativeLightningSendRequest) => void
  timeoutSecs: number
  pollIntervalMs: number
  wait: (milliseconds: number) => Promise<void>
  now: () => number
}): Promise<SparkSdkPayment> {
  const deadline = input.now() + Math.max(0, input.timeoutSecs) * 1_000
  let request = input.initial

  while (true) {
    input.validateRequest?.(request)
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
    let next: SparkNativeLightningSendRequest | null
    try {
      next = await input.wallet.getLightningSendRequest(request.id)
    } catch {
      throw new SparkLightningLookupUnavailableError()
    }
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

function decodeSparkQuoteHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value) || value.length > 32_768) {
    throw new Error("Spark checkout receive quote is invalid.")
  }
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  )
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

export async function loadFirstPartySparkModule(): Promise<SparkNativeModule> {
  const module = await import("@buildonspark/spark-sdk")
  const { TransferManifest } =
    await import("@buildonspark/spark-sdk/proto/spark")
  const eventNames = Object.values(module.SparkWalletEvent).filter(
    (eventName) => eventName !== module.SparkWalletEvent.All
  )
  return {
    eventNames,
    parseTransferId: (value) => module.UUID.parse(value),
    inspectLightningReceiveQuote({ quote, receiverIdentityPubkey, network }) {
      try {
        // Decode the exact SSP-signed bytes; quote.manifest is only an
        // advisory decoded copy and must not authorize an invoice amount.
        const manifest = TransferManifest.decode(
          decodeSparkQuoteHex(quote.serializedManifest)
        )
        if (
          manifest.network !== module.NetworkToProto[module.Network[network]]
        ) {
          throw new Error("Spark checkout receive quote network changed.")
        }
        const receiver = module.parseCompressedPublicKeyHex(
          receiverIdentityPubkey,
          "receiverIdentityPubkey"
        )
        return {
          grossSats: module.manifestGrossSats(manifest),
          netSats: module.manifestNetSatsFor(manifest, receiver),
          feeSats: module.manifestFeeSats(manifest),
          feeComponents: manifest.fees.length,
          expiresAt: manifest.quoteExpiryTime?.getTime() ?? 0,
        }
      } catch {
        throw new Error("Spark checkout receive quote is invalid.")
      }
    },
    isPreSendFeeCapError(error) {
      return (
        error instanceof module.SparkValidationError &&
        error.getContext().field === "maxFeeSats" &&
        error.message.startsWith("maxFeeSats does not cover fee estimate")
      )
    },
    createPublicReadonlyClient(options) {
      return module.SparkReadonlyClient.createPublic(options)
    },
    decodeSparkAddress: module.decodeSparkAddress,
    getNetworkFromSparkAddress: module.getNetworkFromSparkAddress,
    isValidSparkAddress: module.isValidSparkAddress,
    async initialize(input) {
      const retirementNetwork = input.options.network
      class RetirementReadonlyClient extends module.SparkReadonlyClient {
        async cleanup() {
          try {
            await this.connectionManager.closeConnections()
          } finally {
            await this.logging.close()
          }
        }
      }
      class CheckoutSparkWallet extends module.SparkWallet {
        async openRetirementReader() {
          // Reuse the initialized exact-account signer without retaining or
          // exporting recovery material, and request identity-authenticated data.
          const reader = RetirementReadonlyClient.createWithSigner(
            { log: false, network: retirementNetwork },
            this.config.signer
          )
          return { reader, cleanup: () => reader.cleanup() }
        }
      }
      const { wallet } = await CheckoutSparkWallet.initialize(input)
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
            return {
              balance: balance.balance,
              satsBalance: {
                available: balance.satsBalance.available,
                owned: balance.satsBalance.owned,
                incoming: balance.satsBalance.incoming,
              },
            }
          },
          getTransfers: (limit, offset) => wallet.getTransfers(limit, offset),
          getSparkAddress: () => wallet.getSparkAddress(),
          transfer: (request) => wallet.transfer(request),
          getTransfer: (id) => wallet.getTransfer(id),
          getTransferFromSsp: (id) => wallet.getTransferFromSsp(id),
          getIdentityPublicKey: () => wallet.getIdentityPublicKey(),
          openRetirementReader: () => wallet.openRetirementReader(),
          getLightningReceiveQuote: (request) =>
            wallet.getLightningReceiveQuote({
              ...request,
              amountBasis: module.ReceiveQuoteAmountBasis.NET,
            }),
          createLightningInvoice: (request) =>
            wallet.createLightningInvoice(request),
          getLightningReceiveRequest: (id) =>
            wallet.getLightningReceiveRequest(id),
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
