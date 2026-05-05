import { config } from "../config"

// ─── LNURL / Zap helpers ──────────────────────────────────────────────────────

export interface LnurlPayMetadata {
  callback: string
  minSendable: number
  maxSendable: number
  tag: string
  /** Whether the LNURL endpoint declares `allowsNostr: true`. */
  allowsNostr: boolean
  /** Hex pubkey the endpoint wants zap receipts published to. */
  nostrPubkey?: string
  /** Raw metadata array from the endpoint. */
  metadata: string
}

/**
 * Resolve an lud16 address (user@domain) to an LNURL pay metadata object.
 *
 * Throws if the address is malformed, the endpoint is unreachable, or the
 * response is not a valid LNURL-pay response.
 */
export async function fetchLnurlPayMetadata(lud16: string): Promise<LnurlPayMetadata> {
  const trimmed = lud16.trim().toLowerCase()
  const atIndex = trimmed.indexOf("@")
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    throw new Error(`Invalid lud16 address: ${lud16}`)
  }
  const user = trimmed.slice(0, atIndex)
  const domain = trimmed.slice(atIndex + 1)
  const url = `https://${domain}/.well-known/lnurlp/${user}`

  let data: Record<string, unknown>
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`LNURL endpoint returned ${res.status}`)
    data = (await res.json()) as Record<string, unknown>
  } catch (e) {
    throw new Error(
      `Failed to reach LNURL endpoint for ${lud16}: ${e instanceof Error ? e.message : "network error"}`
    )
  }

  if (data.tag !== "payRequest") {
    throw new Error(`Not a LNURL-pay endpoint (tag=${String(data.tag)})`)
  }

  const callback = typeof data.callback === "string" ? data.callback : ""
  const minSendable = typeof data.minSendable === "number" ? data.minSendable : 0
  const maxSendable = typeof data.maxSendable === "number" ? data.maxSendable : 0
  if (!callback) throw new Error("LNURL-pay response missing callback")

  return {
    callback,
    minSendable,
    maxSendable,
    tag: "payRequest",
    allowsNostr: data.allowsNostr === true,
    nostrPubkey: typeof data.nostrPubkey === "string" ? data.nostrPubkey : undefined,
    metadata: typeof data.metadata === "string" ? data.metadata : "[]",
  }
}

export interface ZapRequestParams {
  /** Recipient pubkey (merchant). */
  recipientPubkey: string
  /** Amount in millisatoshis. */
  amountMsats: number
  /** LNURL callback URL (from the LNURL-pay metadata). */
  lnurlCallback: string
  /** Optional order ID appended to the zap relays list. */
  orderId?: string
  /** Optional human-readable comment. */
  comment?: string
  /** Relays to include in the zap request (kind 9734). */
  relays?: string[]
}

export interface FetchZapInvoiceResult {
  /** BOLT11 invoice returned by the LNURL callback. */
  invoice: string
}

/**
 * Fetch a zap invoice by calling the LNURL-pay callback with a NIP-57 zap
 * request event attached.
 *
 * The caller must sign the kind-9734 zap request before calling this function.
 * Pass the signed event as a JSON string in `zapRequestJson`.
 *
 * @param lnurlCallback - The callback URL from the merchant's LNURL-pay metadata.
 * @param amountMsats   - Amount to request in millisatoshis.
 * @param zapRequestJson - Signed kind-9734 event (serialised JSON).
 * @returns The BOLT11 invoice string.
 */
export async function fetchZapInvoice(
  lnurlCallback: string,
  amountMsats: number,
  zapRequestJson: string
): Promise<FetchZapInvoiceResult> {
  const url = new URL(lnurlCallback)
  url.searchParams.set("amount", String(amountMsats))
  url.searchParams.set("nostr", zapRequestJson)

  let data: Record<string, unknown>
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`LNURL callback returned ${res.status}`)
    data = (await res.json()) as Record<string, unknown>
  } catch (e) {
    throw new Error(
      `Failed to fetch zap invoice: ${e instanceof Error ? e.message : "network error"}`
    )
  }

  if (data.status === "ERROR") {
    const reason = typeof data.reason === "string" ? data.reason : "unknown LNURL error"
    throw new Error(`LNURL error: ${reason}`)
  }

  const invoice = typeof data.pr === "string" ? data.pr : ""
  if (!invoice) throw new Error("LNURL callback did not return a BOLT11 invoice")

  return { invoice }
}

export type LightningInvoiceNetwork =
  | "mainnet"
  | "testnet"
  | "signet"
  | "regtest"
  | "unknown"

export type DecodedLightningInvoiceAmount = {
  msats: number | null
  sats: number | null
  currency: "SATS" | "MSATS" | null
}

const SATS_PER_BTC = 100_000_000
const MSATS_PER_BTC = 100_000_000_000
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function normalizeCurrencyCode(currency: string): string {
  return currency.trim().toUpperCase()
}

export function isSatsCurrency(currency: string): boolean {
  const normalized = normalizeCurrencyCode(currency)
  return normalized === "SAT" || normalized === "SATS"
}

export function isUsdCurrency(currency: string): boolean {
  return normalizeCurrencyCode(currency) === "USD"
}

export function convertCommerceAmountToSats(
  amount: number,
  currency: string,
  btcUsdRate: number | null
): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null

  if (isSatsCurrency(currency)) {
    return Math.round(amount)
  }

  if (isUsdCurrency(currency)) {
    if (!btcUsdRate || !Number.isFinite(btcUsdRate) || btcUsdRate <= 0) return null
    return Math.round((amount / btcUsdRate) * SATS_PER_BTC)
  }

  return null
}

export function normalizeLightningInvoice(invoice: string): string {
  return invoice.trim().replace(/^lightning:/i, "")
}

function bech32Polymod(values: number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index += 1) {
      if ((top >> index) & 1) {
        chk ^= BECH32_GENERATORS[index]!
      }
    }
  }
  return chk
}

function bech32HrpExpand(hrp: string): number[] {
  const values: number[] = []
  for (let index = 0; index < hrp.length; index += 1) {
    values.push(hrp.charCodeAt(index) >> 5)
  }
  values.push(0)
  for (let index = 0; index < hrp.length; index += 1) {
    values.push(hrp.charCodeAt(index) & 31)
  }
  return values
}

function isValidBech32Invoice(invoice: string): boolean {
  if (!invoice || invoice !== invoice.toLowerCase()) return false

  const separatorIndex = invoice.lastIndexOf("1")
  if (separatorIndex <= 0 || separatorIndex + 7 > invoice.length) return false

  const hrp = invoice.slice(0, separatorIndex)
  const dataPart = invoice.slice(separatorIndex + 1)
  const values: number[] = []

  for (const char of dataPart) {
    const value = BECH32_CHARSET.indexOf(char)
    if (value === -1) return false
    values.push(value)
  }

  return bech32Polymod([...bech32HrpExpand(hrp), ...values]) === 1
}

export function getLightningInvoiceNetwork(invoice: string): LightningInvoiceNetwork {
  const normalized = normalizeLightningInvoice(invoice).toLowerCase()

  if (normalized.startsWith("lnbc")) return "mainnet"
  if (normalized.startsWith("lnbcrt")) return "regtest"
  if (normalized.startsWith("lnsb")) return "signet"
  if (normalized.startsWith("lntb")) return "testnet"

  return "unknown"
}

export function getExpectedLightningNetworks(): LightningInvoiceNetwork[] {
  if (config.lightningNetwork === "mock") return ["regtest"]
  if (config.lightningNetwork === "mainnet") return ["mainnet"]
  if (config.lightningNetwork === "signet") return ["signet", "testnet"]
  if (config.lightningNetwork === "testnet") return ["testnet", "signet"]
  return []
}

export function isInvoiceCompatibleWithCurrentNetwork(invoice: string): boolean {
  const expected = getExpectedLightningNetworks()
  const actual = getLightningInvoiceNetwork(invoice)
  return expected.includes(actual)
}

export function getLightningNetworkMismatchMessage(invoice: string): string | null {
  const actual = getLightningInvoiceNetwork(invoice)
  if (actual === "unknown") {
    return "This invoice format could not be verified against the current Lightning network."
  }

  const expected = getExpectedLightningNetworks()
  if (expected.includes(actual)) return null

  const expectedLabel =
    config.lightningNetwork === "mock"
      ? "mock/regtest"
      : config.lightningNetwork === "signet"
        ? "signet/testnet"
        : config.lightningNetwork

  return `This invoice is for ${actual}, but Conduit is currently running in ${expectedLabel} mode.`
}

export function decodeLightningInvoiceAmount(invoice: string): DecodedLightningInvoiceAmount {
  const normalized = normalizeLightningInvoice(invoice).toLowerCase()
  if (!isValidBech32Invoice(normalized)) {
    return { msats: null, sats: null, currency: null }
  }
  const match = normalized.match(/^ln(?:bc|tb|sb|bcrt)(\d+)?([munp]?)1/)

  if (!match) {
    return { msats: null, sats: null, currency: null }
  }

  const [, rawAmount, rawUnit] = match
  if (!rawAmount) {
    return { msats: null, sats: null, currency: null }
  }

  try {
    const amount = BigInt(rawAmount)
    let msatsBig: bigint

    switch (rawUnit) {
      case "":
        msatsBig = amount * BigInt(MSATS_PER_BTC)
        break
      case "m":
        msatsBig = amount * 100_000_000n
        break
      case "u":
        msatsBig = amount * 100_000n
        break
      case "n":
        msatsBig = amount * 100n
        break
      case "p":
        if (amount % 10n !== 0n) {
          return { msats: null, sats: null, currency: null }
        }
        msatsBig = amount / 10n
        break
      default:
        return { msats: null, sats: null, currency: null }
    }

    if (msatsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { msats: null, sats: null, currency: null }
    }

    const msats = Number(msatsBig)
    if (msats % 1000 === 0) {
      return {
        msats,
        sats: msats / 1000,
        currency: "SATS",
      }
    }

    return {
      msats,
      sats: null,
      currency: "MSATS",
    }
  } catch {
    return { msats: null, sats: null, currency: null }
  }
}
