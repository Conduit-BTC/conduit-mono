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
  /** NWC methods this wallet supports, e.g. ["pay_invoice", "make_invoice", "get_balance"]. */
  methods: string[]
  alias?: string
  color?: string
  pubkey?: string
  network?: string
  blockHeight?: number
}

type NwcClientLike = {
  getInfo(): Promise<Nip47GetInfoResponse>
  makeInvoice(request: Nip47MakeInvoiceRequest): Promise<Nip47Transaction>
  payInvoice(request: Nip47PayInvoiceRequest): Promise<Nip47PayResponse>
  close(): void
}

type NwcClientFactory = (connection: NwcConnection) => NwcClientLike

let testNwcClientFactory: NwcClientFactory | null = null

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
  const client = createNwcClient(connection)

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
  const client = createNwcClient(connection)

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
  const client = createNwcClient(connection)

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

function createNwcClient(connection: NwcConnection): NwcClientLike {
  if (testNwcClientFactory) return testNwcClientFactory(connection)

  const options: NewNWCClientOptions = {
    relayUrls: connection.relays,
    secret: connection.secret,
    walletPubkey: connection.walletPubkey,
    lud16: connection.lud16,
    requireSecret: true,
  }

  return new NWCClient(options)
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
