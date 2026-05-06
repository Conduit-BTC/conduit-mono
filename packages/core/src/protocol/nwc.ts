/**
 * NIP-47 (Nostr Wallet Connect) client.
 *
 * Supports merchant invoice generation (`make_invoice`) and buyer payment
 * (`pay_invoice`) with capability detection (`get_info`).
 *
 * Usage:
 *   const conn = parseNwcUri("nostr+walletconnect://...")
 *
 *   // Merchant: generate an invoice
 *   const bolt11 = await nwcMakeInvoice(conn, { amountMsats: 100_000, description: "Order #123" }, 30_000, "merchant")
 *
 *   // Buyer: probe wallet capabilities
 *   const info = await nwcGetInfo(conn, 10_000, "market")
 *   if (info.methods.includes("pay_invoice")) { ... }
 *
 *   // Buyer: pay an invoice
 *   const result = await nwcPayInvoice(conn, { invoice: "lnbc..." }, 60_000, "market")
 */
import NDK, {
  NDKEvent,
  NDKPrivateKeySigner,
  NDKRelayStatus,
  NDKUser,
  type NDKFilter,
} from "@nostr-dev-kit/ndk"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"

// NIP-47 event kinds
const NWC_REQUEST_KIND = 23194
const NWC_RESPONSE_KIND = 23195

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

/**
 * Parse a nostr+walletconnect:// URI into its components.
 */
export function parseNwcUri(uri: string): NwcConnection {
  // nostr+walletconnect://<walletPubkey>?relay=...&secret=...
  const cleaned = uri.trim()
  if (!cleaned.startsWith("nostr+walletconnect://")) {
    throw new Error("Invalid NWC URI: must start with nostr+walletconnect://")
  }

  const withoutScheme = cleaned.slice("nostr+walletconnect://".length)
  const [walletPubkey, queryString] = withoutScheme.split("?", 2)

  if (!walletPubkey || walletPubkey.length !== 64) {
    throw new Error("Invalid NWC URI: missing or invalid wallet pubkey")
  }

  const params = new URLSearchParams(queryString ?? "")

  const secret = params.get("secret")
  if (!secret || secret.length !== 64) {
    throw new Error("Invalid NWC URI: missing or invalid secret")
  }

  const relays = params.getAll("relay")
  if (relays.length === 0) {
    throw new Error("Invalid NWC URI: at least one relay is required")
  }

  return {
    walletPubkey,
    secret,
    relays,
    lud16: params.get("lud16") ?? undefined,
  }
}

// ─── Shared NDK bootstrapping ─────────────────────────────────────────────────

async function buildNwcNdk(connection: NwcConnection): Promise<{
  ndk: NDK
  signer: NDKPrivateKeySigner
  walletUser: NDKUser
  clientPubkey: string
}> {
  const signer = new NDKPrivateKeySigner(connection.secret)
  const ndk = new NDK({
    explicitRelayUrls: connection.relays,
    signer,
  })

  await ndk.connect(5000)

  const connectedRelays = Array.from(ndk.pool?.relays?.entries() ?? []).filter(
    ([, relay]) => relay.status >= NDKRelayStatus.CONNECTED
  )
  if (connectedRelays.length === 0) {
    throw new Error("Failed to connect to NWC relay(s)")
  }

  const clientPubkey = signer.pubkey
  const walletUser = new NDKUser({ pubkey: connection.walletPubkey })

  return { ndk, signer, walletUser, clientPubkey }
}

function disconnectNwcNdk(ndk: NDK): void {
  try {
    for (const [, relay] of ndk.pool?.relays?.entries() ?? []) {
      relay.disconnect()
    }
  } catch {
    // ignore cleanup errors
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
  const { ndk, signer, walletUser, clientPubkey } =
    await buildNwcNdk(connection)

  try {
    const requestPayload = JSON.stringify({
      method: "make_invoice",
      params: {
        amount: params.amountMsats,
        description: params.description,
        expiry: params.expiry,
      },
    })

    const encrypted = await signer.encrypt(walletUser, requestPayload, "nip44")

    const requestEvent = new NDKEvent(ndk)
    requestEvent.kind = NWC_REQUEST_KIND
    requestEvent.tags = [
      ["p", connection.walletPubkey],
      ["encryption", "nip44_v2"],
    ]
    requestEvent.tags = appendConduitClientTag(requestEvent.tags, clientAppId)
    requestEvent.content = encrypted
    await requestEvent.sign(signer)
    const requestId = requestEvent.id

    const responsePromise = waitForNwcResponse<NwcMakeInvoiceResult>(
      ndk,
      signer,
      walletUser,
      requestId,
      clientPubkey,
      timeoutMs,
      parseMakeInvoiceResult
    )

    await requestEvent.publish()

    return await responsePromise
  } finally {
    disconnectNwcNdk(ndk)
  }
}

function parseMakeInvoiceResult(
  result: Record<string, unknown>
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
  const { ndk, signer, walletUser, clientPubkey } =
    await buildNwcNdk(connection)

  try {
    const requestPayload = JSON.stringify({
      method: "pay_invoice",
      params: {
        invoice: params.invoice,
        ...(params.amountMsats !== undefined && { amount: params.amountMsats }),
      },
    })

    const encrypted = await signer.encrypt(walletUser, requestPayload, "nip44")

    const requestEvent = new NDKEvent(ndk)
    requestEvent.kind = NWC_REQUEST_KIND
    requestEvent.tags = [
      ["p", connection.walletPubkey],
      ["encryption", "nip44_v2"],
    ]
    requestEvent.tags = appendConduitClientTag(requestEvent.tags, clientAppId)
    requestEvent.content = encrypted
    await requestEvent.sign(signer)
    const requestId = requestEvent.id

    const responsePromise = waitForNwcResponse<NwcPayInvoiceResult>(
      ndk,
      signer,
      walletUser,
      requestId,
      clientPubkey,
      timeoutMs,
      parsePayInvoiceResult
    )

    await requestEvent.publish()

    return await responsePromise
  } finally {
    disconnectNwcNdk(ndk)
  }
}

function parsePayInvoiceResult(
  result: Record<string, unknown>
): NwcPayInvoiceResult {
  const preimage = typeof result.preimage === "string" ? result.preimage : ""
  if (!preimage)
    throw new Error("Invalid NWC pay_invoice response: missing preimage")
  return {
    preimage,
    paymentHash:
      typeof result.payment_hash === "string" ? result.payment_hash : undefined,
    feeMsats:
      typeof result.fees_paid === "number" ? result.fees_paid : undefined,
  }
}

// ─── get_info ─────────────────────────────────────────────────────────────────

/**
 * Probe a NWC wallet for supported methods and node metadata.
 *
 * Use this to determine whether a connected wallet supports `pay_invoice`
 * before offering fast checkout. If capability detection fails (e.g. the
 * wallet does not support `get_info`), the caller should fail closed for
 * fast checkout and keep the invoice fallback visible.
 */
export async function nwcGetInfo(
  connection: NwcConnection,
  timeoutMs = 10_000,
  clientAppId: ConduitAppId
): Promise<NwcGetInfoResult> {
  const { ndk, signer, walletUser, clientPubkey } =
    await buildNwcNdk(connection)

  try {
    const requestPayload = JSON.stringify({ method: "get_info", params: {} })

    const encrypted = await signer.encrypt(walletUser, requestPayload, "nip44")

    const requestEvent = new NDKEvent(ndk)
    requestEvent.kind = NWC_REQUEST_KIND
    requestEvent.tags = [
      ["p", connection.walletPubkey],
      ["encryption", "nip44_v2"],
    ]
    requestEvent.tags = appendConduitClientTag(requestEvent.tags, clientAppId)
    requestEvent.content = encrypted
    await requestEvent.sign(signer)
    const requestId = requestEvent.id

    const responsePromise = waitForNwcResponse<NwcGetInfoResult>(
      ndk,
      signer,
      walletUser,
      requestId,
      clientPubkey,
      timeoutMs,
      parseGetInfoResult
    )

    await requestEvent.publish()

    return await responsePromise
  } finally {
    disconnectNwcNdk(ndk)
  }
}

function parseGetInfoResult(result: Record<string, unknown>): NwcGetInfoResult {
  const methods = Array.isArray(result.methods)
    ? result.methods.filter((m): m is string => typeof m === "string")
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

// ─── Generic response waiter ─────────────────────────────────────────────────

async function waitForNwcResponse<T>(
  ndk: NDK,
  signer: NDKPrivateKeySigner,
  walletUser: NDKUser,
  requestId: string,
  clientPubkey: string,
  timeoutMs: number,
  parseResult: (result: Record<string, unknown>) => T
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const filter: NDKFilter = {
      kinds: [NWC_RESPONSE_KIND],
      "#p": [clientPubkey],
      "#e": [requestId],
      limit: 1,
    }

    const sub = ndk.subscribe(filter, { closeOnEose: false })
    const timer = setTimeout(() => {
      sub.stop()
      reject(new Error("NWC request timed out"))
    }, timeoutMs)

    sub.on("event", async (event: NDKEvent) => {
      // Reject responses not authored by the configured wallet (prevents relay-level forgery)
      if (event.pubkey !== walletUser.pubkey) return

      clearTimeout(timer)
      sub?.stop()

      try {
        const decrypted = await signer.decrypt(
          walletUser,
          event.content,
          "nip44"
        )
        const response = JSON.parse(decrypted) as {
          result_type: string
          result?: Record<string, unknown>
          error?: { code: string; message: string }
        }

        if (response.error) {
          reject(
            new Error(
              `NWC error (${response.error.code}): ${response.error.message}`
            )
          )
          return
        }

        if (!response.result) {
          reject(new Error("Invalid NWC response: missing result"))
          return
        }

        resolve(parseResult(response.result))
      } catch (err) {
        reject(
          err instanceof Error ? err : new Error("Failed to parse NWC response")
        )
      }
    })
  })
}
