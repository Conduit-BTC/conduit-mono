import type { NDKEvent } from "@nostr-dev-kit/ndk"

import { config } from "../config"
import {
  isSatsLikeCurrency,
  isUsdCurrencyCode,
  normalizeCommercePrice,
  type PricingRateInput,
} from "../pricing"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanout } from "./ndk"

// ─── LNURL / Zap helpers ──────────────────────────────────────────────────────

export interface LnurlPayMetadata {
  /** LNURL-pay endpoint URL resolved from lud16. */
  payRequestUrl: string
  /** Bech32-encoded LNURL-pay endpoint, used in NIP-57 zap requests. */
  lnurl: string
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
export async function fetchLnurlPayMetadata(
  lud16: string
): Promise<LnurlPayMetadata> {
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
  const minSendable =
    typeof data.minSendable === "number" ? data.minSendable : 0
  const maxSendable =
    typeof data.maxSendable === "number" ? data.maxSendable : 0
  if (!callback) throw new Error("LNURL-pay response missing callback")

  return {
    payRequestUrl: url,
    lnurl: encodeLnurl(url),
    callback,
    minSendable,
    maxSendable,
    tag: "payRequest",
    allowsNostr: data.allowsNostr === true,
    nostrPubkey:
      typeof data.nostrPubkey === "string" ? data.nostrPubkey : undefined,
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
  zapRequestJson: string,
  lnurl?: string
): Promise<FetchZapInvoiceResult> {
  const url = new URL(lnurlCallback)
  url.searchParams.set("amount", String(amountMsats))
  url.searchParams.set("nostr", zapRequestJson)
  if (lnurl) url.searchParams.set("lnurl", lnurl)

  let data: Record<string, unknown>
  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`LNURL callback returned ${res.status}`)
    data = (await res.json()) as Record<string, unknown>
  } catch (e) {
    throw new Error(
      `Failed to fetch zap invoice: ${e instanceof Error ? e.message : "network error"}`
    )
  }

  if (data.status === "ERROR") {
    const reason =
      typeof data.reason === "string" ? data.reason : "unknown LNURL error"
    throw new Error(`LNURL error: ${reason}`)
  }

  const invoice = typeof data.pr === "string" ? data.pr : ""
  if (!invoice)
    throw new Error("LNURL callback did not return a BOLT11 invoice")

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

const MSATS_PER_BTC = 100_000_000_000
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
]

export function isSatsCurrency(currency: string): boolean {
  return isSatsLikeCurrency(currency)
}

export function isUsdCurrency(currency: string): boolean {
  return isUsdCurrencyCode(currency)
}

export function convertCommerceAmountToSats(
  amount: number,
  currency: string,
  rateInput: PricingRateInput
): number | null {
  const normalized = normalizeCommercePrice(amount, currency, rateInput)
  return normalized.status === "ok" ? normalized.sats : null
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

function toWords(bytes: Uint8Array): number[] {
  const words: number[] = []
  let value = 0
  let bits = 0

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      words.push((value >> (bits - 5)) & 31)
      bits -= 5
    }
  }

  if (bits > 0) {
    words.push((value << (5 - bits)) & 31)
  }

  return words
}

function createBech32Checksum(hrp: string, words: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]
  const polymod = bech32Polymod(values) ^ 1
  const checksum: number[] = []
  for (let index = 0; index < 6; index += 1) {
    checksum.push((polymod >> (5 * (5 - index))) & 31)
  }
  return checksum
}

export function encodeLnurl(url: string): string {
  const words = toWords(new TextEncoder().encode(url))
  const checksum = createBech32Checksum("lnurl", words)
  return `lnurl${[...words, ...checksum]
    .map((word) => BECH32_CHARSET[word]!)
    .join("")}`
}

export function getLightningInvoiceNetwork(
  invoice: string
): LightningInvoiceNetwork {
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

export function isInvoiceCompatibleWithCurrentNetwork(
  invoice: string
): boolean {
  const expected = getExpectedLightningNetworks()
  const actual = getLightningInvoiceNetwork(invoice)
  return expected.includes(actual)
}

export function getLightningNetworkMismatchMessage(
  invoice: string
): string | null {
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

export function decodeLightningInvoiceAmount(
  invoice: string
): DecodedLightningInvoiceAmount {
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

export type LightningInvoiceMetadata = DecodedLightningInvoiceAmount & {
  createdAt: number | null
  expiresAt: number | null
}

function decodeTaggedData(values: number[]): Map<string, number[]> {
  const tags = new Map<string, number[]>()
  let index = 7
  const checksumWordCount = 6
  const end = values.length - checksumWordCount

  while (index + 3 <= end) {
    const tag = BECH32_CHARSET[values[index]!]
    const length = (values[index + 1]! << 5) + values[index + 2]!
    const start = index + 3
    const stop = start + length
    if (!tag || stop > end) break
    tags.set(tag, values.slice(start, stop))
    index = stop
  }

  return tags
}

function wordsToBigInt(words: number[]): bigint {
  return words.reduce((acc, word) => (acc << 5n) + BigInt(word), 0n)
}

export function decodeLightningInvoiceMetadata(
  invoice: string
): LightningInvoiceMetadata {
  const amount = decodeLightningInvoiceAmount(invoice)
  const normalized = normalizeLightningInvoice(invoice).toLowerCase()
  if (!isValidBech32Invoice(normalized)) {
    return { ...amount, createdAt: null, expiresAt: null }
  }

  const separatorIndex = normalized.lastIndexOf("1")
  const dataPart = normalized.slice(separatorIndex + 1)
  const values = Array.from(dataPart, (char) => BECH32_CHARSET.indexOf(char))
  if (values.some((value) => value < 0) || values.length < 13) {
    return { ...amount, createdAt: null, expiresAt: null }
  }

  const createdAtBig = wordsToBigInt(values.slice(0, 7))
  const createdAt =
    createdAtBig <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(createdAtBig)
      : null

  const expiryWords = decodeTaggedData(values).get("x")
  let expiresAt: number | null = null
  if (createdAt !== null) {
    const expirySeconds = expiryWords
      ? Number(wordsToBigInt(expiryWords))
      : 3600
    expiresAt = Number.isSafeInteger(expirySeconds)
      ? createdAt + expirySeconds
      : null
  }

  return { ...amount, createdAt, expiresAt }
}

export type LightningInvoiceValidation =
  | { ok: true; metadata: LightningInvoiceMetadata }
  | { ok: false; reason: string; metadata: LightningInvoiceMetadata }

export function validateLightningInvoiceForPayment({
  invoice,
  expectedAmountMsats,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  invoice: string
  expectedAmountMsats: number
  nowSeconds?: number
}): LightningInvoiceValidation {
  const metadata = decodeLightningInvoiceMetadata(invoice)

  if (!isInvoiceCompatibleWithCurrentNetwork(invoice)) {
    return {
      ok: false,
      reason:
        getLightningNetworkMismatchMessage(invoice) ??
        "The invoice returned by the merchant is for a different Lightning network.",
      metadata,
    }
  }

  if (metadata.msats === null) {
    return {
      ok: false,
      reason: "The invoice returned by the merchant does not encode an amount.",
      metadata,
    }
  }

  if (metadata.msats !== expectedAmountMsats) {
    return {
      ok: false,
      reason: "The invoice amount does not match this order total.",
      metadata,
    }
  }

  if (metadata.expiresAt !== null && metadata.expiresAt <= nowSeconds) {
    return {
      ok: false,
      reason: "The invoice returned by the merchant is already expired.",
      metadata,
    }
  }

  return { ok: true, metadata }
}

function getTagValue(tags: string[][], name: string): string | null {
  return tags.find((tag) => tag[0] === name)?.[1] ?? null
}

function parseZapDescription(
  description: string
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(description) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function validateZapReceiptEvent({
  event,
  zapRequestId,
  expectedAmountMsats,
  expectedLnurl,
  lnurlNostrPubkey,
}: {
  event: Pick<NDKEvent, "id" | "kind" | "pubkey" | "tags">
  zapRequestId: string
  expectedAmountMsats: number
  expectedLnurl?: string
  lnurlNostrPubkey?: string
}): boolean {
  if (event.kind !== EVENT_KINDS.ZAP_RECEIPT) return false
  if (lnurlNostrPubkey && event.pubkey !== lnurlNostrPubkey) return false

  const description = getTagValue(event.tags ?? [], "description")
  if (!description) return false

  const zapRequest = parseZapDescription(description)
  if (zapRequest?.id !== zapRequestId) return false

  const requestTags = Array.isArray(zapRequest.tags)
    ? (zapRequest.tags as unknown[]).filter(
        (tag): tag is string[] =>
          Array.isArray(tag) && tag.every((value) => typeof value === "string")
      )
    : []
  const amountTag = getTagValue(requestTags, "amount")
  if (amountTag && Number(amountTag) !== expectedAmountMsats) return false

  const lnurlTag = getTagValue(requestTags, "lnurl")
  if (expectedLnurl && lnurlTag && lnurlTag !== expectedLnurl) return false

  const bolt11 = getTagValue(event.tags ?? [], "bolt11")
  if (bolt11) {
    const decoded = decodeLightningInvoiceAmount(bolt11)
    if (decoded.msats !== null && decoded.msats !== expectedAmountMsats) {
      return false
    }
  }

  return true
}

export async function waitForZapReceipt({
  zapRequestId,
  recipientPubkey,
  expectedAmountMsats,
  expectedLnurl,
  lnurlNostrPubkey,
  relayUrls,
  timeoutMs = 5_000,
}: {
  zapRequestId: string
  recipientPubkey: string
  expectedAmountMsats: number
  expectedLnurl?: string
  lnurlNostrPubkey?: string
  relayUrls: string[]
  timeoutMs?: number
}): Promise<NDKEvent | null> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const events = (await fetchEventsFanout(
      {
        kinds: [EVENT_KINDS.ZAP_RECEIPT],
        "#p": [recipientPubkey],
        since: Math.floor((startedAt - 5_000) / 1000),
      },
      {
        relayUrls,
        connectTimeoutMs: 1_500,
        fetchTimeoutMs: 2_000,
      }
    )) as NDKEvent[]

    const receipt = events.find((event) =>
      validateZapReceiptEvent({
        event,
        zapRequestId,
        expectedAmountMsats,
        expectedLnurl,
        lnurlNostrPubkey,
      })
    )
    if (receipt) return receipt

    await new Promise((resolve) => setTimeout(resolve, 800))
  }

  return null
}
