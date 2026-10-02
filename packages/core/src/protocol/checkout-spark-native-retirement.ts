import type {
  CheckoutSparkNetwork,
  CheckoutSparkRetirementEvidence,
} from "./checkout-spark-reconciliation"

/** Pinned Spark 0.11 protobuf values, including internal swap transfer types. */
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
  input: CollectCheckoutSparkNativeRetirementEvidenceInput
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
          transfer.status !== 5 ||
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
    )
  )
    return null
  return history.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Success-only terminal observation, never proof of the expected payments by
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
    input.assertCurrent?.()
    const startedAt = input.now()
    if (!Number.isSafeInteger(startedAt) || startedAt < input.stateUpdatedAt)
      return null
    const reader = input.authenticatedReader
    const first = await readCompleteHistory(input)
    if (!first) return null
    const second = await readCompleteHistory(input)
    if (!second || JSON.stringify(first) !== JSON.stringify(second)) return null
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
