/**
 * NIP-47 (Nostr Wallet Connect) client.
 *
 * Supports merchant invoice generation (`make_invoice`) and buyer payment
 * (`pay_invoice`) with capability detection (`get_info`).
 *
 * NWC is the wallet RPC transport for invoice payment. It is not the zap
 * protocol itself: checkout should fetch/validate a NIP-57 zap invoice first,
 * then use this module to ask the connected wallet to pay that invoice.
 */
import {
  NWCClient,
  Nip47NetworkError,
  Nip47PublishError,
  Nip47PublishTimeoutError,
  Nip47ReplyTimeoutError,
  Nip47TimeoutError,
} from "@getalby/sdk/nwc"
import type {
  NewNWCClientOptions,
  Nip47GetBalanceResponse,
  Nip47GetInfoResponse,
  Nip47MakeInvoiceRequest,
  Nip47PayInvoiceRequest,
  Nip47PayResponse,
  Nip47Transaction,
} from "@getalby/sdk/nwc"

import { decodeLightningInvoiceAmount } from "./lightning"
import type { ConduitAppId } from "./nip89"

export interface NwcConnection {
  walletPubkey: string
  secret: string
  relays: string[]
  lud16?: string
  /** Original private NWC URI, preserved so SDK parsing/normalization matches wallet clients. */
  uri?: string
}

export interface NwcMakeInvoiceParams {
  amountMsats: number
  description?: string
  expiry?: number
}

export interface NwcMakeInvoiceResult {
  invoice: string
  paymentHash: string
  amount: number
  createdAt: number
  expiresAt?: number
}

export interface NwcPayInvoiceParams {
  invoice: string
  /** Optional override amount in msats (for zero-amount invoices). */
  amountMsats?: number
  /** Optional wallet-visible metadata per NIP-47. Must not include private order data. */
  metadata?: Record<string, unknown>
}

export interface NwcPayInvoiceResult {
  preimage: string
  paymentHash?: string
  feeMsats?: number
}

export interface NwcGetInfoResult {
  /** NWC methods this wallet supports, e.g. ["pay_invoice", "get_balance", "get_budget"]. */
  methods: string[]
  /** NWC notification types this wallet supports for this connection. */
  notifications?: string[]
  alias?: string
  color?: string
  pubkey?: string
  network?: string
  blockHeight?: number
}

export interface NwcGetBalanceResult {
  /** Wallet-reported balance in millisats. This is external wallet state. */
  balanceMsats: number
}

type NwcClientLike = {
  getInfo(): Promise<Nip47GetInfoResponse>
  getBalance(): Promise<Nip47GetBalanceResponse>
  makeInvoice(request: Nip47MakeInvoiceRequest): Promise<Nip47Transaction>
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

type NwcClientFactory = (connection: NwcConnection) => NwcClientLike

let testNwcClientFactory: NwcClientFactory | null = null

const NWC_PROBE_RELAY_CONNECT_TIMEOUTS_MS = [10_000] as const
const NWC_PAYMENT_RELAY_CONNECT_TIMEOUTS_MS = [10_000, 15_000, 20_000] as const

/**
 * Parse a nostr+walletconnect:// URI into its components.
 *
 * Delegate URI compatibility to the NWC SDK so Conduit accepts the same
 * modern and legacy NWC URI forms as other web clients.
 */
export function parseNwcUri(uri: string): NwcConnection {
  const parsed = NWCClient.parseWalletConnectUrl(uri.trim(), true)

  return {
    walletPubkey: parsed.walletPubkey,
    secret: parsed.secret ?? "",
    relays: parsed.relayUrls,
    lud16: parsed.lud16,
    uri: uri.trim(),
  }
}

// ─── make_invoice ─────────────────────────────────────────────────────────────

/**
 * Send a NIP-47 `make_invoice` request and wait for the response.
 */
export async function nwcMakeInvoice(
  connection: NwcConnection,
  params: NwcMakeInvoiceParams,
  timeoutMs = 30_000,
  clientAppId: ConduitAppId
): Promise<NwcMakeInvoiceResult> {
  void clientAppId
  const client = await createPreparedNwcClient(connection, "probe")

  try {
    const request: Nip47MakeInvoiceRequest = {
      amount: params.amountMsats,
      description: params.description,
      expiry: params.expiry,
    }
    const result = await withNwcTimeout(
      client.makeInvoice(request),
      timeoutMs,
      "make_invoice"
    )

    return parseMakeInvoiceResult(result)
  } catch (error) {
    throw normalizeNwcError(error)
  } finally {
    client.close()
  }
}

function parseMakeInvoiceResult(
  result: Nip47Transaction
): NwcMakeInvoiceResult {
  const invoice = typeof result.invoice === "string" ? result.invoice : ""
  if (!invoice)
    throw new Error("Invalid NWC make_invoice response: missing invoice")

  return {
    invoice,
    paymentHash:
      typeof result.payment_hash === "string" ? result.payment_hash : "",
    amount: typeof result.amount === "number" ? result.amount : 0,
    createdAt:
      typeof result.created_at === "number"
        ? result.created_at
        : Math.floor(Date.now() / 1000),
    expiresAt:
      typeof result.expires_at === "number" ? result.expires_at : undefined,
  }
}

// ─── pay_invoice ──────────────────────────────────────────────────────────────

/**
 * Send a NIP-47 `pay_invoice` request from the buyer's NWC-connected wallet.
 *
 * This is the buyer-side payment primitive for fast checkout. The NWC
 * credentials are never published or included in order payloads - they are
 * only used locally to authorize the outgoing payment.
 */
export async function nwcPayInvoice(
  connection: NwcConnection,
  params: NwcPayInvoiceParams,
  timeoutMs = 60_000,
  clientAppId: ConduitAppId
): Promise<NwcPayInvoiceResult> {
  void clientAppId
  const client = await createPreparedNwcClient(connection, "payment")

  try {
    const request: Nip47PayInvoiceRequest = {
      invoice: params.invoice,
      ...(params.metadata !== undefined && { metadata: params.metadata }),
    }
    const amount = getNwcPayInvoiceAmount(params)
    if (amount !== undefined) request.amount = amount
    const result = await withNwcTimeout(
      client.payInvoice(request),
      timeoutMs,
      "pay_invoice"
    )

    return parsePayInvoiceResult(result)
  } catch (error) {
    throw normalizeNwcError(error)
  } finally {
    client.close()
  }
}

function getNwcPayInvoiceAmount(
  params: NwcPayInvoiceParams
): number | undefined {
  if (params.amountMsats === undefined) return undefined

  const decodedAmount = decodeLightningInvoiceAmount(params.invoice)
  if (decodedAmount.msats === null) return params.amountMsats

  if (decodedAmount.msats !== params.amountMsats) {
    throw new Error("Amount in invoice does not match amount in request")
  }

  return undefined
}

function parsePayInvoiceResult(result: Nip47PayResponse): NwcPayInvoiceResult {
  const preimage = typeof result.preimage === "string" ? result.preimage : ""
  if (!preimage)
    throw new Error("Invalid NWC pay_invoice response: missing preimage")

  return {
    preimage,
    feeMsats:
      typeof result.fees_paid === "number" ? result.fees_paid : undefined,
  }
}

// ─── get_info ─────────────────────────────────────────────────────────────────

/**
 * Probe a NWC wallet for supported methods and node metadata.
 *
 * Use this to determine whether a connected wallet supports `pay_invoice`
 * before offering one-tap checkout. If capability detection fails, callers can
 * still fetch a Lightning invoice and offer browser/manual payment fallback.
 */
export async function nwcGetInfo(
  connection: NwcConnection,
  timeoutMs = 10_000,
  clientAppId: ConduitAppId
): Promise<NwcGetInfoResult> {
  void clientAppId
  const client = await createPreparedNwcClient(connection, "probe")

  try {
    const result = await withNwcTimeout(client.getInfo(), timeoutMs, "get_info")

    return parseGetInfoResult(result)
  } catch (error) {
    throw normalizeNwcError(error)
  } finally {
    client.close()
  }
}

function parseGetInfoResult(result: Nip47GetInfoResponse): NwcGetInfoResult {
  const methods = Array.isArray(result.methods)
    ? result.methods.filter((m) => typeof m === "string")
    : []
  const notifications = Array.isArray(result.notifications)
    ? result.notifications.filter((n) => typeof n === "string")
    : []

  const parsed: NwcGetInfoResult = {
    methods,
    alias: typeof result.alias === "string" ? result.alias : undefined,
    color: typeof result.color === "string" ? result.color : undefined,
    pubkey: typeof result.pubkey === "string" ? result.pubkey : undefined,
    network: typeof result.network === "string" ? result.network : undefined,
    blockHeight:
      typeof result.block_height === "number" ? result.block_height : undefined,
  }
  if (notifications.length > 0) {
    parsed.notifications = notifications
  }
  return parsed
}

// --- get_balance -------------------------------------------------------------

/**
 * Read the connected NWC wallet's external balance.
 *
 * The returned value is raw millisats from NIP-47. Callers must not persist it
 * or treat it as a Conduit-held account balance.
 */
export async function nwcGetBalance(
  connection: NwcConnection,
  timeoutMs = 10_000,
  clientAppId: ConduitAppId
): Promise<NwcGetBalanceResult> {
  void clientAppId
  const client = await createPreparedNwcClient(connection, "probe")

  try {
    const result = await withNwcTimeout(
      client.getBalance(),
      timeoutMs,
      "get_balance"
    )

    return parseGetBalanceResult(result)
  } catch (error) {
    throw normalizeNwcError(error)
  } finally {
    client.close()
  }
}

function parseGetBalanceResult(
  result: Nip47GetBalanceResponse
): NwcGetBalanceResult {
  if (typeof result.balance !== "number" || !Number.isFinite(result.balance)) {
    throw new Error("Invalid NWC get_balance response: missing balance")
  }

  return {
    balanceMsats: result.balance,
  }
}

function createNwcClient(connection: NwcConnection): NwcClientLike {
  if (testNwcClientFactory) return testNwcClientFactory(connection)

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

async function createPreparedNwcClient(
  connection: NwcConnection,
  mode: "probe" | "payment"
): Promise<NwcClientLike> {
  const timeouts =
    mode === "payment"
      ? NWC_PAYMENT_RELAY_CONNECT_TIMEOUTS_MS
      : NWC_PROBE_RELAY_CONNECT_TIMEOUTS_MS
  let lastError: unknown

  for (const timeoutMs of timeouts) {
    const client = createNwcClient(connection)

    try {
      await connectNwcRelaysBeforeRequest(client, connection, timeoutMs)
      return client
    } catch (error) {
      lastError = error
      client.close()
    }
  }

  throw toNwcRelayConnectionError(lastError)
}

async function connectNwcRelaysBeforeRequest(
  client: NwcClientLike,
  connection: NwcConnection,
  timeoutMs: number
): Promise<void> {
  const pool = client.pool
  if (!pool || typeof pool.ensureRelay !== "function") return

  pool.maxWaitForConnection = Math.max(
    pool.maxWaitForConnection ?? 0,
    timeoutMs
  )

  await withNwcTimeout(
    Promise.any(
      connection.relays.map((relay) =>
        pool.ensureRelay!(relay, { connectionTimeout: timeoutMs })
      )
    ),
    timeoutMs + 1_000,
    "relay_connect"
  )
}

function toNwcRelayConnectionError(error: unknown): Error {
  const detail =
    error instanceof Error &&
    error.message &&
    error.message !== "All promises were rejected"
      ? ` ${error.message}`
      : ""
  return new Error(`Failed to connect to NWC relay(s).${detail}`.trim())
}

async function withNwcTimeout<T>(
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

function normalizeNwcError(error: unknown): Error {
  if (
    error instanceof Nip47NetworkError ||
    error instanceof Nip47PublishError ||
    error instanceof Nip47PublishTimeoutError
  ) {
    return new Error("Failed to connect to NWC relay(s).")
  }

  if (
    error instanceof Nip47TimeoutError ||
    error instanceof Nip47ReplyTimeoutError
  ) {
    return new Error("NWC request timed out.")
  }

  return error instanceof Error ? error : new Error("NWC request failed.")
}

export const __nwcTestInternals = {
  __setNwcClientFactory(factory: NwcClientFactory | null): void {
    testNwcClientFactory = factory
  },
}
