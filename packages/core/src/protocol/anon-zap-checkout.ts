import { schnorr } from "@noble/curves/secp256k1.js"
import { hexToBytes } from "@noble/curves/utils.js"
import { sha256 } from "@noble/hashes/sha2.js"

import type { LnurlPayMetadata } from "./lightning"
import { EVENT_KINDS } from "./kinds"
import { evaluateListingSafety } from "./listing-safety"
import { parseProductEvent } from "./products"
import type { AnonZapRequestDraft } from "./anon-zap"

export type SignedPublicNostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type AnonZapCheckoutItem = {
  productAddress: string
  quantity: number
}

export type AnonZapCheckoutIntent = {
  merchantPubkey: string
  amountMsats: number
  items: AnonZapCheckoutItem[]
}

export type AnonZapSigningAuthorization = {
  checkoutSessionId: string
  merchantPubkey: string
  amountMsats: number
  lnurl: string
  publicZapPolicy: "anonymous_public_zap_allowed"
}

export type AuthorizedAnonZapCheckout = {
  draft: AnonZapRequestDraft
  authorization: Omit<AnonZapSigningAuthorization, "checkoutSessionId">
  lnurlCallback: string
  lnurlNostrPubkey: string
  relayUrls: string[]
}

const MAX_CART_ITEMS = 50
const MAX_ITEM_QUANTITY = 99
const PRODUCT_KIND = 30402
const PROFILE_KIND = 0
const DELETION_KIND = 5
const HEX_64 = /^[0-9a-f]{64}$/i

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

function computeEventId(event: SignedPublicNostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ])
  return bytesToHex(sha256(new TextEncoder().encode(serialized)))
}

export function isValidSignedPublicNostrEvent(
  event: SignedPublicNostrEvent
): boolean {
  try {
    if (
      !HEX_64.test(event.id) ||
      !HEX_64.test(event.pubkey) ||
      !/^[0-9a-f]{128}$/i.test(event.sig) ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at <= 0 ||
      !Number.isSafeInteger(event.kind) ||
      typeof event.content !== "string" ||
      !Array.isArray(event.tags) ||
      event.tags.some(
        (tag) =>
          !Array.isArray(tag) ||
          tag.length === 0 ||
          tag.some((value) => typeof value !== "string")
      )
    ) {
      return false
    }
    if (computeEventId(event) !== event.id.toLowerCase()) return false
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey)
    )
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function parseProductAddress(value: string): {
  merchantPubkey: string
  dTag: string
} | null {
  const match = /^30402:([0-9a-f]{64}):/.exec(value)
  if (!match) return null
  const dTag = value.slice(match[0].length)
  if (
    dTag.length === 0 ||
    dTag.length > 128 ||
    Array.from(dTag).some((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  ) {
    return null
  }
  return { merchantPubkey: match[1]!.toLowerCase(), dTag }
}

export function parseAnonZapCheckoutIntent(
  value: unknown
): AnonZapCheckoutIntent | null {
  if (!isRecord(value)) return null
  if (
    !hasOnlyKeys(value, ["merchantPubkey", "amountMsats", "items"]) ||
    typeof value.merchantPubkey !== "string" ||
    !HEX_64.test(value.merchantPubkey) ||
    typeof value.amountMsats !== "number" ||
    !Number.isSafeInteger(value.amountMsats) ||
    value.amountMsats <= 0 ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > MAX_CART_ITEMS
  ) {
    return null
  }

  const merchantPubkey = value.merchantPubkey.toLowerCase()
  const seen = new Set<string>()
  const items: AnonZapCheckoutItem[] = []
  for (const rawItem of value.items) {
    if (!isRecord(rawItem)) return null
    if (
      !hasOnlyKeys(rawItem, ["productAddress", "quantity"]) ||
      typeof rawItem.productAddress !== "string" ||
      typeof rawItem.quantity !== "number" ||
      !Number.isSafeInteger(rawItem.quantity) ||
      rawItem.quantity < 1 ||
      rawItem.quantity > MAX_ITEM_QUANTITY
    ) {
      return null
    }
    const parsedAddress = parseProductAddress(rawItem.productAddress)
    if (!parsedAddress || parsedAddress.merchantPubkey !== merchantPubkey) {
      return null
    }
    const productAddress = `${PRODUCT_KIND}:${merchantPubkey}:${parsedAddress.dTag}`
    if (seen.has(productAddress)) return null
    seen.add(productAddress)
    items.push({ productAddress, quantity: rawItem.quantity })
  }

  return { merchantPubkey, amountMsats: value.amountMsats, items }
}

function getTagValue(tags: readonly string[][], name: string): string | null {
  return tags.find((tag) => tag[0] === name)?.[1] ?? null
}

function latestEvent(
  events: SignedPublicNostrEvent[],
  description: string
): SignedPublicNostrEvent {
  if (events.length === 0) throw new Error(`${description} is unavailable.`)
  const newestCreatedAt = Math.max(...events.map((event) => event.created_at))
  const newest = events.filter((event) => event.created_at === newestCreatedAt)
  if (new Set(newest.map((event) => event.id)).size !== 1) {
    throw new Error(`${description} has conflicting latest events.`)
  }
  return newest[0]!
}

function isDeleted(
  event: SignedPublicNostrEvent,
  productAddress: string,
  deletionEvents: SignedPublicNostrEvent[]
): boolean {
  return deletionEvents.some((deletion) => {
    if (deletion.created_at < event.created_at) return false
    return deletion.tags.some(
      (tag) =>
        (tag[0] === "e" && tag[1] === event.id) ||
        (tag[0] === "a" && tag[1] === productAddress)
    )
  })
}

function isAllowedRelayUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
    return (
      (url.protocol === "wss:" || (url.protocol === "ws:" && local)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

function assertLnurlMetadata(
  metadata: LnurlPayMetadata,
  amountMsats: number
): asserts metadata is LnurlPayMetadata & { nostrPubkey: string } {
  if (!metadata.allowsNostr || !metadata.nostrPubkey) {
    throw new Error("Merchant Lightning Address does not support public zaps.")
  }
  if (!HEX_64.test(metadata.nostrPubkey)) {
    throw new Error("Merchant Lightning Address has an invalid receipt pubkey.")
  }
  if (
    !Number.isSafeInteger(metadata.minSendable) ||
    !Number.isSafeInteger(metadata.maxSendable) ||
    metadata.minSendable <= 0 ||
    metadata.maxSendable < metadata.minSendable ||
    amountMsats < metadata.minSendable ||
    amountMsats > metadata.maxSendable
  ) {
    throw new Error("Checkout amount is outside the merchant LNURL range.")
  }
  if (!/^lnurl/i.test(metadata.lnurl)) {
    throw new Error("Merchant Lightning Address returned an invalid LNURL.")
  }
  try {
    const callback = new URL(metadata.callback)
    if (
      callback.protocol !== "https:" ||
      callback.username ||
      callback.password
    ) {
      throw new Error()
    }
  } catch {
    throw new Error("Merchant Lightning Address returned an invalid callback.")
  }
}

function getProfileLud16(event: SignedPublicNostrEvent): string | null {
  try {
    const content = JSON.parse(event.content) as unknown
    if (!isRecord(content) || typeof content.lud16 !== "string") return null
    const lud16 = content.lud16.trim().toLowerCase()
    const match = /^([^@]+)@([^@]+)$/.exec(lud16)
    if (!match) return null
    return lud16
  } catch {
    return null
  }
}

function getExpectedLnurlPayRequestUrl(lud16: string): string | null {
  const [user, domain] = lud16.split("@")
  if (!user || !domain) return null
  return `https://${domain}/.well-known/lnurlp/${user}`
}

export function resolveAnonZapMerchantLud16(
  merchantPubkey: string,
  profileEvents: SignedPublicNostrEvent[]
): string {
  const profiles = profileEvents.filter(
    (event) =>
      event.kind === PROFILE_KIND &&
      event.pubkey === merchantPubkey &&
      isValidSignedPublicNostrEvent(event)
  )
  const lud16 = getProfileLud16(latestEvent(profiles, "Merchant profile"))
  if (!lud16) throw new Error("Merchant Lightning Address is unavailable.")
  return lud16
}

export function authorizeAnonZapCheckout(input: {
  intent: AnonZapCheckoutIntent
  productEvents: SignedPublicNostrEvent[]
  profileEvents: SignedPublicNostrEvent[]
  deletionEvents: SignedPublicNostrEvent[]
  lnurlMetadata: LnurlPayMetadata
  receiptRelayUrls: readonly string[]
  nowSeconds?: number
}): AuthorizedAnonZapCheckout {
  const { intent } = input
  const validEvents = [
    ...input.productEvents,
    ...input.profileEvents,
    ...input.deletionEvents,
  ].filter(isValidSignedPublicNostrEvent)
  const products = validEvents.filter(
    (event) =>
      event.kind === PRODUCT_KIND && event.pubkey === intent.merchantPubkey
  )
  const profiles = validEvents.filter(
    (event) =>
      event.kind === PROFILE_KIND && event.pubkey === intent.merchantPubkey
  )
  const deletions = validEvents.filter(
    (event) =>
      event.kind === DELETION_KIND && event.pubkey === intent.merchantPubkey
  )

  let expectedSats = 0
  let itemCount = 0
  for (const item of intent.items) {
    const address = parseProductAddress(item.productAddress)
    if (!address) throw new Error("Checkout product reference is invalid.")
    const candidates = products.filter(
      (event) => getTagValue(event.tags, "d") === address.dTag
    )
    const event = latestEvent(candidates, "Checkout product")
    if (isDeleted(event, item.productAddress, deletions)) {
      throw new Error("Checkout product is no longer active.")
    }

    const product = parseProductEvent(event)
    const safety = evaluateListingSafety(product)
    if (!safety.purchasable || product.visibility !== "public") {
      throw new Error("Checkout product is not active for purchase.")
    }
    if (!product.publicZapPolicyKnown || !product.publicZapEnabled) {
      throw new Error("Checkout product does not explicitly allow public zaps.")
    }
    if (
      typeof product.priceSats !== "number" ||
      !Number.isSafeInteger(product.priceSats) ||
      product.priceSats < 1
    ) {
      throw new Error("Checkout product price cannot be verified in sats.")
    }
    if (typeof product.stock === "number" && item.quantity > product.stock) {
      throw new Error("Checkout quantity exceeds available stock.")
    }

    let shippingSats = 0
    if (product.format === "physical") {
      if (
        typeof product.shippingCostSats !== "number" ||
        !Number.isSafeInteger(product.shippingCostSats) ||
        product.shippingCostSats < 0 ||
        (product.shippingCountryRules?.length ?? 0) === 0
      ) {
        throw new Error(
          "Checkout product requires merchant-coordinated shipping."
        )
      }
      shippingSats = product.shippingCostSats
    }
    expectedSats += (product.priceSats + shippingSats) * item.quantity
    itemCount += item.quantity
    if (!Number.isSafeInteger(expectedSats)) {
      throw new Error("Checkout amount is too large.")
    }
  }

  if (expectedSats * 1000 !== intent.amountMsats) {
    throw new Error("Checkout amount does not match current product pricing.")
  }

  const lud16 = resolveAnonZapMerchantLud16(intent.merchantPubkey, profiles)
  const expectedPayRequestUrl = getExpectedLnurlPayRequestUrl(lud16)
  if (input.lnurlMetadata.payRequestUrl !== expectedPayRequestUrl) {
    throw new Error("Merchant Lightning Address metadata is invalid.")
  }
  assertLnurlMetadata(input.lnurlMetadata, intent.amountMsats)

  const relayUrls = Array.from(new Set(input.receiptRelayUrls))
  if (relayUrls.length === 0 || !relayUrls.every(isAllowedRelayUrl)) {
    throw new Error("Public zap receipt relays are not configured.")
  }
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    throw new Error("Checkout authorization timestamp is invalid.")
  }

  const draft: AnonZapRequestDraft = {
    kind: EVENT_KINDS.ZAP_REQUEST,
    createdAt: nowSeconds,
    content: `Zapped out ${
      itemCount === 1 ? "1 item" : `${itemCount} items`
    } on Conduit`,
    tags: [
      ["p", intent.merchantPubkey],
      ["amount", String(intent.amountMsats)],
      ["lnurl", input.lnurlMetadata.lnurl],
      ["relays", ...relayUrls],
      ["omf", "zapout"],
      ["client", "conduit-market"],
    ],
  }

  return {
    draft,
    authorization: {
      merchantPubkey: intent.merchantPubkey,
      amountMsats: intent.amountMsats,
      lnurl: input.lnurlMetadata.lnurl,
      publicZapPolicy: "anonymous_public_zap_allowed",
    },
    lnurlCallback: input.lnurlMetadata.callback,
    lnurlNostrPubkey: input.lnurlMetadata.nostrPubkey.toLowerCase(),
    relayUrls,
  }
}
