import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import {
  assertCheckoutSparkReceiverBinding,
  freezeCheckoutSparkReceiverBinding,
  observeCheckoutSparkReceiverCapability,
  type CheckoutSparkReceiverBinding,
  type CheckoutSparkReceiverDependencies,
} from "./checkout-spark-receiver-capability"
import {
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
  isValidLightningInvoice,
  normalizeLightningInvoice,
  validateZapInvoiceDescriptionBinding,
} from "./lightning"
import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"

export interface CheckoutSparkReceiverVerificationDependencies extends CheckoutSparkReceiverDependencies {
  readonly fetchVerify?: (
    url: string,
    options: { readonly signal: AbortSignal }
  ) => Promise<unknown>
}

export type CheckoutSparkReceiverVerificationResult =
  | { readonly status: "verified"; readonly settled: boolean }
  | { readonly status: "unsupported" | "unavailable" | "conflicting" }

const TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 65_536

async function fetchVerify(
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
    throw new Error("Checkout receiver verification is unavailable.")
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
      if (length > MAX_RESPONSE_BYTES || options.signal.aborted)
        throw new Error("Checkout receiver verification is unavailable.")
      json += decoder.decode(part.value, { stream: true })
    }
    return JSON.parse(json + decoder.decode()) as unknown
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Provider origin and exact LUD-21 settlement are distinct from Spark payment/debit proof. */
export async function verifyCheckoutSparkReceiverInvoice(
  input: {
    readonly binding: CheckoutSparkReceiverBinding
    readonly paymentRequest: string
    readonly paymentHash: string
    readonly amountSats: number
    readonly network: CheckoutSparkNetwork
    readonly publicRequestJson?: string
    readonly assertCurrent: () => void
  },
  dependencies: CheckoutSparkReceiverVerificationDependencies = {}
): Promise<CheckoutSparkReceiverVerificationResult> {
  input.assertCurrent()
  let binding: CheckoutSparkReceiverBinding
  const {
    paymentRequest,
    paymentHash,
    amountSats,
    network,
    publicRequestJson,
  } = input
  try {
    binding = freezeCheckoutSparkReceiverBinding(input.binding)
    if (
      normalizeLightningInvoice(paymentRequest).toLowerCase() !==
        paymentRequest ||
      !isValidLightningInvoice(paymentRequest) ||
      getLightningInvoiceNetwork(paymentRequest) !== network ||
      !Number.isSafeInteger(amountSats * 1_000) ||
      amountSats <= 0 ||
      decodeLightningInvoiceMetadata(paymentRequest).msats !==
        amountSats * 1_000 ||
      decodeLightningInvoicePaymentHash(paymentRequest) !== paymentHash ||
      !validateZapInvoiceDescriptionBinding({
        invoice: paymentRequest,
        zapRequestJson:
          binding.mode === "private"
            ? binding.metadata
            : (publicRequestJson ?? ""),
      }).ok
    )
      return { status: "conflicting" }
  } catch {
    return { status: "conflicting" }
  }
  const capability = await observeCheckoutSparkReceiverCapability(
    {
      lud16: binding.lud16,
      mode: binding.mode,
      assertCurrent: input.assertCurrent,
    },
    dependencies
  )
  if (capability.status !== "supported") return capability
  let contract
  try {
    contract = assertCheckoutSparkReceiverBinding(
      capability.capability,
      binding,
      paymentHash
    )
  } catch {
    return { status: "conflicting" }
  }
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let raw: unknown
  try {
    raw = await Promise.race([
      (dependencies.fetchVerify ?? fetchVerify)(binding.verifyUrl, {
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error("Checkout receiver verification timed out."))
        }, TIMEOUT_MS)
      }),
    ])
  } catch {
    input.assertCurrent()
    return { status: "unavailable" }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
  input.assertCurrent()
  const record =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined
  if (
    !record ||
    record.status !== "OK" ||
    typeof record.settled !== "boolean" ||
    record.pr !== paymentRequest ||
    (contract.binding === "verifier_recipient" &&
      record.recipient !== binding.lud16)
  )
    return { status: "conflicting" }
  if (record.settled) {
    if (
      typeof record.preimage !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(record.preimage) ||
      bytesToHex(sha256(hexToBytes(record.preimage))) !== paymentHash
    )
      return { status: "conflicting" }
  } else if (record.preimage !== null && record.preimage !== undefined)
    return { status: "conflicting" }
  return { status: "verified", settled: record.settled }
}
