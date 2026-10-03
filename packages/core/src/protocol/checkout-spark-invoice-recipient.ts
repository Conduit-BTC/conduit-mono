import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  decodeLightningInvoiceMetadata,
  getLightningInvoiceNetwork,
  isValidLightningInvoice,
} from "./lightning"
import { requireCheckoutSparkSettledExactOutgoingRequest } from "./checkout-spark-settled-outgoing-history"
import type { CheckoutSparkSettledOutgoingTarget } from "./checkout-spark-settled-outgoing"
import type { CheckoutSparkSettledPlan } from "./checkout-spark-settled-router"

const SOURCE = "coinos_account_lookup_v1" as const
const LOOKUP_TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 65_536

declare const invoiceRecipientBrand: unique symbol
export interface CheckoutSparkInvoiceRecipientProof {
  readonly [invoiceRecipientBrand]: true
}

/** Device-local provider observation; never accept this record from Nostr. */
export interface CheckoutSparkInvoiceRecipientRecord {
  readonly schemaVersion: 1
  readonly source: typeof SOURCE
  readonly legId: string
  readonly intentDigest: string
  readonly verifiedAt: number
}

export type CheckoutSparkInvoiceRecipientResult =
  | {
      readonly status: "verified"
      readonly proof: CheckoutSparkInvoiceRecipientProof
    }
  | { readonly status: "unsupported" | "unavailable" | "conflicting" }

export interface CheckoutSparkInvoiceRecipientInput {
  readonly plan: CheckoutSparkSettledPlan
  readonly target: CheckoutSparkSettledOutgoingTarget
  /** Observation time in milliseconds; a paid invoice may already be expired. */
  readonly now: number
  readonly assertCurrent: () => void
}

export interface CheckoutSparkInvoiceRecipientDependencies {
  /** Trusted transport seam. Return the provider's canonical JSON, not a claim. */
  readonly fetchInvoiceRecord?: (
    url: string,
    options: { readonly signal: AbortSignal }
  ) => Promise<unknown>
}

const proofs = new WeakMap<
  CheckoutSparkInvoiceRecipientProof,
  { readonly intentDigest: string; readonly verifiedAt: number }
>()

function intentDigest(
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget
): string {
  const exact = requireCheckoutSparkSettledExactOutgoingRequest(plan, target)
  const recipient = plan.recipients.find((leg) => leg.legId === target.legId)!
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          "conduit.checkout-spark.provider-invoice-recipient.v1",
          SOURCE,
          plan.checkoutId,
          plan.planDigest,
          plan.merchantPubkey,
          plan.orderId,
          plan.walletId,
          target.legId,
          target.recipientId,
          target.allocationSats,
          recipient.kind,
          recipient.destination.type,
          recipient.destination.value,
          exact.network,
          exact.transferId,
          exact.paymentRequest,
          target.intent.paymentHash,
          exact.amountSats,
          exact.maxFeeSats,
          target.intent.preparedAt,
        ])
      )
    )
  )
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function fetchInvoiceRecord(
  url: string,
  options: { readonly signal: AbortSignal }
): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
    signal: options.signal,
  })
  if (
    !response.ok ||
    response.redirected ||
    (response.url && response.url !== url) ||
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json") ||
    Number(response.headers.get("content-length") ?? "0") >
      MAX_RESPONSE_BYTES ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error("Checkout recipient lookup is unavailable.")
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let length = 0
  let json = ""
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_RESPONSE_BYTES || options.signal.aborted) {
        throw new Error("Checkout recipient lookup is unavailable.")
      }
      json += decoder.decode(part.value, { stream: true })
    }
    return JSON.parse(json + decoder.decode()) as unknown
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * A narrow Coinos compatibility adapter, not a generic LNURL receipt. It checks
 * recipient attribution only; the caller must separately verify Spark payment,
 * exact debit, fees and preimage before declaring a leg paid or notifying it.
 */
export async function verifyCheckoutSparkInvoiceRecipient(
  input: CheckoutSparkInvoiceRecipientInput,
  dependencies: CheckoutSparkInvoiceRecipientDependencies = {}
): Promise<CheckoutSparkInvoiceRecipientResult> {
  input.assertCurrent()
  let digest: string
  let username: string
  try {
    digest = intentDigest(input.plan, input.target)
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < input.target.intent.preparedAt ||
      !Number.isSafeInteger(input.target.intent.preparedAt) ||
      input.target.intent.preparedAt < input.plan.createdAt ||
      !isValidLightningInvoice(input.target.intent.paymentRequest) ||
      getLightningInvoiceNetwork(input.target.intent.paymentRequest) !==
        input.plan.network ||
      decodeLightningInvoiceMetadata(input.target.intent.paymentRequest)
        .msats !==
        input.target.intent.invoiceAmountSats * 1_000
    ) {
      return { status: "conflicting" }
    }
    const recipient = input.plan.recipients.find(
      (leg) => leg.legId === input.target.legId
    )!
    const match = /^([a-z0-9._-]+)@coinos\.io$/i.exec(
      recipient.destination.value
    )
    if (input.plan.network !== "mainnet" || !match) {
      return { status: "unsupported" }
    }
    username = match[1]!.toLowerCase()
  } catch {
    return { status: "conflicting" }
  }

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let record: unknown
  try {
    const unavailable = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new Error("Checkout recipient lookup timed out."))
      }, LOOKUP_TIMEOUT_MS)
    })
    record = await Promise.race([
      (dependencies.fetchInvoiceRecord ?? fetchInvoiceRecord)(
        `https://coinos.io/api/invoice/${encodeURIComponent(input.target.intent.paymentRequest)}`,
        { signal: controller.signal }
      ),
      unavailable,
    ])
  } catch {
    input.assertCurrent()
    return { status: "unavailable" }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
  input.assertCurrent()
  // The caller's plan/intent may have changed while the provider was loading.
  try {
    if (digest !== intentDigest(input.plan, input.target)) {
      return { status: "conflicting" }
    }
  } catch {
    return { status: "conflicting" }
  }
  const invoice = object(record)
  const user = object(invoice?.user)
  if (
    !invoice ||
    !user ||
    invoice.type !== "lightning" ||
    invoice.text !== input.target.intent.paymentRequest ||
    invoice.hash !== input.target.intent.paymentRequest ||
    invoice.paymentHash !== input.target.intent.paymentHash ||
    !Number.isSafeInteger(invoice.amount) ||
    invoice.amount !== input.target.intent.invoiceAmountSats ||
    typeof invoice.uid !== "string" ||
    invoice.uid.length === 0 ||
    invoice.uid !== user.id ||
    typeof user.username !== "string" ||
    user.username.toLowerCase() !== username
  ) {
    return { status: "conflicting" }
  }
  const proof = Object.freeze({}) as CheckoutSparkInvoiceRecipientProof
  proofs.set(
    proof,
    Object.freeze({ intentDigest: digest, verifiedAt: input.now })
  )
  return { status: "verified", proof }
}

/** Persist only this opaque digest record, never the provider's invoice/user. */
export function createCheckoutSparkInvoiceRecipientRecord(
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget,
  proof: CheckoutSparkInvoiceRecipientProof
): CheckoutSparkInvoiceRecipientRecord {
  const observation = proofs.get(proof)
  const digest = intentDigest(plan, target)
  if (!observation || observation.intentDigest !== digest) {
    throw new Error("Checkout invoice recipient proof is unavailable.")
  }
  return {
    schemaVersion: 1,
    source: SOURCE,
    legId: target.legId,
    intentDigest: digest,
    verifiedAt: observation.verifiedAt,
  }
}

/** Accept only records read from this device's trusted verification storage. */
export function hasCheckoutSparkInvoiceRecipient(
  record: CheckoutSparkInvoiceRecipientRecord | undefined,
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget
): boolean {
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.source !== SOURCE ||
    record.legId !== target.legId ||
    !Number.isSafeInteger(record.verifiedAt) ||
    record.verifiedAt < target.intent.preparedAt
  ) {
    return false
  }
  try {
    return record.intentDigest === intentDigest(plan, target)
  } catch {
    return false
  }
}
