import { bytesToHex } from "@noble/hashes/utils.js"
import {
  decodeLightningInvoiceAmount,
  decodeLightningInvoicePaymentHash,
  getLightningInvoiceNetwork,
  isAmountlessLightningInvoice,
} from "./lightning"
import {
  readExactSparkLightningRecoveredTransfer,
  verifyExactSparkLightningRequestDebit,
} from "./spark-lightning-exact-history"
import type { CheckoutSparkSettledReturnedEvidence } from "./checkout-spark-settled-returned"

/** Initialized private wallet only. getLeaves may recover wallet keyshares. */
export interface SparkCheckoutLightningReturnedReader {
  getIdentityPublicKey(): Promise<string>
  getTransferFromSsp(id: string): Promise<unknown>
  getLightningSendRequest(id: string): Promise<unknown>
  queryHTLC?(input: {
    paymentHashes: string[]
    transferIds: string[]
    matchRole: 1
    limit: number
    offset: number
  }): Promise<unknown>
  getLeaves?(): Promise<unknown>
}

export interface SparkCheckoutLightningReturnedInspectionInput {
  network: "mainnet" | "regtest"
  transferId: string
  paymentRequest: string
  paymentHash: string
  amountSats: number
  maxFeeSats: number
  receiverIdentityPublicKey: string
  minimumAvailableSats: number
}

export type SparkCheckoutLightningReturnedInspection =
  | { status: "returned"; evidence: CheckoutSparkSettledReturnedEvidence }
  | { status: "unavailable" | "conflicting" | "not_closed" }

export type SparkCheckoutLightningClosedReturnedInspectionInput = Omit<
  SparkCheckoutLightningReturnedInspectionInput,
  "minimumAvailableSats"
>

/** Terminal history only. It cannot establish spendable funds or dispatch authority. */
export type SparkCheckoutLightningClosedReturnedEvidence = Omit<
  CheckoutSparkSettledReturnedEvidence,
  "availableSats" | "availableLeaves"
>

export type SparkCheckoutLightningClosedReturnedInspection =
  | {
      status: "closed_returned"
      evidence: SparkCheckoutLightningClosedReturnedEvidence
    }
  | { status: "unavailable" | "conflicting" | "not_closed" }

interface ReturnedInspectionOptions {
  now?: () => number
  assertCurrent?: () => void
  readTimeoutMs?: number
}

const returnedStatuses = new Set([
  "USER_SWAP_RETURNED",
  "LIGHTNING_PAYMENT_FAILED",
])
const paidStatuses = new Set([
  "LIGHTNING_PAYMENT_SUCCEEDED",
  "PREIMAGE_PROVIDED",
  "TRANSFER_COMPLETED",
])
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const sats = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const publicKey = (value: unknown): string | null =>
  value instanceof Uint8Array && value.length === 33 ? bytesToHex(value) : null
const nonemptyPreimage = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  !(typeof value === "string" && value.length === 0) &&
  !(value instanceof Uint8Array && value.length === 0)

class InspectionUnavailableError extends Error {}

/**
 * Inspect a positively returned exact attempt for an explicitly authorized
 * renewal. This is not a saved-only preview, a send, or permission to renew.
 * Absence, expiry alone, coarse failure and aggregate balance are insufficient.
 * Only narrow pinned-SDK public fields are retained; exceptions remain private.
 */
export async function inspectSparkCheckoutLightningReturnedAttempt(
  reader: SparkCheckoutLightningReturnedReader,
  input: SparkCheckoutLightningReturnedInspectionInput,
  options: ReturnedInspectionOptions = {}
): Promise<SparkCheckoutLightningReturnedInspection> {
  const result = await inspectReturnedAttempt(reader, input, options, true)
  return result.status === "closed_returned"
    ? { status: "unavailable" }
    : result
}

/**
 * Exact terminal return for retirement after a successor consumed the leaves.
 * No getLeaves/keyshare recovery, fee quote, or payment operation is performed.
 * The distinct result lacks the availability facts required to renew or send.
 */
export async function inspectSparkCheckoutLightningClosedReturnedAttempt(
  reader: SparkCheckoutLightningReturnedReader,
  input: SparkCheckoutLightningClosedReturnedInspectionInput,
  options: ReturnedInspectionOptions = {}
): Promise<SparkCheckoutLightningClosedReturnedInspection> {
  const result = await inspectReturnedAttempt(
    reader,
    { ...input, minimumAvailableSats: 0 },
    options,
    false
  )
  return result.status === "returned" ? { status: "unavailable" } : result
}

async function inspectReturnedAttempt(
  reader: SparkCheckoutLightningReturnedReader,
  input: SparkCheckoutLightningReturnedInspectionInput,
  options: ReturnedInspectionOptions,
  requireSpendableReturn: boolean
): Promise<
  | SparkCheckoutLightningReturnedInspection
  | SparkCheckoutLightningClosedReturnedInspection
> {
  const conflicting = { status: "conflicting" } as const
  const notClosed = { status: "not_closed" } as const
  const unavailable = { status: "unavailable" } as const
  const network = input.network === "mainnet" ? 1 : 2
  const networkName = input.network === "mainnet" ? "MAINNET" : "REGTEST"
  try {
    const readTimeoutMs = options.readTimeoutMs ?? 10_000
    if (
      !Number.isSafeInteger(readTimeoutMs) ||
      readTimeoutMs < 1 ||
      readTimeoutMs > 30_000
    )
      return unavailable
    if (
      !["mainnet", "regtest"].includes(input.network) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.transferId
      ) ||
      !/^(02|03)[0-9a-f]{64}$/.test(input.receiverIdentityPublicKey) ||
      !/^[0-9a-f]{64}$/.test(input.paymentHash) ||
      !sats(input.amountSats) ||
      input.amountSats === 0 ||
      !sats(input.maxFeeSats) ||
      !sats(input.minimumAvailableSats) ||
      isAmountlessLightningInvoice(input.paymentRequest) ||
      getLightningInvoiceNetwork(input.paymentRequest) !== input.network ||
      decodeLightningInvoicePaymentHash(input.paymentRequest) !==
        input.paymentHash ||
      decodeLightningInvoiceAmount(input.paymentRequest).msats !==
        input.amountSats * 1_000
    )
      return conflicting
    if (!reader.queryHTLC || (requireSpendableReturn && !reader.getLeaves))
      return unavailable
    const read = async <T>(operation: () => Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        options.assertCurrent?.()
        const result = await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new InspectionUnavailableError()),
              readTimeoutMs
            )
          }),
        ])
        options.assertCurrent?.()
        return result
      } catch {
        throw new InspectionUnavailableError()
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    const identity = await read(() => reader.getIdentityPublicKey())
    if (identity !== input.receiverIdentityPublicKey) return conflicting
    const rawTransfer = record(
      await read(() => reader.getTransferFromSsp(input.transferId))
    )
    if (!rawTransfer) return unavailable
    const recovered = readExactSparkLightningRecoveredTransfer({
      transferId: input.transferId,
      paymentRequest: input.paymentRequest,
      transfer: rawTransfer,
    })
    const rawRequest = record(
      await read(() => reader.getLightningSendRequest(recovered.request.id))
    )
    if (!rawRequest) return unavailable
    const fresh = readExactSparkLightningRecoveredTransfer({
      transferId: input.transferId,
      paymentRequest: input.paymentRequest,
      transfer: { ...rawTransfer, userRequest: rawRequest },
    })
    if (
      rawRequest.network !== networkName ||
      record(rawTransfer.userRequest)?.network !== networkName
    )
      return conflicting
    const debitedSats = verifyExactSparkLightningRequestDebit({
      requestId: recovered.request.id,
      amountSats: input.amountSats,
      maxFeeSats: input.maxFeeSats,
      totalAmount: recovered.totalAmount,
      request: fresh.request,
    })
    const initialDebit = verifyExactSparkLightningRequestDebit({
      requestId: recovered.request.id,
      amountSats: input.amountSats,
      maxFeeSats: input.maxFeeSats,
      totalAmount: recovered.totalAmount,
      request: recovered.request,
    })
    if (
      initialDebit !== debitedSats ||
      nonemptyPreimage(recovered.request.paymentPreimage) ||
      nonemptyPreimage(fresh.request.paymentPreimage) ||
      paidStatuses.has(fresh.request.status) ||
      paidStatuses.has(recovered.request.status)
    )
      return conflicting
    const requestTransfer = record(rawRequest.transfer)
    if (
      requestTransfer &&
      (requestTransfer.sparkId !== input.transferId ||
        verifyExactSparkLightningRequestDebit({
          requestId: recovered.request.id,
          amountSats: input.amountSats,
          maxFeeSats: input.maxFeeSats,
          totalAmount: requestTransfer.totalAmount as Parameters<
            typeof verifyExactSparkLightningRequestDebit
          >[0]["totalAmount"],
          request: fresh.request,
        }) !== debitedSats)
    )
      return conflicting
    if (
      !returnedStatuses.has(recovered.request.status) ||
      !returnedStatuses.has(fresh.request.status)
    )
      return notClosed
    const response = record(
      await read(() =>
        reader.queryHTLC!({
          paymentHashes: [input.paymentHash],
          transferIds: [input.transferId],
          matchRole: 1,
          limit: 2,
          offset: 0,
        })
      )
    )
    if (
      !response ||
      !Array.isArray(response.preimageRequests) ||
      response.offset !== -1
    )
      return unavailable
    if (response.preimageRequests.length !== 1)
      return response.preimageRequests.length > 1 ? conflicting : unavailable
    const htlc = record(response.preimageRequests[0])
    if (
      !htlc ||
      !(htlc.paymentHash instanceof Uint8Array) ||
      bytesToHex(htlc.paymentHash) !== input.paymentHash ||
      publicKey(htlc.senderIdentityPubkey) !== identity ||
      !publicKey(htlc.receiverIdentityPubkey)
    )
      return conflicting
    if (
      (htlc.preimage !== undefined && !(htlc.preimage instanceof Uint8Array)) ||
      nonemptyPreimage(htlc.preimage) ||
      htlc.status === 1
    )
      return conflicting
    if (htlc.status !== 2) return notClosed
    const transfer = record(htlc.transfer)
    if (
      !transfer ||
      transfer.id !== input.transferId ||
      transfer.network !== network ||
      transfer.type !== 0 ||
      !Array.isArray(transfer.senders) ||
      !Array.isArray(transfer.receivers) ||
      !Array.isArray(transfer.leaves)
    )
      return conflicting
    if (transfer.status === 5) return conflicting
    if (transfer.status !== 6 && transfer.status !== 7) return notClosed
    if (transfer.senders.length !== 1) return conflicting
    const sender = record(transfer.senders[0])
    if (
      !sender ||
      typeof sender.id !== "string" ||
      !sender.id ||
      publicKey(sender.identityPublicKey) !== identity
    )
      return conflicting
    const receivers = new Map<string, { identity: string; amount: number }>()
    for (const item of transfer.receivers) {
      const receiver = record(item)
      const receiverKey = publicKey(receiver?.identityPublicKey)
      if (
        !receiver ||
        typeof receiver.id !== "string" ||
        !receiver.id ||
        receivers.has(receiver.id) ||
        !receiverKey ||
        !sats(receiver.amountSats) ||
        receiver.amountSats <= 0
      )
        return conflicting
      if (receiver.status === 6) return conflicting
      if (receiver.status !== 7) return notClosed
      receivers.set(receiver.id, {
        identity: receiverKey,
        amount: receiver.amountSats,
      })
    }
    if (
      !receivers.size ||
      ![...receivers.values()].some(
        (receiver) =>
          receiver.identity === publicKey(htlc.receiverIdentityPubkey)
      )
    )
      return conflicting
    const returnedLeaves: { id: string; valueSats: number }[] = []
    const returnedIds = new Set<string>()
    const receiverAmounts = new Map<string, number>()
    for (const item of transfer.leaves) {
      const assignment = record(item)
      const leaf = record(assignment?.leaf)
      if (
        !assignment ||
        assignment.transferSenderId !== sender.id ||
        typeof assignment.transferReceiverId !== "string" ||
        !receivers.has(assignment.transferReceiverId) ||
        !leaf ||
        typeof leaf.id !== "string" ||
        !leaf.id ||
        returnedIds.has(leaf.id) ||
        !sats(leaf.value) ||
        leaf.value <= 0 ||
        leaf.network !== network ||
        publicKey(leaf.ownerIdentityPublicKey) !== identity
      )
        return conflicting
      returnedIds.add(leaf.id)
      returnedLeaves.push({ id: leaf.id, valueSats: leaf.value })
      receiverAmounts.set(
        assignment.transferReceiverId,
        (receiverAmounts.get(assignment.transferReceiverId) ?? 0) + leaf.value
      )
    }
    const returnedSats = returnedLeaves.reduce(
      (sum, leaf) => sum + leaf.valueSats,
      0
    )
    if (
      !returnedLeaves.length ||
      returnedSats !== debitedSats ||
      !sats(returnedSats) ||
      [...receivers].some(
        ([id, receiver]) => receiverAmounts.get(id) !== receiver.amount
      )
    )
      return conflicting
    const closureEvidence =
      (): SparkCheckoutLightningClosedReturnedEvidence | null => {
        const observedAt = (options.now ?? Date.now)()
        if (!sats(observedAt)) return null
        options.assertCurrent?.()
        return {
          network: input.network,
          walletIdentityPublicKey: identity,
          transferId: input.transferId,
          requestId: fresh.request.id,
          paymentRequest: input.paymentRequest,
          paymentHash: input.paymentHash,
          invoiceAmountSats: input.amountSats,
          maxFeeSats: input.maxFeeSats,
          debitedSats,
          returnedSats,
          sspStatus: fresh.request.status,
          operatorStatus: transfer.status === 7 ? "RETURNED" : "EXPIRED",
          htlcStatus: "RETURNED",
          preimage: null,
          returnedLeaves,
          observedAt,
        }
      }
    if (!requireSpendableReturn) {
      const evidence = closureEvidence()
      return evidence ? { status: "closed_returned", evidence } : unavailable
    }
    // Public getLeaves(false) excludes operator-disagreeing and non-AVAILABLE
    // leaves, and may recover keyshares. Never call it from passive history UI.
    const leaves = await read(() => reader.getLeaves!())
    if (!Array.isArray(leaves)) return unavailable
    const available = new Map<string, number>()
    for (const item of leaves) {
      const leaf = record(item)
      if (
        !leaf ||
        typeof leaf.id !== "string" ||
        !leaf.id ||
        available.has(leaf.id) ||
        !sats(leaf.value) ||
        leaf.value <= 0 ||
        leaf.network !== network ||
        publicKey(leaf.ownerIdentityPublicKey) !== identity
      )
        return conflicting
      if (leaf.status !== "AVAILABLE" || leaf.treenodeStatus !== 1)
        return notClosed
      available.set(leaf.id, leaf.value)
    }
    if (
      returnedLeaves.some((leaf) => available.get(leaf.id) !== leaf.valueSats)
    )
      return notClosed
    const availableSats = [...available.values()].reduce(
      (sum, amount) => sum + amount,
      0
    )
    if (!sats(availableSats) || availableSats < input.minimumAvailableSats)
      return notClosed
    const evidence = closureEvidence()
    if (!evidence) return unavailable
    return {
      status: "returned",
      evidence: {
        ...evidence,
        availableSats,
        availableLeaves: [...available].map(([id, valueSats]) => ({
          id,
          valueSats,
        })),
      },
    }
  } catch (error) {
    return error instanceof InspectionUnavailableError
      ? unavailable
      : conflicting
  }
}
