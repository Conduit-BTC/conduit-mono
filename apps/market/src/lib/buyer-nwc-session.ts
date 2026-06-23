import {
  NWCClient,
  Nip47NetworkError,
  Nip47PublishError,
  Nip47PublishTimeoutError,
  Nip47ReplyTimeoutError,
  Nip47TimeoutError,
  Nip47WalletError,
} from "@getalby/sdk/nwc"
import type {
  NewNWCClientOptions,
  Nip47GetBalanceResponse,
  Nip47GetInfoResponse,
  Nip47PayInvoiceRequest,
  Nip47PayResponse,
} from "@getalby/sdk/nwc"
import {
  decodeLightningInvoiceAmount,
  type ConduitAppId,
  type NwcConnection,
  type NwcGetInfoResult,
} from "@conduit/core"

export type NwcSessionStatus =
  | "disconnected"
  | "warming"
  | "reachable"
  | "unreachable"
  | "unsupported"
  | "error"

export type NwcSessionPaymentPhase = "before_publish" | "after_publish"
export type NwcSessionBalanceStatus =
  | "unchecked"
  | "checking"
  | "available"
  | "unavailable"
  | "error"

export interface NwcSessionBalanceState {
  status: NwcSessionBalanceStatus
  /** Raw wallet-reported millisats. Never persisted. */
  balanceMsats: number | null
  fetchedAt: number | null
  error: string | null
}

export interface NwcSessionSnapshot {
  status: NwcSessionStatus
  connection: NwcConnection | null
  info: NwcGetInfoResult | null
  balance: NwcSessionBalanceState
  lastWarmAt: number | null
  error: string | null
}

export type NwcSessionPaymentResult =
  | {
      status: "paid"
      preimage: string
      paymentHash?: string
      feeMsats?: number
    }
  | {
      status: "pre_publish_failed"
      phase: "before_publish"
      reason: string
    }
  | {
      status: "published_timeout"
      phase: "after_publish"
      reason: string
    }
  | {
      status: "wallet_error"
      phase: "after_publish"
      reason: string
    }

export interface NwcSessionPayInvoiceInput {
  invoice: string
  amountMsats?: number
  timeoutMs: number
  appId: ConduitAppId
  metadata?: Record<string, unknown>
}

type NwcSessionClientLike = {
  getInfo(): Promise<Nip47GetInfoResponse>
  getBalance(): Promise<Nip47GetBalanceResponse>
  payInvoice(request: Nip47PayInvoiceRequest): Promise<Nip47PayResponse>
  close(): void
  pool?: {
    maxWaitForConnection?: number
    ensureRelay?(
      url: string,
      params?: { connectionTimeout?: number }
    ): Promise<unknown>
  }
}

type NwcSessionClientFactory = (
  connection: NwcConnection
) => NwcSessionClientLike
type NwcSessionListener = (snapshot: NwcSessionSnapshot) => void

const NWC_WARM_RELAY_TIMEOUT_MS = 10_000
const NWC_BALANCE_TIMEOUT_MS = 10_000
const NWC_PAYMENT_RELAY_CONNECT_TIMEOUTS_MS = [10_000, 15_000, 20_000] as const

let clientFactory: NwcSessionClientFactory = createSdkNwcClient

export class BuyerNwcSession {
  private connection: NwcConnection | null = null
  private connectionKey: string | null = null
  private client: NwcSessionClientLike | null = null
  private warmPromise: Promise<NwcSessionSnapshot> | null = null
  private listeners = new Set<NwcSessionListener>()
  private snapshot: NwcSessionSnapshot = disconnectedSnapshot()
  private version = 0
  private balanceRefreshVersion = 0

  setConnection(connection: NwcConnection | null): NwcSessionSnapshot {
    const nextKey = connection ? getConnectionKey(connection) : null

    if (this.connectionKey === nextKey) {
      return this.snapshot
    }

    this.resetClient()
    this.warmPromise = null
    this.connection = connection
    this.connectionKey = nextKey
    this.version += 1
    this.balanceRefreshVersion += 1
    this.snapshot = connection
      ? {
          status: "unreachable",
          connection,
          info: null,
          balance: emptyBalanceState(),
          lastWarmAt: null,
          error: null,
        }
      : disconnectedSnapshot()

    this.notify()
    return this.snapshot
  }

  getSnapshot(): NwcSessionSnapshot {
    return this.snapshot
  }

  subscribe(listener: NwcSessionListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => {
      this.listeners.delete(listener)
    }
  }

  warm(): Promise<NwcSessionSnapshot> {
    if (!this.connection) {
      this.snapshot = disconnectedSnapshot()
      return Promise.resolve(this.snapshot)
    }

    if (this.warmPromise) return this.warmPromise

    const connection = this.connection
    const version = this.version
    this.snapshot = {
      ...this.snapshot,
      status: "warming",
      connection,
      error: null,
    }
    this.notify()

    this.warmPromise = this.warmConnection(connection, version).finally(() => {
      if (this.version === version) this.warmPromise = null
    })

    return this.warmPromise
  }

  async payInvoice(
    input: NwcSessionPayInvoiceInput
  ): Promise<NwcSessionPaymentResult> {
    void input.appId

    if (!this.connection) {
      return {
        status: "pre_publish_failed",
        phase: "before_publish",
        reason: "No NWC wallet connection is saved.",
      }
    }

    if (
      this.snapshot.status === "unsupported" &&
      this.snapshot.info &&
      !this.snapshot.info.methods.includes("pay_invoice")
    ) {
      return {
        status: "pre_publish_failed",
        phase: "before_publish",
        reason: "Saved wallet does not support outgoing payments via NWC.",
      }
    }

    const amount = getNwcPayInvoiceAmount(input)
    const preconnectResult = await this.prepareClientForPayment()
    if (!preconnectResult.ok) return preconnectResult.result

    const request: Nip47PayInvoiceRequest = {
      invoice: input.invoice,
      ...(input.metadata !== undefined && { metadata: input.metadata }),
    }
    if (amount !== undefined) request.amount = amount

    try {
      const result = await withTimeout(
        preconnectResult.client.payInvoice(request),
        input.timeoutMs,
        "pay_invoice"
      )
      const preimage =
        typeof result.preimage === "string" ? result.preimage : ""
      if (!preimage) {
        return {
          status: "published_timeout",
          phase: "after_publish",
          reason: "NWC pay_invoice response did not include a payment proof.",
        }
      }

      this.snapshot = {
        ...this.snapshot,
        status: "reachable",
        connection: this.connection,
        error: null,
      }
      this.notify()

      return {
        status: "paid",
        preimage,
        feeMsats:
          typeof result.fees_paid === "number" ? result.fees_paid : undefined,
      }
    } catch (error) {
      const reason = getErrorMessage(error, "NWC payment failed.")
      if (error instanceof Nip47WalletError) {
        return {
          status: "wallet_error",
          phase: "after_publish",
          reason,
        }
      }

      if (isNwcPrePublishError(error)) {
        this.snapshot = {
          ...this.snapshot,
          status: "unreachable",
          connection: this.connection,
          lastWarmAt: Date.now(),
          error: reason,
        }
        this.notify()

        return {
          status: "pre_publish_failed",
          phase: "before_publish",
          reason: "Failed to connect to NWC relay(s).",
        }
      }

      return {
        status: "published_timeout",
        phase: "after_publish",
        reason: isNwcAmbiguousPaymentError(error)
          ? "NWC request timed out."
          : reason,
      }
    }
  }

  close(): void {
    this.client?.close()
    this.client = null
    this.connection = null
    this.connectionKey = null
    this.warmPromise = null
    this.version += 1
    this.balanceRefreshVersion += 1
    this.snapshot = disconnectedSnapshot()
    this.notify()
  }

  async refreshBalance(): Promise<NwcSessionSnapshot> {
    const connection = this.connection
    if (!connection) {
      this.snapshot = disconnectedSnapshot()
      this.notify()
      return this.snapshot
    }

    const info = this.snapshot.info
    if (!info?.methods.includes("get_balance")) {
      this.snapshot = {
        ...this.snapshot,
        balance: unavailableBalanceState(),
      }
      this.notify()
      return this.snapshot
    }

    const version = this.version
    const balanceRefreshVersion = ++this.balanceRefreshVersion
    this.snapshot = {
      ...this.snapshot,
      balance: {
        ...this.snapshot.balance,
        status: "checking",
        error: null,
      },
    }
    this.notify()

    try {
      const client = this.getOrCreateClient(connection)
      await connectNwcRelays(client, connection, NWC_WARM_RELAY_TIMEOUT_MS)
      const result = await withTimeout(
        client.getBalance(),
        NWC_BALANCE_TIMEOUT_MS,
        "get_balance"
      )
      if (
        !this.isCurrentConnection(connection, version) ||
        balanceRefreshVersion !== this.balanceRefreshVersion
      ) {
        return this.snapshot
      }

      this.snapshot = {
        ...this.snapshot,
        balance: {
          status: "available",
          balanceMsats: parseGetBalanceMsats(result),
          fetchedAt: Date.now(),
          error: null,
        },
      }
      this.notify()
    } catch (error) {
      if (
        !this.isCurrentConnection(connection, version) ||
        balanceRefreshVersion !== this.balanceRefreshVersion
      ) {
        return this.snapshot
      }

      this.snapshot = {
        ...this.snapshot,
        balance: {
          ...this.snapshot.balance,
          status: "error",
          error: getErrorMessage(error, "Could not refresh wallet balance."),
        },
      }
      this.notify()
    }

    return this.snapshot
  }

  private async warmConnection(
    connection: NwcConnection,
    version: number
  ): Promise<NwcSessionSnapshot> {
    try {
      const client = this.getOrCreateClient(connection)
      await connectNwcRelays(client, connection, NWC_WARM_RELAY_TIMEOUT_MS)
      const result = await withTimeout(client.getInfo(), 10_000, "get_info")
      const info = parseGetInfoResult(result)
      const status = info.methods.includes("pay_invoice")
        ? "reachable"
        : "unsupported"

      if (!this.isCurrentConnection(connection, version)) return this.snapshot

      this.snapshot = {
        status,
        connection,
        info,
        balance: info.methods.includes("get_balance")
          ? emptyBalanceState()
          : unavailableBalanceState(),
        lastWarmAt: Date.now(),
        error:
          status === "unsupported"
            ? "Saved wallet does not support outgoing payments via NWC."
            : null,
      }
      this.notify()
    } catch (error) {
      if (!this.isCurrentConnection(connection, version)) return this.snapshot

      this.resetClient()
      this.snapshot = {
        status: "unreachable",
        connection,
        info: this.snapshot.info,
        balance: this.snapshot.balance,
        lastWarmAt: Date.now(),
        error: getErrorMessage(
          error,
          "Wallet saved, but its NWC relay is currently unreachable."
        ),
      }
      this.notify()
    }

    return this.snapshot
  }

  private isCurrentConnection(
    connection: NwcConnection,
    version: number
  ): boolean {
    return (
      this.version === version &&
      this.connectionKey === getConnectionKey(connection)
    )
  }

  private async prepareClientForPayment(): Promise<
    | { ok: true; client: NwcSessionClientLike }
    | {
        ok: false
        result: Extract<NwcSessionPaymentResult, { phase: "before_publish" }>
      }
  > {
    const connection = this.connection
    if (!connection) {
      return {
        ok: false,
        result: {
          status: "pre_publish_failed",
          phase: "before_publish",
          reason: "No NWC wallet connection is saved.",
        },
      }
    }

    for (const timeoutMs of NWC_PAYMENT_RELAY_CONNECT_TIMEOUTS_MS) {
      const client = this.getOrCreateClient(connection)
      try {
        await connectNwcRelays(client, connection, timeoutMs)
        return { ok: true, client }
      } catch {
        this.resetClient()
      }
    }

    // The SDK publish path is the source of truth. A browser-side preconnect
    // false negative must not skip a valid NWC payment request.
    return { ok: true, client: this.getOrCreateClient(connection) }
  }

  private getOrCreateClient(connection: NwcConnection): NwcSessionClientLike {
    if (!this.client) this.client = clientFactory(connection)
    return this.client
  }

  private resetClient(): void {
    this.client?.close()
    this.client = null
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot)
  }
}

const buyerNwcSession = new BuyerNwcSession()

export function getBuyerNwcSession(): BuyerNwcSession {
  return buyerNwcSession
}

export async function payInvoiceWithBuyerNwcSession(
  connection: NwcConnection,
  input: NwcSessionPayInvoiceInput
): Promise<NwcSessionPaymentResult> {
  const session = getBuyerNwcSession()
  session.setConnection(connection)
  return session.payInvoice(input)
}

function createSdkNwcClient(connection: NwcConnection): NwcSessionClientLike {
  const options: NewNWCClientOptions = connection.uri
    ? {
        nostrWalletConnectUrl: connection.uri,
        requireSecret: true,
      }
    : {
        relayUrls: connection.relays,
        secret: connection.secret,
        walletPubkey: connection.walletPubkey,
        lud16: connection.lud16,
        requireSecret: true,
      }

  return new NWCClient(options)
}

async function connectNwcRelays(
  client: NwcSessionClientLike,
  connection: NwcConnection,
  timeoutMs: number
): Promise<void> {
  const pool = client.pool
  if (!pool || typeof pool.ensureRelay !== "function") return

  pool.maxWaitForConnection = Math.max(
    pool.maxWaitForConnection ?? 0,
    timeoutMs
  )

  await withTimeout(
    Promise.any(
      connection.relays.map((relay) =>
        pool.ensureRelay!(relay, { connectionTimeout: timeoutMs })
      )
    ),
    timeoutMs + 1_000,
    "relay_connect"
  )
}

function parseGetInfoResult(result: Nip47GetInfoResponse): NwcGetInfoResult {
  const methods = Array.isArray(result.methods)
    ? result.methods.filter((m) => typeof m === "string")
    : []

  return {
    methods,
    alias: typeof result.alias === "string" ? result.alias : undefined,
    color: typeof result.color === "string" ? result.color : undefined,
    pubkey: typeof result.pubkey === "string" ? result.pubkey : undefined,
    network: typeof result.network === "string" ? result.network : undefined,
    blockHeight:
      typeof result.block_height === "number" ? result.block_height : undefined,
  }
}

function parseGetBalanceMsats(result: Nip47GetBalanceResponse): number {
  if (typeof result.balance !== "number" || !Number.isFinite(result.balance)) {
    throw new Error("Invalid NWC get_balance response: missing balance")
  }

  return result.balance
}

function getNwcPayInvoiceAmount(
  input: NwcSessionPayInvoiceInput
): number | undefined {
  if (input.amountMsats === undefined) return undefined

  const decodedAmount = decodeLightningInvoiceAmount(input.invoice)
  if (decodedAmount.msats === null) return input.amountMsats

  if (decodedAmount.msats !== input.amountMsats) {
    throw new Error("Amount in invoice does not match amount in request")
  }

  return undefined
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  method: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`NWC ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function disconnectedSnapshot(): NwcSessionSnapshot {
  return {
    status: "disconnected",
    connection: null,
    info: null,
    balance: emptyBalanceState(),
    lastWarmAt: null,
    error: null,
  }
}

function emptyBalanceState(): NwcSessionBalanceState {
  return {
    status: "unchecked",
    balanceMsats: null,
    fetchedAt: null,
    error: null,
  }
}

function unavailableBalanceState(): NwcSessionBalanceState {
  return {
    status: "unavailable",
    balanceMsats: null,
    fetchedAt: null,
    error: null,
  }
}

function getConnectionKey(connection: NwcConnection): string {
  return JSON.stringify({
    walletPubkey: connection.walletPubkey,
    relays: connection.relays,
    secret: connection.secret,
  })
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

function getErrorConstructorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null
  const constructor = (error as { constructor?: { name?: unknown } })
    .constructor
  return typeof constructor?.name === "string" ? constructor.name : null
}

function isNwcPrePublishError(error: unknown): boolean {
  const name = getErrorConstructorName(error)
  return (
    error instanceof Nip47NetworkError ||
    error instanceof Nip47PublishError ||
    error instanceof Nip47PublishTimeoutError ||
    name === "Nip47NetworkError" ||
    name === "Nip47PublishError" ||
    name === "Nip47PublishTimeoutError"
  )
}

function isNwcAmbiguousPaymentError(error: unknown): boolean {
  const name = getErrorConstructorName(error)
  return (
    error instanceof Nip47TimeoutError ||
    error instanceof Nip47ReplyTimeoutError ||
    name === "Nip47TimeoutError" ||
    name === "Nip47ReplyTimeoutError"
  )
}

export const __buyerNwcSessionTestInternals = {
  __setClientFactory(factory: NwcSessionClientFactory | null): void {
    clientFactory = factory ?? createSdkNwcClient
  },
}
