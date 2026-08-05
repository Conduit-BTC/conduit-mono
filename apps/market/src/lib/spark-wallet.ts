import {
  acquireSparkWalletManagerSessionLease,
  type SparkWalletSessionLease,
} from "./spark-wallet-lease"
import {
  createSparkDirectTransferSafetyStore,
  type SparkDirectTransferSafetyStore,
} from "./spark-direct-transfer-safety"
import { isValidSparkAccountNumber } from "./spark-recovery"

export interface SparkSdkSeed {
  type: "mnemonic"
  mnemonic: string
}

export type SparkWalletNetwork = "mainnet" | "regtest"

export interface SparkPreparedPayment {
  paymentMethod: {
    type: string
    fee?: string
    lightningFeeSats?: number | bigint
    sparkTransferFeeSats?: number | bigint
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
}

export interface SparkSdkFactory {
  readonly network: SparkWalletNetwork
  open(input: {
    walletId: string
    seed: SparkSdkSeed
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
  approveFee?: (quote: SparkInvoicePaymentQuote) => Promise<boolean>
}

export interface SparkInvoicePaymentQuote {
  amountSats: number
  feeSats: number
  totalSats: number
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

export interface SparkDirectTransferQuote {
  id: string
  attemptId: string
  amountSats: number
  feeSats: number
}

export type SparkDirectTransferResult =
  | {
      status: "sent"
      paymentId: string
      feeSats: number
    }
  | {
      status: "failed" | "ambiguous"
      reason: string
    }

export class SparkWalletManager {
  readonly #factory: SparkSdkFactory
  readonly #acquireSessionLease: SparkWalletSessionLeaseAcquirer
  readonly #directTransferSafety: SparkDirectTransferSafetyStore
  readonly #clients = new Map<string, SparkSdkClient>()
  readonly #sessionLeases = new Map<string, SparkWalletSessionLease>()
  readonly #directTransferSafetyScopes = new Map<string, string>()
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
  readonly #directTransferQuotes = new Map<
    string,
    {
      walletId: string
      safetyScope: string
      attemptId: string
      prepared: SparkPreparedPayment
    }
  >()
  readonly #directTransferAttempts = new Map<
    string,
    Promise<SparkDirectTransferResult>
  >()

  constructor(
    factory: SparkSdkFactory,
    acquireSessionLease: SparkWalletSessionLeaseAcquirer = acquireSparkWalletManagerSessionLease,
    directTransferSafety: SparkDirectTransferSafetyStore = createSparkDirectTransferSafetyStore()
  ) {
    this.#factory = factory
    this.#acquireSessionLease = acquireSessionLease
    this.#directTransferSafety = directTransferSafety
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
      seed: {
        type: "mnemonic",
        mnemonic: input.mnemonic.trim().toLowerCase().replace(/\s+/g, " "),
      },
    })
  }

  async close(walletId: string): Promise<void> {
    this.#purgeInvoiceAttempts(walletId)
    const client = this.#clients.get(walletId)
    if (!client) {
      this.#directTransferSafetyScopes.delete(walletId)
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
    this.#directTransferSafetyScopes.delete(walletId)
    this.#eventListeners.delete(walletId)
    this.#quarantinedWallets.delete(walletId)
    this.#disconnectedWallets.delete(walletId)
    this.#pendingInvalidations.delete(walletId)
    for (const [quoteId, quote] of this.#directTransferQuotes) {
      if (quote.walletId === walletId) {
        this.#directTransferAttempts.delete(quoteId)
        this.#directTransferQuotes.delete(quoteId)
      }
    }
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

  async listPayments(walletId: string): Promise<SparkPaymentSummary[]> {
    const result = await this.#getClient(walletId).listPayments({
      limit: 50,
      sortAscending: false,
    })
    return result.payments
  }

  async prepareSparkTransfer(
    walletId: string,
    input: { address: string; amountSats: number }
  ): Promise<SparkDirectTransferQuote> {
    const address = input.address.trim()
    if (!address) {
      throw new Error("Enter a Spark address.")
    }
    if (!Number.isSafeInteger(input.amountSats) || input.amountSats <= 0) {
      throw new Error("Enter a whole-number amount greater than zero.")
    }
    const safetyScope = this.#getDirectTransferSafetyScope(walletId)
    if (this.#directTransferSafety.get(safetyScope)) {
      throw new Error(
        "A previous Spark transfer is unresolved. Check this wallet's payment history before clearing its safety lock."
      )
    }

    const prepared = await this.#getClient(walletId).prepareSendPayment({
      paymentRequest: { type: "input", input: address },
      amount: BigInt(input.amountSats),
    })
    if (
      prepared.paymentMethod.type !== "sparkAddress" ||
      typeof prepared.paymentMethod.fee !== "string"
    ) {
      throw new Error("The payment request is not a Spark address.")
    }
    if (prepared.amount !== BigInt(input.amountSats)) {
      throw new Error("Spark prepared a different transfer amount.")
    }
    const feeSats = Number(prepared.paymentMethod.fee)
    if (!Number.isSafeInteger(feeSats) || feeSats < 0) {
      throw new Error("Spark returned an invalid transfer fee.")
    }

    const id = crypto.randomUUID()
    const attemptId = crypto.randomUUID()
    this.#directTransferQuotes.set(id, {
      walletId,
      safetyScope,
      attemptId,
      prepared,
    })
    return {
      id,
      attemptId,
      amountSats: input.amountSats,
      feeSats,
    }
  }

  async confirmSparkTransfer(
    walletId: string,
    quoteId: string
  ): Promise<SparkDirectTransferResult> {
    const existingAttempt = this.#directTransferAttempts.get(quoteId)
    if (existingAttempt) {
      return existingAttempt
    }

    const quote = this.#directTransferQuotes.get(quoteId)
    if (!quote || quote.walletId !== walletId) {
      return {
        status: "failed",
        reason: "This Spark transfer quote is no longer available.",
      }
    }

    const attempt = this.#sendSparkTransfer(walletId, quoteId, quote)
    this.#directTransferAttempts.set(quoteId, attempt)
    const result = await attempt
    if (result.status !== "ambiguous") {
      this.#directTransferAttempts.delete(quoteId)
    }
    return result
  }

  hasUnresolvedSparkTransfer(walletId: string): boolean {
    return (
      this.#directTransferSafety.get(
        this.#getDirectTransferSafetyScope(walletId)
      ) !== null
    )
  }

  acknowledgeUnresolvedSparkTransfer(walletId: string): void {
    this.#directTransferSafety.delete(
      this.#getDirectTransferSafetyScope(walletId)
    )
    for (const [quoteId, quote] of this.#directTransferQuotes) {
      if (quote.walletId === walletId) {
        this.#directTransferAttempts.delete(quoteId)
        this.#directTransferQuotes.delete(quoteId)
      }
    }
  }

  discardSparkTransferQuote(walletId: string, quoteId: string): void {
    const quote = this.#directTransferQuotes.get(quoteId)
    if (
      quote?.walletId === walletId &&
      !this.#directTransferAttempts.has(quoteId)
    ) {
      this.#directTransferQuotes.delete(quoteId)
    }
  }

  async #sendSparkTransfer(
    walletId: string,
    quoteId: string,
    quote: {
      walletId: string
      safetyScope: string
      attemptId: string
      prepared: SparkPreparedPayment
    }
  ): Promise<SparkDirectTransferResult> {
    try {
      if (this.#directTransferSafety.get(quote.safetyScope)) {
        return {
          status: "ambiguous",
          reason:
            "A previous Spark transfer is unresolved. Check payment history before trying again.",
        }
      }
      this.#directTransferSafety.put(quote.safetyScope, {
        attemptId: quote.attemptId,
        createdAt: Date.now(),
      })
    } catch {
      return {
        status: "failed",
        reason:
          "Conduit could not create the local Spark transfer safety lock. Nothing was sent.",
      }
    }

    try {
      const { payment } = await this.#getClient(walletId).sendPayment({
        prepareResponse: quote.prepared,
        options: { type: "sparkAddress" },
        idempotencyKey: quote.attemptId,
      })
      if (payment.status === "completed") {
        this.#clearDirectTransferSafety(quote.safetyScope, quote.attemptId)
        this.#directTransferQuotes.delete(quoteId)
        return {
          status: "sent",
          paymentId: payment.id,
          feeSats: Number(payment.fees),
        }
      }
      if (payment.status === "failed") {
        this.#clearDirectTransferSafety(quote.safetyScope, quote.attemptId)
        this.#directTransferQuotes.delete(quoteId)
        return {
          status: "failed",
          reason: "Spark reported that the transfer failed.",
        }
      }
      return {
        status: "ambiguous",
        reason:
          "Spark transfer is still pending. Check payment history before trying again.",
      }
    } catch {
      return {
        status: "ambiguous",
        reason:
          "Spark transfer status is unknown. Check payment history before trying again.",
      }
    }
  }

  #clearDirectTransferSafety(safetyScope: string, attemptId: string): void {
    const marker = this.#directTransferSafety.get(safetyScope)
    if (marker?.attemptId === attemptId) {
      this.#directTransferSafety.delete(safetyScope)
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

    let prepared: SparkPreparedPayment
    try {
      prepared = await client.prepareSendPayment({
        paymentRequest: { type: "input", input: input.invoice },
        amount: BigInt(amountSats),
      })
      if (prepared.paymentMethod.type !== "bolt11Invoice") {
        return {
          status: "pre_publish_failed",
          reason: "Spark did not recognize the payment request as BOLT11.",
        }
      }
    } catch (error) {
      return {
        status: "pre_publish_failed",
        reason: getErrorMessage(error, "Spark could not prepare the payment."),
      }
    }

    if (prepared.amount !== BigInt(amountSats)) {
      return {
        status: "pre_publish_failed",
        reason: "Spark prepared a different invoice amount.",
      }
    }

    const feeSats = safeBigIntToNumber(prepared.paymentMethod.lightningFeeSats)
    if (feeSats === null) {
      return {
        status: "pre_publish_failed",
        reason: "Spark did not return a valid Lightning fee.",
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
    seed: SparkSdkSeed
    accountNumber: number
  }): Promise<void> {
    await this.close(input.walletId)
    const identityKey = await getSparkWalletIdentityKey(
      input.seed,
      input.accountNumber,
      this.#factory.network
    )
    const directTransferSafetyScope =
      await getSparkDirectTransferSafetyScope(identityKey)
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
      this.#directTransferSafetyScopes.set(
        input.walletId,
        directTransferSafetyScope
      )
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

  #getDirectTransferSafetyScope(walletId: string): string {
    this.#getClient(walletId)
    const safetyScope = this.#directTransferSafetyScopes.get(walletId)
    if (!safetyScope) {
      throw new Error(
        "Spark transfer safety state is unavailable. Direct transfers are disabled."
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
  seed: SparkSdkSeed,
  accountNumber: number,
  network: SparkWalletNetwork
): Promise<string> {
  // This domain-separated digest exists only in memory and Web Locks so two
  // registrations cannot open the same native wallet concurrently. It is
  // never persisted, logged, or emitted as telemetry.
  const encoded = new TextEncoder().encode(
    `conduit:spark-wallet-identity:v2\0${network}\0${accountNumber}\0${seed.type}\0${seed.mnemonic}`
  )
  try {
    const digest = await crypto.subtle.digest("SHA-256", encoded.slice().buffer)
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  } finally {
    encoded.fill(0)
  }
}

async function getSparkDirectTransferSafetyScope(
  identityKey: string
): Promise<string> {
  // A separate domain prevents the Web Locks identity from becoming a storage
  // identifier. This scope is persisted only when a direct transfer is
  // unresolved, so restoring the same Spark identity cannot bypass its local
  // duplicate-send lock. It must never enter logs, telemetry, or wallet
  // descriptors.
  const encoded = new TextEncoder().encode(
    `conduit:spark-direct-transfer-safety-scope:v1\0${identityKey}`
  )
  try {
    const digest = await crypto.subtle.digest("SHA-256", encoded.slice().buffer)
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  } finally {
    encoded.fill(0)
  }
}
