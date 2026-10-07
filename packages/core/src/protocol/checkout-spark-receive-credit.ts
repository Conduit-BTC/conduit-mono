import {
  decodeLightningInvoiceMetadata,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
  normalizeLightningInvoice,
} from "./lightning"

import type { CheckoutSparkNetwork } from "./checkout-spark-reconciliation"

const INVALID_PROOF_MESSAGE = "Spark checkout receive credit proof is invalid."
const COMPRESSED_PUBLIC_KEY = /^(02|03)[0-9a-f]{64}$/i
const PAYMENT_HASH = /^[0-9a-f]{64}$/i

export interface SparkCheckoutReceiveCreditCurrencyAmount {
  originalValue: number
  originalUnit: string
}

export interface SparkCheckoutReceiveCreditNativeReceive {
  id: string
  status: string
  network: string
  invoice: {
    encodedInvoice: string
    bitcoinNetwork: string
    paymentHash: string
    amount: SparkCheckoutReceiveCreditCurrencyAmount
    /** Provider-owned invoice times; absent on historical adapter snapshots. */
    createdAt?: string
    expiresAt?: string
  }
  transfer?: {
    sparkId?: string
    userRequestId?: string
    totalAmount: SparkCheckoutReceiveCreditCurrencyAmount
  }
}

export interface SparkCheckoutReceiveCreditNativeTransfer {
  id: string
  status: string
  totalValue: number
  transferDirection: string
  receiverIdentityPublicKey?: string
  userRequest?: { id: string }
  receivers?: Array<{
    identityPublicKey: string
    amountSats: number
    status: string
  }>
}

export type SparkCheckoutReceiveCreditExpectedReceive =
  | { mode: "ordinary_v3" }
  | { mode: "committed_quote_v4"; manifestTransferId: string }

/** The immutable request facts needed to prove one exact Spark receive. */
export interface SparkCheckoutReceiveCreditRequest {
  id: string
  network: CheckoutSparkNetwork
  paymentRequest: string
  paymentHash: string
  grossFundingSats: number
}

export interface SparkCheckoutReceiveCreditProofInput {
  expectedRequest: SparkCheckoutReceiveCreditRequest
  expectedReceive: SparkCheckoutReceiveCreditExpectedReceive
  walletIdentityPublicKey: string
  receive: SparkCheckoutReceiveCreditNativeReceive
  transfer: SparkCheckoutReceiveCreditNativeTransfer
}

export interface SparkCheckoutReceiveCreditProof {
  readonly mode: SparkCheckoutReceiveCreditExpectedReceive["mode"]
  readonly requestId: string
  readonly transferId: string
  readonly receiverIdentityPublicKey: string
  readonly grossSats: number
  readonly creditedSats: number
}

export interface SparkCheckoutReceiveFundingTimeAnchor {
  readonly requestId: string
  readonly createdAtMs: number
  readonly expiresAtMs: number
  readonly invoiceCreatedAtMs: number
  readonly invoiceExpiresAtMs: number
}

// A serialized buyer record cannot restore this provider-observed capability.
const fundingTimeAnchors = new WeakMap<
  SparkCheckoutReceiveCreditProof,
  SparkCheckoutReceiveFundingTimeAnchor
>()

/** Available only on an exact receive proof from fresh native provider evidence. */
export function getSparkCheckoutReceiveFundingTimeAnchor(
  proof: SparkCheckoutReceiveCreditProof
): SparkCheckoutReceiveFundingTimeAnchor | null {
  return fundingTimeAnchors.get(proof) ?? null
}

export function proveSparkCheckoutReceiveCredit(
  input: SparkCheckoutReceiveCreditProofInput
): SparkCheckoutReceiveCreditProof {
  const invalidProof = (): never => {
    throw new Error(INVALID_PROOF_MESSAGE)
  }
  const parseSats = (
    amount: SparkCheckoutReceiveCreditCurrencyAmount | undefined
  ): number | null => {
    if (
      !amount ||
      !Number.isSafeInteger(amount.originalValue) ||
      amount.originalValue <= 0
    ) {
      return null
    }
    if (amount.originalUnit === "SATOSHI") {
      return amount.originalValue
    }
    if (
      amount.originalUnit === "MILLISATOSHI" &&
      amount.originalValue % 1_000 === 0
    ) {
      return amount.originalValue / 1_000
    }
    return null
  }
  const proof = (creditedSats: number): SparkCheckoutReceiveCreditProof => {
    const result = Object.freeze({
      mode: input.expectedReceive.mode,
      requestId: input.expectedRequest.id,
      transferId: input.transfer.id,
      receiverIdentityPublicKey: input.walletIdentityPublicKey.toLowerCase(),
      grossSats: input.expectedRequest.grossFundingSats,
      creditedSats,
    })
    if (timeAnchor) fundingTimeAnchors.set(result, timeAnchor)
    return result
  }

  const expectedNetwork = input.expectedRequest.network.toUpperCase()
  const expectedInvoice = normalizeLightningInvoice(
    input.expectedRequest.paymentRequest
  ).toLowerCase()
  const observedInvoice = normalizeLightningInvoice(
    input.receive.invoice.encodedInvoice
  ).toLowerCase()
  const expectedPaymentHash = input.expectedRequest.paymentHash.toLowerCase()
  const expectedGrossSats = input.expectedRequest.grossFundingSats
  const expectedInvoiceMetadata =
    decodeLightningInvoiceMetadata(expectedInvoice)
  const observedInvoiceMetadata =
    decodeLightningInvoiceMetadata(observedInvoice)
  const receiveInvoiceSats = parseSats(input.receive.invoice.amount)
  const settlingTransfer = input.receive.transfer
  const settlingTransferSats = parseSats(settlingTransfer?.totalAmount)
  let timeAnchor: SparkCheckoutReceiveFundingTimeAnchor | null = null
  if (
    !input.expectedRequest.id ||
    input.expectedRequest.id.trim() !== input.expectedRequest.id ||
    !COMPRESSED_PUBLIC_KEY.test(input.walletIdentityPublicKey) ||
    !PAYMENT_HASH.test(input.expectedRequest.paymentHash) ||
    !Number.isSafeInteger(expectedGrossSats) ||
    expectedGrossSats <= 0 ||
    !Number.isSafeInteger(expectedGrossSats * 1_000) ||
    !expectedInvoice ||
    expectedInvoice !== observedInvoice ||
    getLightningInvoiceNetwork(expectedInvoice) !==
      input.expectedRequest.network ||
    getLightningInvoiceNetwork(observedInvoice) !==
      input.expectedRequest.network ||
    decodeLightningInvoicePaymentHash(expectedInvoice) !==
      expectedPaymentHash ||
    decodeLightningInvoicePaymentHash(observedInvoice) !==
      expectedPaymentHash ||
    expectedInvoiceMetadata.msats !== expectedGrossSats * 1_000 ||
    observedInvoiceMetadata.msats !== expectedGrossSats * 1_000 ||
    input.receive.id !== input.expectedRequest.id ||
    input.receive.status !== "TRANSFER_COMPLETED" ||
    input.receive.network !== expectedNetwork ||
    input.receive.invoice.bitcoinNetwork !== expectedNetwork ||
    input.receive.invoice.paymentHash.toLowerCase() !== expectedPaymentHash ||
    receiveInvoiceSats !== expectedGrossSats ||
    !settlingTransfer?.sparkId ||
    settlingTransfer.userRequestId !== input.expectedRequest.id ||
    input.transfer.id !== settlingTransfer.sparkId ||
    input.transfer.userRequest?.id !== input.expectedRequest.id ||
    input.transfer.transferDirection !== "INCOMING" ||
    input.transfer.status !== "TRANSFER_STATUS_COMPLETED" ||
    !Number.isSafeInteger(input.transfer.totalValue) ||
    input.transfer.totalValue <= 0 ||
    settlingTransferSats !== input.transfer.totalValue ||
    input.transfer.totalValue > expectedGrossSats
  ) {
    return invalidProof()
  }

  const providerCreatedAt = input.receive.invoice.createdAt
  const providerExpiresAt = input.receive.invoice.expiresAt
  if (providerCreatedAt !== undefined || providerExpiresAt !== undefined) {
    const createdAtMs = Date.parse(providerCreatedAt ?? "")
    const expiresAtMs = Date.parse(providerExpiresAt ?? "")
    const invoiceCreatedAtMs =
      (observedInvoiceMetadata.createdAt ?? NaN) * 1_000
    const invoiceExpiresAtMs =
      (observedInvoiceMetadata.expiresAt ?? NaN) * 1_000
    if (
      typeof providerCreatedAt !== "string" ||
      typeof providerExpiresAt !== "string" ||
      !Number.isSafeInteger(createdAtMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      createdAtMs < 0 ||
      expiresAtMs <= createdAtMs ||
      !Number.isSafeInteger(invoiceCreatedAtMs) ||
      !Number.isSafeInteger(invoiceExpiresAtMs) ||
      Math.floor(createdAtMs / 1_000) * 1_000 !== invoiceCreatedAtMs ||
      Math.floor(expiresAtMs / 1_000) * 1_000 !== invoiceExpiresAtMs
    )
      return invalidProof()
    timeAnchor = Object.freeze({
      requestId: input.expectedRequest.id,
      createdAtMs,
      expiresAtMs,
      invoiceCreatedAtMs,
      invoiceExpiresAtMs,
    })
  }

  if (input.expectedReceive.mode === "ordinary_v3") {
    const walletIdentity = input.walletIdentityPublicKey.toLowerCase()
    const topLevelReceiverIdentity =
      input.transfer.receiverIdentityPublicKey?.toLowerCase()
    if (input.transfer.receivers === undefined) {
      if (topLevelReceiverIdentity !== walletIdentity) {
        return invalidProof()
      }
      return proof(input.transfer.totalValue)
    }

    const receiver = input.transfer.receivers[0]
    if (
      input.transfer.receivers.length !== 1 ||
      !receiver ||
      receiver.identityPublicKey.toLowerCase() !== walletIdentity ||
      receiver.status !== "TRANSFER_RECEIVER_STATUS_COMPLETED" ||
      !Number.isSafeInteger(receiver.amountSats) ||
      receiver.amountSats <= 0 ||
      receiver.amountSats !== input.transfer.totalValue ||
      (topLevelReceiverIdentity !== undefined &&
        topLevelReceiverIdentity !== walletIdentity)
    ) {
      return invalidProof()
    }
    return proof(receiver.amountSats)
  }

  if (
    input.expectedReceive.mode !== "committed_quote_v4" ||
    !input.expectedReceive.manifestTransferId ||
    input.expectedReceive.manifestTransferId !== input.transfer.id ||
    input.transfer.receivers === undefined ||
    input.transfer.receivers.length === 0
  ) {
    return invalidProof()
  }
  const seenReceiverIdentities = new Set<string>()
  let listedReceiverSats = 0n
  for (const receiver of input.transfer.receivers) {
    const identity = receiver.identityPublicKey.toLowerCase()
    if (
      !COMPRESSED_PUBLIC_KEY.test(identity) ||
      seenReceiverIdentities.has(identity) ||
      receiver.status !== "TRANSFER_RECEIVER_STATUS_COMPLETED" ||
      !Number.isSafeInteger(receiver.amountSats) ||
      receiver.amountSats <= 0
    ) {
      return invalidProof()
    }
    seenReceiverIdentities.add(identity)
    listedReceiverSats += BigInt(receiver.amountSats)
    if (listedReceiverSats > BigInt(input.transfer.totalValue)) {
      return invalidProof()
    }
  }
  const ownReceivers = input.transfer.receivers.filter(
    (candidate) =>
      candidate.identityPublicKey.toLowerCase() ===
      input.walletIdentityPublicKey.toLowerCase()
  )
  if (ownReceivers.length !== 1) {
    return invalidProof()
  }
  const ownReceiver = ownReceivers[0]!
  if (
    ownReceiver.status !== "TRANSFER_RECEIVER_STATUS_COMPLETED" ||
    !Number.isSafeInteger(ownReceiver.amountSats) ||
    ownReceiver.amountSats <= 0 ||
    ownReceiver.amountSats > input.transfer.totalValue ||
    ownReceiver.amountSats > expectedGrossSats
  ) {
    return invalidProof()
  }
  return proof(ownReceiver.amountSats)
}
