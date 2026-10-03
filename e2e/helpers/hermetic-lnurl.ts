import { createHash, randomBytes } from "node:crypto"
import {
  isValidLud16Address,
  normalizeSafeLnurlPayRequestUrl,
} from "../../packages/core/src/protocol/lightning"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
} from "../../tests/support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "../../tests/support/signed-bolt11-fixture"

export interface HermeticLnurlIssuedInvoice {
  lud16: string
  paymentRequest: string
  preimage: string
  amountSats: number
  feeSats: number
}

export interface HermeticLnurlResponse {
  status: number
  contentType: "application/json"
  headers: Record<string, string>
  body: string
}

export type HermeticLnurlResponder = (request: {
  url: string
  method: string
}) => Promise<HermeticLnurlResponse | null>

function invalid(): never {
  throw new Error("Invalid offline LNURL fixture configuration or clock")
}

function jsonResponse(value: unknown): HermeticLnurlResponse {
  return {
    status: 200,
    contentType: "application/json",
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify(value),
  }
}

/** Runner-only HTTP responder. Never fetches or exposes invoice-signing keys. */
export function createHermeticLnurlFixture(input: {
  recipients: readonly {
    lud16: string
    /** Inclusive millisatoshi bounds; requests must still be whole sats. */
    minSendable?: number
    maxSendable?: number
  }[]
  nowSeconds: () => number
  expirySeconds?: number
  feeSats?: number
  /** Runner can register this invoice on its existing native fixture account. */
  onInvoiceIssued?: (
    invoice: HermeticLnurlIssuedInvoice
  ) => void | Promise<void>
}) {
  const nowSeconds = input.nowSeconds
  const onInvoiceIssued = input.onInvoiceIssued
  const expirySeconds = input.expirySeconds ?? 900
  const feeSats = input.feeSats ?? 1
  if (
    input.recipients.length === 0 ||
    !Number.isSafeInteger(expirySeconds) ||
    expirySeconds < 1 ||
    expirySeconds > 3_600 ||
    !Number.isSafeInteger(feeSats) ||
    feeSats < 0
  )
    invalid()
  const recipients = input.recipients.map((recipient) => {
    const lud16 = recipient.lud16.trim().toLowerCase()
    if (!isValidLud16Address(lud16)) invalid()
    const [username, domain] = lud16.split("@")
    const endpoint = normalizeSafeLnurlPayRequestUrl(
      `https://${domain}/.well-known/lnurlp/${username}`
    )
    const callback = normalizeSafeLnurlPayRequestUrl(
      `https://${domain}/__hermetic_lnurl/callback/${encodeURIComponent(username!)}`
    )
    const minSendable = recipient.minSendable ?? 1_000
    const maxSendable = recipient.maxSendable ?? 1_000_000_000
    if (
      !endpoint ||
      !callback ||
      !Number.isSafeInteger(minSendable) ||
      !Number.isSafeInteger(maxSendable) ||
      minSendable <= 0 ||
      maxSendable < minSendable ||
      (BigInt(minSendable) + 999n) / 1_000n > BigInt(maxSendable) / 1_000n
    )
      invalid()
    const metadata = JSON.stringify([
      ["text/plain", "Offline checkout payout"],
      ["text/identifier", lud16],
    ])
    return { lud16, endpoint, callback, minSendable, maxSendable, metadata }
  })
  if (
    new Set(recipients.map(({ endpoint }) => endpoint)).size !==
    recipients.length
  )
    invalid()
  let metadataRequests = 0
  let invoicesIssued = 0
  const respond: HermeticLnurlResponder = async ({ url: rawUrl, method }) => {
    if (method !== "GET") return null
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return null
    }
    if (url.username || url.password || url.hash || url.href !== rawUrl)
      return null
    const metadataRecipient = recipients.find(
      ({ endpoint }) => endpoint === rawUrl
    )
    if (metadataRecipient) {
      metadataRequests += 1
      const { callback, minSendable, maxSendable, metadata } = metadataRecipient
      return jsonResponse({
        callback,
        minSendable,
        maxSendable,
        metadata,
        tag: "payRequest",
        allowsNostr: false,
      })
    }
    const callback = `${url.origin}${url.pathname}`
    const recipient = recipients.find(
      (candidate) => candidate.callback === callback
    )
    const entries = [...url.searchParams.entries()]
    if (
      !recipient ||
      entries.length !== 1 ||
      entries[0]![0] !== "amount" ||
      !/^[1-9][0-9]*$/.test(entries[0]![1])
    )
      return null
    const amountMsats = Number(entries[0]![1])
    if (
      !Number.isSafeInteger(amountMsats) ||
      amountMsats % 1_000 !== 0 ||
      amountMsats < recipient.minSendable ||
      amountMsats > recipient.maxSendable
    )
      return null
    const createdAt = nowSeconds()
    // BOLT11 timestamps are 35 bits; bound expiry too, rather than wrapping it.
    if (
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      createdAt + expirySeconds > 0x7ffffffff
    )
      invalid()
    const preimageBytes = randomBytes(32)
    const preimage = preimageBytes.toString("hex")
    const paymentHash = createHash("sha256").update(preimageBytes).digest()
    preimageBytes.fill(0)
    const amountSats = amountMsats / 1_000
    const expiryWords: number[] = []
    for (let value = expirySeconds; value > 0; value = Math.floor(value / 32))
      expiryWords.unshift(value % 32)
    const paymentRequest = makeSignedBolt11Fixture({
      hrp: `lnbcrt${BigInt(amountSats) * 10n}n`,
      createdAt,
      fields: [
        bolt11PaymentHashField(paymentHash),
        bolt11PaymentSecretField(),
        bolt11DescriptionHashField(recipient.metadata),
        { tag: "x", words: expiryWords },
      ],
    })
    try {
      await onInvoiceIssued?.({
        lud16: recipient.lud16,
        paymentRequest,
        preimage,
        amountSats,
        feeSats,
      })
    } catch {
      throw new Error("Offline LNURL invoice registration failed")
    }
    invoicesIssued += 1
    return jsonResponse({ pr: paymentRequest })
  }
  return {
    respond,
    snapshot: () => ({ metadataRequests, invoicesIssued }),
  }
}
