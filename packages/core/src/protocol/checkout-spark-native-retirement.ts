import type {
  CheckoutSparkNetwork,
  CheckoutSparkRetirementEvidence,
} from "./checkout-spark-reconciliation"
import {
  assertCheckoutSparkSettledClosedReturnedProof,
  type CheckoutSparkSettledClosedReturnedProof,
} from "./checkout-spark-settled-returned"

/** Pinned Spark protobuf values, including internal swap transfer types. */
type NativeTransferType = 0 | 1 | 2 | 3 | 4 | 5 | 30 | 40
const TRANSFER_TYPES: NativeTransferType[] = [0, 1, 2, 3, 4, 5, 30, 40]
const PAGE_SIZE = 100
const MAX_PAGES = 20

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value
  )
}

interface NativeTransfer {
  id: string
  type: number
  status: number
  network: number
  totalValue: number
}

/**
 * Structurally compatible with SparkReadonlyClient, without importing its SDK.
 * The caller MUST create an authenticated exact-wallet/network reader and
 * bound each read with a timeout. Public privacy-filtered readers are unsafe.
 */
export interface CheckoutSparkNativeRetirementReader {
  getTransfers(input: {
    sparkAddress: string
    types: NativeTransferType[]
    limit: number
    offset: number
  }): Promise<{ transfers: NativeTransfer[]; offset: number }>
  getPendingTransfers(sparkAddress: string): Promise<NativeTransfer[]>
  getAvailableBalance(sparkAddress: string): Promise<bigint>
  getOwnedBalance(sparkAddress: string): Promise<bigint>
}

export interface CollectCheckoutSparkNativeRetirementEvidenceInput {
  authenticatedReader: CheckoutSparkNativeRetirementReader
  walletId: string
  network: CheckoutSparkNetwork
  /** Caller-verified address of the exact frozen checkout wallet. */
  sparkAddress: string
  stateUpdatedAt: number
  /** Exact funding + every payout, already independently verified successful. */
  expectedTransferIds: readonly string[]
  /** Separate fresh terminal-only proof for each exact archived returned ID. */
  closedReturnedProofs?: readonly CheckoutSparkSettledClosedReturnedProof[]
  /** V4 cleanup must retain recovery for any unattributed provider activity. */
  requireExactHistoryScope?: true
  now: () => number
  assertCurrent?: () => void
}

async function guardedRead<T>(
  input: CollectCheckoutSparkNativeRetirementEvidenceInput,
  read: () => Promise<T>
): Promise<T> {
  input.assertCurrent?.()
  const result = await read()
  input.assertCurrent?.()
  return result
}

async function readCompleteHistory(
  input: CollectCheckoutSparkNativeRetirementEvidenceInput,
  closedReturns: ReadonlyMap<string, number>
): Promise<NativeTransfer[] | null> {
  const history: NativeTransfer[] = []
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await guardedRead(input, () =>
      input.authenticatedReader.getTransfers({
        sparkAddress: input.sparkAddress,
        types: [...TRANSFER_TYPES],
        limit: PAGE_SIZE,
        offset,
      })
    )
    if (
      !result ||
      !Array.isArray(result.transfers) ||
      result.transfers.length > PAGE_SIZE
    )
      return null
    if (
      !Number.isSafeInteger(result.offset) ||
      (result.offset >= 0 && result.offset <= offset)
    )
      return null
    if (
      result.transfers.some(
        (transfer) =>
          !transfer ||
          (closedReturns.has(transfer.id)
            ? transfer.type !== 0 ||
              ![6, 7].includes(transfer.status) ||
              transfer.totalValue !== closedReturns.get(transfer.id)
            : transfer.status !== 5) ||
          !TRANSFER_TYPES.includes(transfer.type as NativeTransferType) ||
          transfer.network !== (input.network === "mainnet" ? 1 : 2) ||
          !isIdentifier(transfer.id) ||
          !Number.isSafeInteger(transfer.totalValue) ||
          transfer.totalValue < 0
      )
    )
      return null
    history.push(
      ...result.transfers.map(({ id, type, status, network, totalValue }) => ({
        id,
        type,
        status,
        network,
        totalValue,
      }))
    )
    offset = result.offset
    if (offset < 0) break
  }
  if (
    offset >= 0 ||
    new Set(history.map((transfer) => transfer.id)).size !== history.length ||
    input.expectedTransferIds.some(
      (id) => !history.some((transfer) => transfer.id === id)
    ) ||
    [...closedReturns.keys()].some(
      (id) => !history.some((transfer) => transfer.id === id)
    )
  )
    return null
  return history.sort((left, right) => left.id.localeCompare(right.id))
}

/** Exact checkout-attributed pre-send scope, not a wallet sweep authorization. */
export async function proveCheckoutSparkNativeTreasuryHistory(
  input: CollectCheckoutSparkNativeRetirementEvidenceInput & {
    authorizedDebitSats: number
  }
): Promise<boolean> {
  try {
    if (
      !isIdentifier(input.walletId) ||
      !isIdentifier(input.sparkAddress) ||
      !["mainnet", "regtest"].includes(input.network) ||
      !Number.isSafeInteger(input.authorizedDebitSats) ||
      input.authorizedDebitSats < 0 ||
      !Number.isSafeInteger(input.stateUpdatedAt) ||
      input.stateUpdatedAt < 0 ||
      !Array.isArray(input.expectedTransferIds) ||
      input.expectedTransferIds.length < 2 ||
      input.expectedTransferIds.length > PAGE_SIZE * MAX_PAGES ||
      input.expectedTransferIds.some((id) => !isIdentifier(id)) ||
      new Set(input.expectedTransferIds).size !==
        input.expectedTransferIds.length
    )
      return false
    input = { ...input, expectedTransferIds: [...input.expectedTransferIds] }
    const proofs = [...(input.closedReturnedProofs ?? [])]
    if (proofs.length > PAGE_SIZE * MAX_PAGES) return false
    const closed = new Map<string, number>()
    const verifyReturns = () => {
      const seen = new Set<string>()
      for (const proof of proofs) {
        const closure = assertCheckoutSparkSettledClosedReturnedProof(proof, {
          walletId: input.walletId,
          network: input.network,
          nowMs: input.now(),
        })
        if (
          seen.has(closure.transferId) ||
          input.expectedTransferIds.includes(closure.transferId)
        )
          throw new Error("Invalid closed scope")
        seen.add(closure.transferId)
        closed.set(closure.transferId, closure.debitedSats)
      }
    }
    verifyReturns()
    input.assertCurrent?.()
    const startedAt = input.now()
    if (!Number.isSafeInteger(startedAt) || startedAt < input.stateUpdatedAt)
      return false
    const first = await readCompleteHistory(input, closed)
    const second = await readCompleteHistory(input, closed)
    if (
      !first ||
      !second ||
      JSON.stringify(first) !== JSON.stringify(second) ||
      first.some(
        (transfer) =>
          !input.expectedTransferIds.includes(transfer.id) &&
          !closed.has(transfer.id)
      )
    )
      return false
    const available = await guardedRead(input, () =>
      input.authenticatedReader.getAvailableBalance(input.sparkAddress)
    )
    const owned = await guardedRead(input, () =>
      input.authenticatedReader.getOwnedBalance(input.sparkAddress)
    )
    const pending = await guardedRead(input, () =>
      input.authenticatedReader.getPendingTransfers(input.sparkAddress)
    )
    input.assertCurrent?.()
    verifyReturns()
    return (
      available === BigInt(input.authorizedDebitSats) &&
      owned === available &&
      Array.isArray(pending) &&
      pending.length === 0
    )
  } catch {
    return false
  }
}

/**
 * Terminal observation, never proof of the expected payments by
 * itself. The caller first proves the exact funding/payout amounts and owners.
 * Two complete equal scans reject observed pagination races; neither a scan
 * nor zero funds proves the absence of future activity. Truncation, ambiguity,
 * errors, and authority changes retain recovery by returning null.
 */
export async function collectCheckoutSparkNativeRetirementEvidence(
  input: CollectCheckoutSparkNativeRetirementEvidenceInput
): Promise<CheckoutSparkRetirementEvidence | null> {
  try {
    if (
      !isIdentifier(input.walletId) ||
      !isIdentifier(input.sparkAddress) ||
      (input.network !== "mainnet" && input.network !== "regtest") ||
      !Number.isSafeInteger(input.stateUpdatedAt) ||
      input.stateUpdatedAt < 0 ||
      !Array.isArray(input.expectedTransferIds) ||
      input.expectedTransferIds.length < 2 ||
      input.expectedTransferIds.length > PAGE_SIZE * MAX_PAGES ||
      input.expectedTransferIds.some((id) => !isIdentifier(id)) ||
      new Set(input.expectedTransferIds).size !==
        input.expectedTransferIds.length
    )
      return null
    input = { ...input, expectedTransferIds: [...input.expectedTransferIds] }
    const closedProofs = [...(input.closedReturnedProofs ?? [])]
    if (closedProofs.length > PAGE_SIZE * MAX_PAGES) return null
    const closedReturns = new Map<string, number>()
    const requireFreshClosedReturns = () => {
      const observed = new Map<string, number>()
      for (const proof of closedProofs) {
        const closure = assertCheckoutSparkSettledClosedReturnedProof(proof, {
          walletId: input.walletId,
          network: input.network,
          nowMs: input.now(),
        })
        if (
          observed.has(closure.transferId) ||
          input.expectedTransferIds.includes(closure.transferId)
        )
          throw new Error(
            "Checkout Spark returned retirement scope is invalid."
          )
        observed.set(closure.transferId, closure.debitedSats)
      }
      return observed
    }
    for (const [id, debit] of requireFreshClosedReturns())
      closedReturns.set(id, debit)
    input.assertCurrent?.()
    const startedAt = input.now()
    if (!Number.isSafeInteger(startedAt) || startedAt < input.stateUpdatedAt)
      return null
    const reader = input.authenticatedReader
    const first = await readCompleteHistory(input, closedReturns)
    if (!first) return null
    const second = await readCompleteHistory(input, closedReturns)
    if (!second || JSON.stringify(first) !== JSON.stringify(second)) return null
    if (
      input.requireExactHistoryScope &&
      first.some(
        (transfer) =>
          !input.expectedTransferIds.includes(transfer.id) &&
          !closedReturns.has(transfer.id)
      )
    )
      return null
    const available = await guardedRead(input, () =>
      reader.getAvailableBalance(input.sparkAddress)
    )
    const owned = await guardedRead(input, () =>
      reader.getOwnedBalance(input.sparkAddress)
    )
    const pending = await guardedRead(input, () =>
      reader.getPendingTransfers(input.sparkAddress)
    )
    if (
      available !== 0n ||
      owned !== 0n ||
      !Array.isArray(pending) ||
      pending.length !== 0
    )
      return null
    const observedAt = input.now()
    if (
      !Number.isSafeInteger(observedAt) ||
      observedAt < startedAt ||
      observedAt <= input.stateUpdatedAt
    )
      return null
    input.assertCurrent?.()
    requireFreshClosedReturns()
    return {
      walletId: input.walletId,
      network: input.network,
      observedAt,
      availableSats: 0,
      ownedSats: 0,
      incomingSats: 0,
      fundingReceiveTerminal: true,
      sendHistoryTerminal: true,
      claimsTerminal: true,
      refundsTerminal: true,
    }
  } catch {
    // A failed provider read or revoked authority is not terminal evidence.
    return null
  }
}
