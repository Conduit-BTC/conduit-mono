import { normalizePublicWebSocketUrl } from "../network-target-safety"
import { buildAnonZapCheckoutContent } from "./anon-zap-checkout"
import {
  encodeLnurl,
  normalizeSafeLnurlPayRequestUrl,
  validateZapInvoiceDescriptionBinding,
} from "./lightning"
import {
  isValidNostrPublicKey,
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

/** Historical shopper-signed approval; its digest remains byte-identical. */
export interface CheckoutSparkShopperPublicZapPolicy {
  readonly schemaVersion: 1
  readonly signerPubkey: string
  readonly relays: readonly string[]
  readonly content: ""
  readonly allowPrivateFallback: true
}

/** Existing checkout-only service signer, distinct from the private buyer key. */
export interface CheckoutSparkAnonymousPublicZapPolicy {
  readonly schemaVersion: 2
  readonly signerKind: "anonymous_service"
  readonly signerPubkey: string
  readonly authorizationDigest: string
  readonly relays: readonly string[]
  readonly content: string
  readonly allowPrivateFallback: true
}

export type CheckoutSparkMerchantPublicZapPolicy =
  CheckoutSparkShopperPublicZapPolicy | CheckoutSparkAnonymousPublicZapPolicy

/** Exact selected candidate, retained privately with its immutable payout. */
export interface CheckoutSparkPublicZapContext {
  readonly schemaVersion: 1
  readonly requestJson: string
  readonly requestId: string
  readonly requestCreatedAt: number
  readonly recipientPubkey: string
  readonly receiptPubkey: string
  readonly lnurl: string
  readonly callback: string
  readonly payRequestUrl: string
}

export function freezeCheckoutSparkMerchantPublicZapPolicy(
  input: CheckoutSparkMerchantPublicZapPolicy
): CheckoutSparkMerchantPublicZapPolicy {
  if (
    !input ||
    (input.schemaVersion !== 1 && input.schemaVersion !== 2) ||
    !isValidNostrPublicKey(input.signerPubkey) ||
    input.signerPubkey !== input.signerPubkey.toLowerCase() ||
    (input.schemaVersion === 1 && input.content !== "") ||
    input.allowPrivateFallback !== true ||
    !Array.isArray(input.relays) ||
    input.relays.length === 0 ||
    input.relays.length > 12
  ) {
    throw new Error("Checkout Spark public zap approval is invalid.")
  }
  if (input.schemaVersion === 2) {
    const match =
      /^Zapped out ([1-9]\d{0,3}) (?:item|items) at https:\/\/shop\.conduit\.market\/$/.exec(
        input.content
      )
    if (
      input.signerKind !== "anonymous_service" ||
      !/^[0-9a-f]{64}$/.test(input.authorizationDigest) ||
      !match ||
      Number(match[1]) > 4_950 ||
      input.content !== buildAnonZapCheckoutContent(Number(match[1]))
    )
      throw new Error(
        "Checkout Spark anonymous public zap approval is invalid."
      )
  }
  const relays = input.relays.map((relay) => {
    const normalized = normalizePublicWebSocketUrl(relay)
    if (!normalized || new URL(normalized).search || new URL(normalized).hash) {
      throw new Error("Checkout Spark public zap relay is invalid.")
    }
    return normalized.replace(/\/$/, "")
  })
  if (new Set(relays).size !== relays.length) {
    throw new Error("Checkout Spark public zap relays are duplicated.")
  }
  return input.schemaVersion === 1
    ? Object.freeze({
        schemaVersion: 1,
        signerPubkey: input.signerPubkey,
        relays: Object.freeze(relays),
        content: "",
        allowPrivateFallback: true,
      })
    : Object.freeze({
        schemaVersion: 2,
        signerKind: "anonymous_service",
        signerPubkey: input.signerPubkey,
        authorizationDigest: input.authorizationDigest,
        relays: Object.freeze(relays),
        content: input.content,
        allowPrivateFallback: true,
      })
}

export function checkoutSparkMerchantPublicZapPolicyDigestValue(
  input: CheckoutSparkMerchantPublicZapPolicy
): unknown {
  const policy = freezeCheckoutSparkMerchantPublicZapPolicy(input)
  if (policy.schemaVersion === 2)
    return [
      "conduit:checkout-spark-merchant-public-zap:v2",
      policy.signerKind,
      policy.signerPubkey,
      policy.authorizationDigest,
      policy.relays,
      policy.content,
      policy.allowPrivateFallback,
    ]
  return [
    "conduit:checkout-spark-merchant-public-zap:v1",
    policy.signerPubkey,
    policy.relays,
    policy.content,
    policy.allowPrivateFallback,
  ]
}

function requestTags(
  recipient: string,
  amountMsats: number,
  lnurl: string,
  relays: readonly string[]
): string[][] {
  return [
    ["p", recipient],
    ["amount", String(amountMsats)],
    ["lnurl", lnurl],
    ["relays", ...relays],
    ["omf", "zapout"],
    ["client", "conduit-market"],
  ]
}

function matchesPolicyTags(
  tags: string[][],
  baseTags: string[][],
  policy: CheckoutSparkMerchantPublicZapPolicy
): boolean {
  if (policy.schemaVersion === 1)
    return JSON.stringify(tags) === JSON.stringify(baseTags)
  const attestation = tags.at(-1)
  return (
    tags.length === baseTags.length + 1 &&
    attestation?.[0] === "omf_auth" &&
    attestation.length === 3 &&
    /^[A-Za-z0-9_-]{1,32}$/.test(attestation[1] ?? "") &&
    /^[0-9a-f]{128}$/.test(attestation[2] ?? "") &&
    JSON.stringify(tags.slice(0, -1)) === JSON.stringify(baseTags)
  )
}

/** Revalidation, not a payment receipt or device-local invoice-origin proof. */
export function restoreCheckoutSparkPublicZapContext(
  input: CheckoutSparkPublicZapContext,
  expected: {
    policy: CheckoutSparkMerchantPublicZapPolicy
    recipientPubkey: string
    lud16: string
    amountSats: number
    paymentRequest: string
    preparedAt: number
    planCreatedAt?: number
  }
): CheckoutSparkPublicZapContext {
  const policy = freezeCheckoutSparkMerchantPublicZapPolicy(expected.policy)
  const address = expected.lud16.trim().toLowerCase().split("@")
  const payRequestUrl = `https://${address[1]}/.well-known/lnurlp/${address[0]}`
  if (
    !input ||
    input.schemaVersion !== 1 ||
    typeof input.requestJson !== "string" ||
    input.requestJson.length > 16_384 ||
    input.recipientPubkey !== expected.recipientPubkey ||
    !isValidNostrPublicKey(input.receiptPubkey) ||
    input.receiptPubkey !== input.receiptPubkey.toLowerCase() ||
    input.payRequestUrl !== payRequestUrl ||
    input.lnurl !== encodeLnurl(payRequestUrl) ||
    normalizeSafeLnurlPayRequestUrl(input.callback) !== input.callback ||
    !Number.isSafeInteger(input.requestCreatedAt) ||
    input.requestCreatedAt < 0 ||
    input.requestCreatedAt * 1_000 > expected.preparedAt ||
    input.requestCreatedAt < Math.floor((expected.planCreatedAt ?? 0) / 1_000)
  ) {
    throw new Error("Checkout Spark public zap context is invalid.")
  }
  let request: SignedPublicNostrEvent
  try {
    request = JSON.parse(input.requestJson) as SignedPublicNostrEvent
  } catch {
    throw new Error("Checkout Spark public zap request is invalid.")
  }
  if (
    !isValidSignedPublicNostrEvent(request) ||
    Object.keys(request).length !== 7 ||
    Object.keys(request).some(
      (key) =>
        ![
          "id",
          "pubkey",
          "created_at",
          "kind",
          "tags",
          "content",
          "sig",
        ].includes(key)
    ) ||
    request.id !== input.requestId ||
    request.pubkey !== policy.signerPubkey ||
    request.kind !== 9734 ||
    request.created_at !== input.requestCreatedAt ||
    request.content !== policy.content ||
    !matchesPolicyTags(
      request.tags,
      requestTags(
        expected.recipientPubkey,
        expected.amountSats * 1_000,
        input.lnurl,
        policy.relays
      ),
      policy
    ) ||
    !validateZapInvoiceDescriptionBinding({
      invoice: expected.paymentRequest,
      zapRequestJson: input.requestJson,
    }).ok
  ) {
    throw new Error("Checkout Spark public zap request binding is invalid.")
  }
  return Object.freeze({
    schemaVersion: 1,
    requestJson: input.requestJson,
    requestId: request.id,
    requestCreatedAt: request.created_at,
    recipientPubkey: input.recipientPubkey,
    receiptPubkey: input.receiptPubkey,
    lnurl: input.lnurl,
    callback: input.callback,
    payRequestUrl: input.payRequestUrl,
  })
}
