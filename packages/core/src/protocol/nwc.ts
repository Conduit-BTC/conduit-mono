/**
 * Lightweight NIP-47 (Nostr Wallet Connect) client for MVP invoice generation.
 *
 * Usage:
 *   const conn = parseNwcUri("nostr+walletconnect://...")
 *   const bolt11 = await nwcMakeInvoice(conn, { amountMsats: 100_000, description: "Order #123" })
 */
import NDK, { NDKEvent, NDKPrivateKeySigner, NDKRelayStatus, NDKSubscription, NDKUser, type NDKFilter } from "@nostr-dev-kit/ndk"
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

/**
 * Send a NIP-47 `make_invoice` request and wait for the response.
 */
export async function nwcMakeInvoice(
  connection: NwcConnection,
  params: NwcMakeInvoiceParams,
  timeoutMs = 30_000,
  clientAppId: ConduitAppId = "merchant",
): Promise<NwcMakeInvoiceResult> {
  // Create a dedicated NDK instance for this NWC connection
  const signer = new NDKPrivateKeySigner(connection.secret)
  const ndk = new NDK({
    explicitRelayUrls: connection.relays,
    signer,
  })

  await ndk.connect(5000)

  // Verify at least one relay connected
  const connectedRelays = Array.from(ndk.pool?.relays?.entries() ?? [])
    .filter(([, relay]) => relay.status >= NDKRelayStatus.CONNECTED)
  if (connectedRelays.length === 0) {
    throw new Error("Failed to connect to NWC relay(s)")
  }

  const clientPubkey = signer.pubkey
  const walletUser = new NDKUser({ pubkey: connection.walletPubkey })

  try {
    // Build the request payload
    const requestPayload = JSON.stringify({
      method: "make_invoice",
      params: {
        amount: params.amountMsats,
        description: params.description,
        expiry: params.expiry,
      },
    })

    // Encrypt with NIP-44
    const encrypted = await signer.encrypt(walletUser, requestPayload, "nip44")

    // Create and publish the request event
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

    // Subscribe for the response before publishing (to avoid race)
    const responsePromise = waitForNwcResponse(ndk, signer, walletUser, requestId, clientPubkey, timeoutMs)

    await requestEvent.publish()

    return await responsePromise
  } finally {
    // Clean up the dedicated NWC NDK instance
    try {
      for (const [, relay] of ndk.pool?.relays?.entries() ?? []) {
        relay.disconnect()
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

async function waitForNwcResponse(
  ndk: NDK,
  signer: NDKPrivateKeySigner,
  walletUser: NDKUser,
  requestId: string,
  clientPubkey: string,
  timeoutMs: number,
): Promise<NwcMakeInvoiceResult> {
  return new Promise<NwcMakeInvoiceResult>((resolve, reject) => {
    let sub: NDKSubscription | undefined
    const timer = setTimeout(() => {
      sub?.stop()
      reject(new Error("NWC make_invoice timed out"))
    }, timeoutMs)

    const filter: NDKFilter = {
      kinds: [NWC_RESPONSE_KIND],
      "#p": [clientPubkey],
      "#e": [requestId],
      limit: 1,
    }

    sub = ndk.subscribe(filter, { closeOnEose: false })

    sub.on("event", async (event: NDKEvent) => {
      // Reject responses not authored by the configured wallet (prevents relay-level forgery)
      if (event.pubkey !== walletUser.pubkey) return

      clearTimeout(timer)
      sub?.stop()

      try {
        const decrypted = await signer.decrypt(walletUser, event.content, "nip44")
        const response = JSON.parse(decrypted) as {
          result_type: string
          result?: {
            invoice?: string
            payment_hash?: string
            amount?: number
            created_at?: number
            expires_at?: number
          }
          error?: { code: string; message: string }
        }

        if (response.error) {
          reject(new Error(`NWC error (${response.error.code}): ${response.error.message}`))
          return
        }

        if (response.result_type !== "make_invoice" || !response.result?.invoice) {
          reject(new Error("Invalid NWC make_invoice response"))
          return
        }

        resolve({
          invoice: response.result.invoice,
          paymentHash: response.result.payment_hash ?? "",
          amount: response.result.amount ?? 0,
          createdAt: response.result.created_at ?? Math.floor(Date.now() / 1000),
          expiresAt: response.result.expires_at,
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error("Failed to parse NWC response"))
      }
    })
  })
}
