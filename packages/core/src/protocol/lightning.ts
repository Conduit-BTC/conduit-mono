import type { NDKEvent } from "@nostr-dev-kit/ndk"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

import { config } from "../config"
import {
  isSatsLikeCurrency,
  isUsdCurrencyCode,
  normalizeCommercePrice,
  type PricingRateInput,
} from "../pricing"
import { normalizePubkey } from "../utils"
import { ANON_ZAP_PROVIDER_ATTESTATION_TAG } from "./anon-zap"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"
import { EVENT_KINDS } from "./kinds"
import { fetchEventsFanout, getEventSourceRelayUrls } from "./ndk"

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

export type FetchLnurlPayMetadataOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_LNURL_METADATA_TIMEOUT_MS = 10_000
const MAX_LNURL_METADATA_RESPONSE_BYTES = 64 * 1_024

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number
): Promise<string> {
  if (!response.body || typeof response.body.getReader !== "function") {
    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
      throw new Error("LNURL endpoint response is too large")
    }
    return body
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let body = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    bytesRead += chunk.value.byteLength
    if (bytesRead > maxBytes) {
      await reader.cancel("LNURL endpoint response exceeded the byte limit")
      throw new Error("LNURL endpoint response is too large")
    }
    body += decoder.decode(chunk.value, { stream: true })
  }
  return body + decoder.decode()
}

export function normalizeSafeLnurlPayRequestUrl(raw: string): string | null {
  try {
    if (!raw || raw !== raw.trim() || raw.length > 4_096) return null
    const url = new URL(raw)
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
    const labels = hostname.split(".")
    const isLocalName =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".home") ||
      hostname.endsWith(".lan")
    const isIpLiteral =
      hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
    const hasValidDnsName =
      labels.length >= 2 &&
      labels.every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
      )

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443") ||
      isLocalName ||
      isIpLiteral ||
      !hasValidDnsName
    ) {
      return null
    }

    return url.toString()
  } catch {
    return null
  }
}

function parseLnurlPayMetadataResponse(
  data: Record<string, unknown>,
  payRequestUrl: string
): LnurlPayMetadata {
  if (data.tag !== "payRequest") {
    throw new Error(`Not a LNURL-pay endpoint (tag=${String(data.tag)})`)
  }

  const callback =
    typeof data.callback === "string"
      ? normalizeSafeLnurlPayRequestUrl(data.callback)
      : null
  const minSendable = data.minSendable
  const maxSendable = data.maxSendable
  if (!callback) throw new Error("LNURL-pay response has an unsafe callback")
  if (
    !Number.isSafeInteger(minSendable) ||
    !Number.isSafeInteger(maxSendable) ||
    (minSendable as number) <= 0 ||
    (maxSendable as number) < (minSendable as number)
  ) {
    throw new Error("LNURL-pay response has an invalid payment range")
  }

  return {
    payRequestUrl,
    lnurl: encodeLnurl(payRequestUrl),
    callback,
    minSendable: minSendable as number,
    maxSendable: maxSendable as number,
    tag: "payRequest",
    allowsNostr: data.allowsNostr === true,
    nostrPubkey:
      typeof data.nostrPubkey === "string" ? data.nostrPubkey : undefined,
    metadata: typeof data.metadata === "string" ? data.metadata : "[]",
  }
}

export async function fetchLnurlPayMetadataFromUrl(
  payRequestUrl: string,
  options: FetchLnurlPayMetadataOptions = {}
): Promise<LnurlPayMetadata> {
  const safePayRequestUrl = normalizeSafeLnurlPayRequestUrl(payRequestUrl)
  if (!safePayRequestUrl) {
    throw new Error("Unsafe LNURL-pay request URL")
  }
  const timeoutMs =
    Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.min(options.timeoutMs!, 30_000)
      : DEFAULT_LNURL_METADATA_TIMEOUT_MS

  let data: Record<string, unknown>
  try {
    const res = await (options.fetchImpl ?? fetch)(safePayRequestUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`LNURL endpoint returned ${res.status}`)
    const contentLength = Number(res.headers?.get("content-length") ?? "0")
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_LNURL_METADATA_RESPONSE_BYTES
    ) {
      throw new Error("LNURL endpoint response is too large")
    }
    let parsed: unknown
    if (typeof res.text === "function") {
      const body = await readResponseTextWithLimit(
        res,
        MAX_LNURL_METADATA_RESPONSE_BYTES
      )
      parsed = JSON.parse(body) as unknown
    } else {
      // Compatibility for narrowly mocked Response objects in existing callers.
      parsed = (await res.json()) as unknown
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("LNURL endpoint returned an invalid response")
    }
    data = parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `Failed to reach LNURL endpoint: ${error instanceof Error ? error.message : "network error"}`,
      { cause: error }
    )
  }

  return parseLnurlPayMetadataResponse(data, safePayRequestUrl)
}

/**
 * Return true when a value has the basic `name@domain.tld` shape expected for
 * lud16 / Lightning Address resolution.
 */
export function isValidLud16Address(lud16: string): boolean {
  const trimmed = lud16.trim().toLowerCase()
  const atIndex = trimmed.indexOf("@")
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf("@")) return false
  if (atIndex === trimmed.length - 1) return false

  const user = trimmed.slice(0, atIndex)
  const domain = trimmed.slice(atIndex + 1)
  if (!/^[a-z0-9._~!$&'()*+,;=:-]+$/.test(user)) return false
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return false
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) {
    return false
  }

  return true
}

/**
 * Resolve an lud16 address (user@domain) to an LNURL pay metadata object.
 *
 * Throws if the address is malformed, the endpoint is unreachable, or the
 * response is not a valid LNURL-pay response.
 */
export async function fetchLnurlPayMetadata(
  lud16: string,
  options: FetchLnurlPayMetadataOptions = {}
): Promise<LnurlPayMetadata> {
  const trimmed = lud16.trim().toLowerCase()
  if (!isValidLud16Address(trimmed)) {
    throw new Error(`Invalid lud16 address: ${lud16}`)
  }
  const atIndex = trimmed.indexOf("@")
  const user = trimmed.slice(0, atIndex)
  const domain = trimmed.slice(atIndex + 1)
  const url = `https://${domain}/.well-known/lnurlp/${user}`

  try {
    return await fetchLnurlPayMetadataFromUrl(url, options)
  } catch (error) {
    throw new Error(
      `Failed to reach LNURL endpoint for ${lud16}: ${error instanceof Error ? error.message : "network error"}`,
      { cause: error }
    )
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

export const OMF_ZAPOUT_MARKER_TAG = ["omf", "zapout"] as const
export const OMF_ZAPOUT_PROVIDER_TAG = "omf_provider"

export interface OmfZapoutReceipt {
  id: string
  createdAt: number | null
  receiptPubkey: string
  zapRequestId: string | null
  zapRequestCreatedAt: number | null
  senderPubkey: string | null
  recipientPubkey: string | null
  amountMsats: number | null
  comment: string | null
  sourceRelayUrls: string[]
}

const MAX_OMF_ZAP_EVENT_FUTURE_SKEW_SECONDS = 5 * 60
const MAX_OMF_ZAP_RECEIPT_PRE_REQUEST_SKEW_SECONDS = 5

export type OmfZapoutReceiptEvent = Pick<
  NDKEvent,
  "id" | "kind" | "pubkey" | "created_at" | "tags" | "content" | "sig"
> & { rawEvent?: () => unknown }

export type LnurlNostrPubkeyResolution =
  | {
      status: "resolved"
      pubkey: string
      mismatchStatus?: "invalid" | "unavailable"
    }
  | { status: "invalid" }
  | { status: "unavailable" }

export type ResolveLnurlNostrPubkeyResult =
  string | null | LnurlNostrPubkeyResolution

export type ResolveLnurlNostrPubkey = (
  payRequestUrl: string,
  recipientPubkey: string
) => Promise<ResolveLnurlNostrPubkeyResult>

export type VerifyProviderAttestation = (input: {
  zapRequest: SignedPublicNostrEvent
  providerPubkey: string
}) => Promise<"verified" | "invalid" | "unavailable">

export type ParseVerifiedOmfZapoutReceiptOptions = {
  /**
   * Resolve the authoritative receipt signer only after binding payRequestUrl
   * to recipientPubkey through the recipient's signed profile metadata.
   */
  resolveLnurlNostrPubkey?: ResolveLnurlNostrPubkey
  /** Verify a server-issued checkout-time provider attestation. */
  verifyProviderAttestation?: VerifyProviderAttestation
}

export type OmfZapoutReceiptAuthorityVerificationResult =
  | { status: "verified"; receipt: OmfZapoutReceipt }
  | { status: "invalid"; receipt: null }
  | { status: "authority_unavailable"; receipt: OmfZapoutReceipt }

export function hasOmfZapoutMarker(tags: readonly string[][]): boolean {
  return tags.some(
    (tag) =>
      tag.length === OMF_ZAPOUT_MARKER_TAG.length &&
      tag[0] === OMF_ZAPOUT_MARKER_TAG[0] &&
      tag[1] === OMF_ZAPOUT_MARKER_TAG[1]
  )
}

export function appendOmfZapoutMarker(tags: string[][]): string[][] {
  if (hasOmfZapoutMarker(tags)) return tags
  return [...tags, [...OMF_ZAPOUT_MARKER_TAG]]
}

export type FetchLnurlInvoiceOptions = {
  /** Optional zap request event JSON. When omitted, this is a plain LNURL-pay invoice request. */
  zapRequestJson?: string
  /** Optional LNURL value for NIP-57 zap callbacks. */
  lnurl?: string
}

/**
 * Fetch an LNURL-pay invoice by calling the callback.
 *
 * By default this sends a plain LNURL-pay request by adding `amount` to the
 * callback URL while stripping any `nostr` or `lnurl` query params already on
 * the callback. When `options.zapRequestJson` or `options.lnurl` are provided,
 * those NIP-57 params are added explicitly for zap callbacks.
 */
export async function fetchLnurlInvoice(
  lnurlCallback: string,
  amountMsats: number,
  options: FetchLnurlInvoiceOptions = {}
): Promise<FetchZapInvoiceResult> {
  const url = new URL(lnurlCallback)
  url.searchParams.set("amount", String(amountMsats))
  url.searchParams.delete("nostr")
  url.searchParams.delete("lnurl")
  if (options.zapRequestJson)
    url.searchParams.set("nostr", options.zapRequestJson)
  if (options.lnurl) url.searchParams.set("lnurl", options.lnurl)

  let data: Record<string, unknown>
  try {
    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`LNURL callback returned ${res.status}`)
    data = (await res.json()) as Record<string, unknown>
  } catch (e) {
    throw new Error(
      `Failed to fetch LNURL invoice: ${e instanceof Error ? e.message : "network error"}`,
      { cause: e }
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
  try {
    const result = await fetchLnurlInvoice(lnurlCallback, amountMsats, {
      zapRequestJson,
      lnurl,
    })
    const binding = validateZapInvoiceDescriptionBinding({
      invoice: result.invoice,
      zapRequestJson,
    })
    if (!binding.ok) {
      throw new ZapInvoiceBindingError(binding.code, binding.reason)
    }
    return result
  } catch (e) {
    if (e instanceof ZapInvoiceBindingError) throw e
    throw new Error(
      `Failed to fetch zap invoice: ${e instanceof Error ? e.message : "network error"}`,
      { cause: e }
    )
  }
}

export type LightningInvoiceNetwork =
  "mainnet" | "testnet" | "signet" | "regtest" | "unknown"

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
const BOLT11_TIMESTAMP_WORD_COUNT = 7
const BOLT11_SIGNATURE_WORD_COUNT = 104
const BECH32_CHECKSUM_WORD_COUNT = 6
const BOLT11_DESCRIPTION_HASH_WORD_COUNT = 52

type Bolt11TaggedField = {
  tag: string
  words: number[]
}

type ParsedBolt11Invoice = {
  values: number[]
  taggedFields: Bolt11TaggedField[]
}

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

function parseBolt11Invoice(invoice: string): ParsedBolt11Invoice | null {
  const raw = normalizeLightningInvoice(invoice)
  const hasLowercase = /[a-z]/.test(raw)
  const hasUppercase = /[A-Z]/.test(raw)
  if (hasLowercase && hasUppercase) return null

  const normalized = raw.toLowerCase()
  if (!isValidBech32Invoice(normalized)) return null

  const separatorIndex = normalized.lastIndexOf("1")
  const hrp = normalized.slice(0, separatorIndex)
  if (!/^ln(?:bc|tb|sb|bcrt)(?:\d+[munp]?)?$/.test(hrp)) return null
  const dataPart = normalized.slice(separatorIndex + 1)
  const values = Array.from(dataPart, (char) => BECH32_CHARSET.indexOf(char))
  const minimumWordCount =
    BOLT11_TIMESTAMP_WORD_COUNT +
    BOLT11_SIGNATURE_WORD_COUNT +
    BECH32_CHECKSUM_WORD_COUNT
  if (values.some((value) => value < 0) || values.length < minimumWordCount) {
    return null
  }

  const taggedDataEnd =
    values.length - BECH32_CHECKSUM_WORD_COUNT - BOLT11_SIGNATURE_WORD_COUNT
  const taggedFields: Bolt11TaggedField[] = []
  let index = BOLT11_TIMESTAMP_WORD_COUNT

  while (index < taggedDataEnd) {
    if (index + 3 > taggedDataEnd) return null
    const tag = BECH32_CHARSET[values[index]!]
    const length = (values[index + 1]! << 5) + values[index + 2]!
    const start = index + 3
    const stop = start + length
    if (!tag || stop > taggedDataEnd) return null
    taggedFields.push({ tag, words: values.slice(start, stop) })
    index = stop
  }

  return { values, taggedFields }
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

function fromWords(words: number[]): Uint8Array | null {
  const bytes: number[] = []
  let value = 0
  let bits = 0

  for (const word of words) {
    if (!Number.isInteger(word) || word < 0 || word > 31) return null
    value = (value << 5) | word
    bits += 5
    while (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
      value &= bits === 0 ? 0 : (1 << bits) - 1
    }
  }

  if (bits >= 5 || value !== 0) return null
  return Uint8Array.from(bytes)
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
  return `lnurl1${[...words, ...checksum]
    .map((word) => BECH32_CHARSET[word]!)
    .join("")}`
}

export function decodeLnurl(value: string): string | null {
  if (!value || value !== value.trim()) return null
  const hasLowercase = /[a-z]/.test(value)
  const hasUppercase = /[A-Z]/.test(value)
  if (hasLowercase && hasUppercase) return null

  const normalized = value.toLowerCase()
  const separatorIndex = normalized.lastIndexOf("1")
  if (
    separatorIndex !== "lnurl".length ||
    normalized.slice(0, separatorIndex) !== "lnurl" ||
    separatorIndex + 7 > normalized.length
  ) {
    return null
  }

  const values = Array.from(normalized.slice(separatorIndex + 1), (char) =>
    BECH32_CHARSET.indexOf(char)
  )
  if (
    values.some((word) => word < 0) ||
    bech32Polymod([...bech32HrpExpand("lnurl"), ...values]) !== 1
  ) {
    return null
  }

  const bytes = fromWords(values.slice(0, -BECH32_CHECKSUM_WORD_COUNT))
  if (!bytes) return null
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const url = new URL(decoded)
    return url.protocol === "https:" || url.protocol === "http:"
      ? decoded
      : null
  } catch {
    return null
  }
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

function wordsToBigInt(words: number[]): bigint {
  return words.reduce((acc, word) => (acc << 5n) + BigInt(word), 0n)
}

function wordsToBytes(
  words: number[],
  expectedLength: number
): Uint8Array | null {
  const bytes: number[] = []
  let value = 0
  let bits = 0

  for (const word of words) {
    if (!Number.isInteger(word) || word < 0 || word > 31) return null
    value = (value << 5) | word
    bits += 5
    while (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 0xff)
      value &= bits === 0 ? 0 : (1 << bits) - 1
    }
  }

  if (value !== 0 || bytes.length !== expectedLength) return null
  return Uint8Array.from(bytes)
}

function equalBytesConstantTime(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

export type ZapInvoiceBindingErrorCode =
  | "invalid_bolt11"
  | "missing_description_hash"
  | "ambiguous_description"
  | "invalid_description_hash"
  | "description_hash_mismatch"

export type ZapInvoiceBindingValidation =
  | { ok: true; descriptionHashHex: string }
  | {
      ok: false
      code: ZapInvoiceBindingErrorCode
      reason: string
    }

export class ZapInvoiceBindingError extends Error {
  readonly code: ZapInvoiceBindingErrorCode

  constructor(code: ZapInvoiceBindingErrorCode, message: string) {
    super(message)
    this.name = "ZapInvoiceBindingError"
    this.code = code
  }
}

export function validateZapInvoiceDescriptionBinding({
  invoice,
  zapRequestJson,
}: {
  invoice: string
  zapRequestJson: string
}): ZapInvoiceBindingValidation {
  const parsed = parseBolt11Invoice(invoice)
  if (!parsed) {
    return {
      ok: false,
      code: "invalid_bolt11",
      reason: "The zap callback returned an invalid BOLT11 invoice.",
    }
  }

  const descriptionHashes = parsed.taggedFields.filter(
    (field) => field.tag === "h"
  )
  const plainDescriptions = parsed.taggedFields.filter(
    (field) => field.tag === "d"
  )

  if (descriptionHashes.length === 0) {
    return {
      ok: false,
      code: "missing_description_hash",
      reason: "The zap invoice does not commit to the signed NIP-57 request.",
    }
  }

  if (descriptionHashes.length !== 1 || plainDescriptions.length > 0) {
    return {
      ok: false,
      code: "ambiguous_description",
      reason: "The zap invoice contains ambiguous description commitments.",
    }
  }

  const descriptionHashWords = descriptionHashes[0]!.words
  if (descriptionHashWords.length !== BOLT11_DESCRIPTION_HASH_WORD_COUNT) {
    return {
      ok: false,
      code: "invalid_description_hash",
      reason: "The zap invoice contains an invalid description hash.",
    }
  }

  const actualHash = wordsToBytes(descriptionHashWords, 32)
  if (!actualHash) {
    return {
      ok: false,
      code: "invalid_description_hash",
      reason: "The zap invoice contains an invalid description hash.",
    }
  }

  const expectedHash = sha256(new TextEncoder().encode(zapRequestJson))
  if (!equalBytesConstantTime(actualHash, expectedHash)) {
    return {
      ok: false,
      code: "description_hash_mismatch",
      reason:
        "The zap invoice is not bound to the signed NIP-57 request sent to the callback.",
    }
  }

  return { ok: true, descriptionHashHex: bytesToHex(actualHash) }
}

export function decodeLightningInvoiceMetadata(
  invoice: string
): LightningInvoiceMetadata {
  const amount = decodeLightningInvoiceAmount(invoice)
  const parsed = parseBolt11Invoice(invoice)
  if (!parsed) {
    return { ...amount, createdAt: null, expiresAt: null }
  }

  const createdAtBig = wordsToBigInt(
    parsed.values.slice(0, BOLT11_TIMESTAMP_WORD_COUNT)
  )
  const createdAt =
    createdAtBig <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(createdAtBig)
      : null

  const expiryFields = parsed.taggedFields.filter((field) => field.tag === "x")
  const expiryWords = expiryFields.length === 1 ? expiryFields[0]!.words : null
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

function getSingleTagValue(
  tags: readonly string[][],
  name: string
): string | null {
  const matches = tags.filter((tag) => tag[0] === name)
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null
}

export function parseZapReceiptDescription(
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

function getStringField(
  record: Record<string, unknown>,
  name: string
): string | null {
  const value = record[name]
  return typeof value === "string" && value.trim() ? value : null
}

function parseMsatsTag(value: string | null): number | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function getPublicZapComment(
  zapRequest: Record<string, unknown>
): string | null {
  const content = getStringField(zapRequest, "content")
  if (!content) return null
  const normalized = content.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ")
  const trimmed = normalized.trim()
  return trimmed ? trimmed.slice(0, 280) : null
}

export function parseOmfZapoutReceipt(
  event: OmfZapoutReceiptEvent
): OmfZapoutReceipt | null {
  const signedReceipt = toSignedPublicNostrEvent(event)
  if (
    !signedReceipt ||
    !isValidSignedPublicNostrEvent(signedReceipt) ||
    signedReceipt.kind !== EVENT_KINDS.ZAP_RECEIPT
  ) {
    return null
  }

  const receiptTags = signedReceipt.tags
  const description = getSingleTagValue(receiptTags, "description")
  if (!description) return null

  const zapRequest = parseZapReceiptDescription(description)
  const signedRequest = toSignedPublicNostrEvent(zapRequest)
  if (
    !signedRequest ||
    !isValidSignedPublicNostrEvent(signedRequest) ||
    signedRequest.kind !== EVENT_KINDS.ZAP_REQUEST
  ) {
    return null
  }

  const nowSeconds = Math.floor(Date.now() / 1_000)
  if (
    signedReceipt.created_at >
      nowSeconds + MAX_OMF_ZAP_EVENT_FUTURE_SKEW_SECONDS ||
    signedRequest.created_at >
      nowSeconds + MAX_OMF_ZAP_EVENT_FUTURE_SKEW_SECONDS ||
    signedReceipt.created_at <
      signedRequest.created_at - MAX_OMF_ZAP_RECEIPT_PRE_REQUEST_SKEW_SECONDS
  ) {
    return null
  }

  const requestTags = signedRequest.tags
  if (!hasOmfZapoutMarker(requestTags)) return null

  const senderPubkey = normalizePubkey(signedRequest.pubkey)
  const requestRecipientPubkey = normalizePubkey(
    getSingleTagValue(requestTags, "p")
  )
  const receiptRecipientPubkey = normalizePubkey(
    getSingleTagValue(receiptTags, "p")
  )
  const receiptSenderTags = receiptTags.filter((tag) => tag[0] === "P")
  const receiptSenderPubkey =
    receiptSenderTags.length === 1
      ? normalizePubkey(receiptSenderTags[0]?.[1] ?? null)
      : null
  const requestAmountMsats = parseMsatsTag(
    getSingleTagValue(requestTags, "amount")
  )
  const receiptAmountTags = receiptTags.filter((tag) => tag[0] === "amount")
  const receiptAmountMsats =
    receiptAmountTags.length === 1
      ? parseMsatsTag(receiptAmountTags[0]?.[1] ?? null)
      : null
  const invoice = getSingleTagValue(receiptTags, "bolt11")
  const receiptPubkey = normalizePubkey(signedReceipt.pubkey)
  if (
    !receiptPubkey ||
    !senderPubkey ||
    !requestRecipientPubkey ||
    !receiptRecipientPubkey ||
    requestRecipientPubkey !== receiptRecipientPubkey ||
    receiptSenderTags.length > 1 ||
    (receiptSenderTags.length === 1 && receiptSenderPubkey !== senderPubkey) ||
    requestAmountMsats === null ||
    requestAmountMsats <= 0 ||
    receiptAmountTags.length > 1 ||
    (receiptAmountTags.length === 1 &&
      receiptAmountMsats !== requestAmountMsats) ||
    !invoice ||
    !validateZapInvoiceDescriptionBinding({
      invoice,
      zapRequestJson: description,
    }).ok ||
    !validateLightningInvoiceForPayment({
      invoice,
      expectedAmountMsats: requestAmountMsats,
      nowSeconds: signedRequest.created_at,
    }).ok
  ) {
    return null
  }

  return {
    id: signedReceipt.id,
    createdAt: signedReceipt.created_at,
    receiptPubkey,
    zapRequestId: signedRequest.id,
    zapRequestCreatedAt: signedRequest.created_at,
    senderPubkey,
    recipientPubkey: requestRecipientPubkey,
    amountMsats: requestAmountMsats,
    comment: getPublicZapComment(signedRequest),
    sourceRelayUrls: getEventSourceRelayUrls(event as NDKEvent),
  }
}

export async function verifyOmfZapoutReceiptAuthority(
  event: OmfZapoutReceiptEvent,
  options: ParseVerifiedOmfZapoutReceiptOptions = {}
): Promise<OmfZapoutReceiptAuthorityVerificationResult> {
  const parsedReceipt = parseOmfZapoutReceipt(event)
  if (!parsedReceipt) return { status: "invalid", receipt: null }

  const signedReceipt = toSignedPublicNostrEvent(event)
  const description = signedReceipt
    ? getSingleTagValue(signedReceipt.tags, "description")
    : null
  const zapRequest = description
    ? toSignedPublicNostrEvent(parseZapReceiptDescription(description))
    : null
  const encodedLnurl = zapRequest
    ? getSingleTagValue(zapRequest.tags, "lnurl")
    : null
  const decodedLnurl = encodedLnurl ? decodeLnurl(encodedLnurl) : null
  const safePayRequestUrl = decodedLnurl
    ? normalizeSafeLnurlPayRequestUrl(decodedLnurl)
    : null
  if (
    !signedReceipt ||
    !isValidSignedPublicNostrEvent(signedReceipt) ||
    !zapRequest ||
    !isValidSignedPublicNostrEvent(zapRequest) ||
    !safePayRequestUrl ||
    !parsedReceipt.recipientPubkey ||
    normalizePubkey(getSingleTagValue(zapRequest.tags, "p")) !==
      parsedReceipt.recipientPubkey
  ) {
    return { status: "invalid", receipt: null }
  }
  const providerTags = zapRequest.tags.filter(
    (tag) => tag[0] === OMF_ZAPOUT_PROVIDER_TAG
  )
  const providerAttestationTags = zapRequest.tags.filter(
    (tag) => tag[0] === ANON_ZAP_PROVIDER_ATTESTATION_TAG
  )
  const attestedProvider =
    providerTags.length === 1
      ? normalizePubkey(providerTags[0]?.[1] ?? null)
      : null
  if (
    (providerTags.length > 0 && !attestedProvider) ||
    providerAttestationTags.length > 1
  ) {
    return { status: "invalid", receipt: null }
  }
  if (attestedProvider && options.verifyProviderAttestation) {
    try {
      const attestation = await options.verifyProviderAttestation({
        zapRequest,
        providerPubkey: attestedProvider,
      })
      if (attestation === "verified") {
        return attestedProvider === parsedReceipt.receiptPubkey
          ? { status: "verified", receipt: parsedReceipt }
          : { status: "invalid", receipt: null }
      }
      if (attestation === "invalid") {
        return { status: "invalid", receipt: null }
      }
      return { status: "authority_unavailable", receipt: parsedReceipt }
    } catch {
      return { status: "authority_unavailable", receipt: parsedReceipt }
    }
  }

  if (!options.resolveLnurlNostrPubkey) {
    return { status: "authority_unavailable", receipt: parsedReceipt }
  }

  try {
    const resolution = await options.resolveLnurlNostrPubkey(
      safePayRequestUrl,
      parsedReceipt.recipientPubkey
    )
    if (
      resolution === null ||
      (typeof resolution === "object" && resolution.status === "unavailable")
    ) {
      return { status: "authority_unavailable", receipt: parsedReceipt }
    }
    if (typeof resolution === "object" && resolution.status === "invalid") {
      return { status: "invalid", receipt: null }
    }

    const providerPubkey = normalizePubkey(
      typeof resolution === "string" ? resolution : resolution.pubkey
    )
    if (!providerPubkey) return { status: "invalid", receipt: null }
    if (providerPubkey === parsedReceipt.receiptPubkey) {
      return { status: "verified", receipt: parsedReceipt }
    }
    return typeof resolution === "object" &&
      resolution.mismatchStatus === "unavailable"
      ? { status: "authority_unavailable", receipt: parsedReceipt }
      : { status: "invalid", receipt: null }
  } catch {
    return { status: "authority_unavailable", receipt: parsedReceipt }
  }
}

export async function parseVerifiedOmfZapoutReceipt(
  event: OmfZapoutReceiptEvent,
  options: ParseVerifiedOmfZapoutReceiptOptions = {}
): Promise<OmfZapoutReceipt | null> {
  const result = await verifyOmfZapoutReceiptAuthority(event, options)
  return result.status === "verified" ? result.receipt : null
}

function toSignedPublicNostrEvent(
  value: unknown
): SignedPublicNostrEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown> & {
    rawEvent?: () => unknown
  }
  const raw =
    typeof candidate.rawEvent === "function" ? candidate.rawEvent() : candidate
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const event = raw as Record<string, unknown>
  if (
    typeof event.id !== "string" ||
    typeof event.pubkey !== "string" ||
    typeof event.created_at !== "number" ||
    typeof event.kind !== "number" ||
    typeof event.content !== "string" ||
    typeof event.sig !== "string" ||
    !Array.isArray(event.tags) ||
    !event.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((entry) => typeof entry === "string")
    )
  ) {
    return null
  }
  return event as SignedPublicNostrEvent
}

export function validateZapReceiptEvent({
  event,
  zapRequestId,
  requestCreatedAt,
  recipientPubkey,
  expectedAmountMsats,
  expectedLnurl,
  expectedInvoice,
  lnurlNostrPubkey,
  receiptNotAfterSeconds,
}: {
  event: Pick<
    NDKEvent,
    "id" | "kind" | "pubkey" | "created_at" | "content" | "tags" | "sig"
  > & { rawEvent?: () => unknown }
  zapRequestId: string
  requestCreatedAt: number
  recipientPubkey: string
  expectedAmountMsats: number
  expectedLnurl: string
  expectedInvoice: string
  lnurlNostrPubkey: string
  receiptNotAfterSeconds?: number
}): boolean {
  const signedReceipt = toSignedPublicNostrEvent(event)
  if (
    !signedReceipt ||
    !isValidSignedPublicNostrEvent(signedReceipt) ||
    signedReceipt.kind !== EVENT_KINDS.ZAP_RECEIPT ||
    normalizePubkey(signedReceipt.pubkey) !== normalizePubkey(lnurlNostrPubkey)
  ) {
    return false
  }
  if (
    signedReceipt.created_at < requestCreatedAt - 5 ||
    (receiptNotAfterSeconds !== undefined &&
      signedReceipt.created_at > receiptNotAfterSeconds)
  ) {
    return false
  }

  const description = getSingleTagValue(signedReceipt.tags, "description")
  if (!description) return false

  const zapRequest = parseZapReceiptDescription(description)
  const signedRequest = toSignedPublicNostrEvent(zapRequest)
  if (
    !signedRequest ||
    !isValidSignedPublicNostrEvent(signedRequest) ||
    signedRequest.kind !== EVENT_KINDS.ZAP_REQUEST ||
    signedRequest.id !== zapRequestId ||
    signedRequest.created_at !== requestCreatedAt
  ) {
    return false
  }

  const requestTags = signedRequest.tags
  const receiptTags = signedReceipt.tags
  if (
    normalizePubkey(getSingleTagValue(requestTags, "p")) !==
      normalizePubkey(recipientPubkey) ||
    normalizePubkey(getSingleTagValue(receiptTags, "p")) !==
      normalizePubkey(recipientPubkey)
  ) {
    return false
  }
  const amountTag = getSingleTagValue(requestTags, "amount")
  if (parseMsatsTag(amountTag) !== expectedAmountMsats) return false

  const lnurlTag = getSingleTagValue(requestTags, "lnurl")
  if (lnurlTag !== expectedLnurl) return false

  const bolt11 = getSingleTagValue(receiptTags, "bolt11")
  if (
    !bolt11 ||
    normalizeLightningInvoice(bolt11).toLowerCase() !==
      normalizeLightningInvoice(expectedInvoice).toLowerCase() ||
    !validateZapInvoiceDescriptionBinding({
      invoice: bolt11,
      zapRequestJson: description,
    }).ok ||
    decodeLightningInvoiceAmount(bolt11).msats !== expectedAmountMsats
  ) {
    return false
  }

  const receiptSenderTags = receiptTags.filter((tag) => tag[0] === "P")
  if (
    receiptSenderTags.length > 1 ||
    (receiptSenderTags.length === 1 &&
      normalizePubkey(receiptSenderTags[0]?.[1] ?? null) !==
        normalizePubkey(signedRequest.pubkey))
  ) {
    return false
  }

  const receiptAmountTags = receiptTags.filter((tag) => tag[0] === "amount")
  if (
    receiptAmountTags.length > 1 ||
    (receiptAmountTags.length === 1 &&
      parseMsatsTag(receiptAmountTags[0]?.[1] ?? null) !== expectedAmountMsats)
  ) {
    return false
  }

  return true
}

export async function waitForZapReceipt({
  zapRequestId,
  requestCreatedAt,
  recipientPubkey,
  expectedAmountMsats,
  expectedLnurl,
  expectedInvoice,
  lnurlNostrPubkey,
  relayUrls,
  receiptNotAfterSeconds,
  timeoutMs = 5_000,
}: {
  zapRequestId: string
  requestCreatedAt: number
  recipientPubkey: string
  expectedAmountMsats: number
  expectedLnurl: string
  expectedInvoice: string
  lnurlNostrPubkey: string
  relayUrls: string[]
  receiptNotAfterSeconds?: number
  timeoutMs?: number
}): Promise<NDKEvent | null> {
  const startedAt = Date.now()
  const stopAt = startedAt + Math.max(0, timeoutMs)

  do {
    const events = (await fetchEventsFanout(
      {
        kinds: [EVENT_KINDS.ZAP_RECEIPT],
        authors: [lnurlNostrPubkey],
        "#p": [recipientPubkey],
        since: Math.max(0, requestCreatedAt - 5),
        ...(receiptNotAfterSeconds !== undefined
          ? { until: receiptNotAfterSeconds }
          : {}),
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
        requestCreatedAt,
        recipientPubkey,
        expectedAmountMsats,
        expectedLnurl,
        expectedInvoice,
        lnurlNostrPubkey,
        receiptNotAfterSeconds,
      })
    )
    if (receipt) return receipt

    const remainingMs = stopAt - Date.now()
    if (remainingMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(800, remainingMs))
      )
    }
  } while (Date.now() < stopAt)

  return null
}
