import { bytesToHex } from "@noble/hashes/utils.js"
import { sha256 } from "@noble/hashes/sha2.js"
import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"
import {
  normalizeLightningInvoice,
  isValidLightningInvoice,
  getLightningInvoiceNetwork,
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
} from "./lightning"

export const HEX_64 = /^[0-9a-f]{64}$/

const COMPRESSED_PUBKEY = /^(02|03)[0-9a-f]{64}$/

const MAX_ID_LENGTH = 512

const MAX_REQUEST_LENGTH = 16_384

export function digest(value: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))))
}

export function text(
  value: string,
  label: string,
  limit = MAX_ID_LENGTH
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > limit ||
    value.trim() !== value
  ) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

export function hex(value: string, label: string): string {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

export function compressedPublicKey(value: string, label: string): string {
  if (typeof value !== "string" || !COMPRESSED_PUBKEY.test(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

export function sats(value: number, label: string, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

export function time(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

export function normalizeInvoice(input: {
  paymentRequest: string
  paymentHash: string
  amountSats: number
  network: CheckoutSparkNetwork
  at: number
}): { paymentRequest: string; paymentHash: string; expiresAt: number } {
  const paymentRequest = text(
    normalizeLightningInvoice(input.paymentRequest).toLowerCase(),
    "Checkout Spark invoice",
    MAX_REQUEST_LENGTH
  )
  if (
    !isValidLightningInvoice(paymentRequest) ||
    getLightningInvoiceNetwork(paymentRequest) !== input.network
  ) {
    throw new Error("Checkout Spark invoice network or signature is invalid.")
  }
  const metadata = decodeLightningInvoiceMetadata(paymentRequest)
  const expectedMsats = BigInt(input.amountSats) * 1_000n
  const expiresAt =
    metadata.expiresAt === null ? null : metadata.expiresAt * 1_000
  const paymentHash = hex(input.paymentHash, "Checkout Spark invoice hash")
  if (
    expectedMsats > BigInt(Number.MAX_SAFE_INTEGER) ||
    metadata.msats !== Number(expectedMsats) ||
    decodeLightningInvoicePaymentHash(paymentRequest) !== paymentHash ||
    expiresAt === null ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= input.at
  ) {
    throw new Error(
      "Checkout Spark invoice amount, hash, or expiry is invalid."
    )
  }
  return { paymentRequest, paymentHash, expiresAt }
}
