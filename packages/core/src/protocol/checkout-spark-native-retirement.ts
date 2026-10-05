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
  /** Raw authenticated participant/leaf facts are needed only for extra swaps. */
  senders?: unknown
  receivers?: unknown
  leaves?: unknown
}

interface SwapTransferFacts {
  senderId: string
  senderIdentity: string
  receiverId: string
  receiverIdentity: string
  receiverStatus: number
  receiverSats: number
  leaves: {
    id: string
    value: number
    senderId: string
    receiverId: string
  }[]
}

interface HistoryTransfer {
  id: string
  type: number
  status: number
  network: number
  totalValue: number
  swapFacts?: SwapTransferFacts
}

interface SwapRequestFacts {
  requestId: string
  walletIdentity: string
  sspIdentity: string
  network: CheckoutSparkNetwork
  outboundId: string
  inboundId: string
  value: number
  inboundLeafIds: string[]
}

export interface CheckoutSparkInternalSwapEvidence {
  /** Frozen, caller-validated exact checkout and configured SSP identities. */
  walletIdentityPublicKey: string
  sspIdentityPublicKey: string
  /** Unmodified first-party getTransferFromSsp response, validated here. */
  transfer: unknown
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
  getInternalSwapEvidence?(input: {
    sparkAddress: string
    transferId: string
  }): Promise<CheckoutSparkInternalSwapEvidence | null>
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

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function positiveSats(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function identity(value: unknown): string | null {
  return typeof value === "string" && /^(02|03)[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : null
}

function bytesIdentity(value: unknown): string | null {
  if (!(value instanceof Uint8Array) || value.length !== 33) return null
  return identity(
    Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")
  )
}

function satsAmount(value: unknown): number | null {
  const amount = object(value)
  return amount?.originalUnit === "SATOSHI" &&
    Number.isSafeInteger(amount.originalValue) &&
    (amount.originalValue as number) >= 0
    ? (amount.originalValue as number)
    : null
}

/** Snapshot only historical edge/value facts, never current owner or secrets. */
function snapshotSwapTransfer(
  transfer: NativeTransfer
): SwapTransferFacts | null {
  if (
    !Array.isArray(transfer.senders) ||
    transfer.senders.length !== 1 ||
    !Array.isArray(transfer.receivers) ||
    transfer.receivers.length !== 1 ||
    !Array.isArray(transfer.leaves) ||
    transfer.leaves.length < 1 ||
    transfer.leaves.length > PAGE_SIZE * MAX_PAGES
  )
    return null
  const sender = object(transfer.senders[0])
  const receiver = object(transfer.receivers[0])
  const senderIdentity = bytesIdentity(sender?.identityPublicKey)
  const receiverIdentity = bytesIdentity(receiver?.identityPublicKey)
  if (
    !sender ||
    !receiver ||
    !isIdentifier(sender.id) ||
    !isIdentifier(receiver.id) ||
    sender.id === receiver.id ||
    !senderIdentity ||
    !receiverIdentity ||
    senderIdentity === receiverIdentity ||
    receiver.status !== 6 ||
    !positiveSats(receiver.amountSats)
  )
    return null
  const leaves: SwapTransferFacts["leaves"] = []
  let sum = 0
  for (const raw of transfer.leaves) {
    const edge = object(raw)
    const leaf = object(edge?.leaf)
    if (
      !edge ||
      !leaf ||
      !isIdentifier(leaf.id) ||
      !positiveSats(leaf.value) ||
      edge.transferSenderId !== sender.id ||
      edge.transferReceiverId !== receiver.id
    )
      return null
    sum += leaf.value
    if (!Number.isSafeInteger(sum)) return null
    leaves.push({
      id: leaf.id,
      value: leaf.value,
      senderId: sender.id,
      receiverId: receiver.id,
    })
  }
  if (
    sum !== receiver.amountSats ||
    sum !== transfer.totalValue ||
    new Set(leaves.map(({ id }) => id)).size !== leaves.length
  )
    return null
  return {
    senderId: sender.id,
    senderIdentity,
    receiverId: receiver.id,
    receiverIdentity,
    receiverStatus: 6,
    receiverSats: receiver.amountSats,
    leaves: leaves.sort((left, right) => left.id.localeCompare(right.id)),
  }
}

function snapshotSwapRequest(
  evidence: CheckoutSparkInternalSwapEvidence,
  transfer: HistoryTransfer,
  network: CheckoutSparkNetwork
): SwapRequestFacts | null {
  const walletIdentity = identity(evidence.walletIdentityPublicKey)
  const sspIdentity = identity(evidence.sspIdentityPublicKey)
  const response = object(evidence.transfer)
  const request = object(response?.userRequest)
  const outbound = object(request?.outboundTransfer)
  const inbound = object(request?.inboundTransfer)
  if (
    !walletIdentity ||
    !sspIdentity ||
    walletIdentity === sspIdentity ||
    !response ||
    response.sparkId !== transfer.id ||
    satsAmount(response.totalAmount) !== transfer.totalValue ||
    !request ||
    request.typename !== "LeavesSwapRequest" ||
    !isIdentifier(request.id) ||
    request.status !== "SUCCEEDED" ||
    request.network !== (network === "mainnet" ? "MAINNET" : "REGTEST") ||
    satsAmount(request.fee) !== 0 ||
    !positiveSats(satsAmount(request.totalAmount)) ||
    !outbound ||
    !inbound ||
    !isIdentifier(outbound.sparkId) ||
    !isIdentifier(inbound.sparkId) ||
    outbound.sparkId === inbound.sparkId ||
    ![outbound.sparkId, inbound.sparkId].includes(transfer.id) ||
    (outbound.userRequestId !== undefined &&
      outbound.userRequestId !== request.id) ||
    (inbound.userRequestId !== undefined &&
      inbound.userRequestId !== request.id) ||
    satsAmount(outbound.totalAmount) !== satsAmount(request.totalAmount) ||
    satsAmount(inbound.totalAmount) !== satsAmount(request.totalAmount) ||
    !Array.isArray(request.swapLeaves) ||
    request.swapLeaves.length < 1 ||
    request.swapLeaves.length > PAGE_SIZE * MAX_PAGES
  )
    return null
  const inboundLeafIds: string[] = []
  for (const leaf of request.swapLeaves) {
    const leafId = object(leaf)?.leafId
    if (!isIdentifier(leafId)) return null
    inboundLeafIds.push(leafId)
  }
  if (new Set(inboundLeafIds).size !== inboundLeafIds.length) return null
  return {
    requestId: request.id,
    walletIdentity,
    sspIdentity,
    network,
    outboundId: outbound.sparkId,
    inboundId: inbound.sparkId,
    value: satsAmount(request.totalAmount)!,
    inboundLeafIds: inboundLeafIds.sort(),
  }
}

/** Every extra ID needs positive, unique, terminal net-zero swap evidence. */
async function proveInternalSwapScope(
  input: CollectCheckoutSparkNativeRetirementEvidenceInput,
  history: readonly HistoryTransfer[],
  closedReturns: ReadonlyMap<string, number>
): Promise<SwapRequestFacts[] | null> {
  const extras = history.filter(
    ({ id }) =>
      !input.expectedTransferIds.includes(id) && !closedReturns.has(id)
  )
  if (extras.length === 0) return []
  const readEvidence = input.authenticatedReader.getInternalSwapEvidence
  if (
    !readEvidence ||
    extras.length % 2 !== 0 ||
    extras.some(
      ({ type, swapFacts }) => ![4, 5, 30, 40].includes(type) || !swapFacts
    )
  )
    return null
  const requests = new Map<string, SwapRequestFacts>()
  let context: string | undefined
  for (const transfer of extras) {
    const evidence = await guardedRead(input, () =>
      readEvidence.call(input.authenticatedReader, {
        sparkAddress: input.sparkAddress,
        transferId: transfer.id,
      })
    )
    if (!evidence) return null
    const request = snapshotSwapRequest(evidence, transfer, input.network)
    if (!request) return null
    const currentContext = `${request.walletIdentity}:${request.sspIdentity}`
    if (context !== undefined && context !== currentContext) return null
    context = currentContext
    const prior = requests.get(request.requestId)
    if (prior && JSON.stringify(prior) !== JSON.stringify(request)) return null
    requests.set(request.requestId, request)
  }
  const covered = new Set<string>()
  for (const request of requests.values()) {
    const outbound = extras.find(({ id }) => id === request.outboundId)
    const inbound = extras.find(({ id }) => id === request.inboundId)
    if (
      !outbound?.swapFacts ||
      !inbound?.swapFacts ||
      !(
        (outbound.type === 4 && inbound.type === 5) ||
        (outbound.type === 30 && inbound.type === 40)
      ) ||
      covered.has(outbound.id) ||
      covered.has(inbound.id) ||
      outbound.totalValue !== request.value ||
      inbound.totalValue !== request.value ||
      outbound.swapFacts.senderIdentity !== request.walletIdentity ||
      outbound.swapFacts.receiverIdentity !== request.sspIdentity ||
      inbound.swapFacts.senderIdentity !== request.sspIdentity ||
      inbound.swapFacts.receiverIdentity !== request.walletIdentity ||
      JSON.stringify(inbound.swapFacts.leaves.map(({ id }) => id).sort()) !==
        JSON.stringify(request.inboundLeafIds)
    )
      return null
    covered.add(outbound.id)
    covered.add(inbound.id)
  }
  return covered.size === extras.length
    ? [...requests.values()].sort((left, right) =>
        left.requestId.localeCompare(right.requestId)
      )
    : null
}

async function readCompleteHistory(
  input: CollectCheckoutSparkNativeRetirementEvidenceInput,
  closedReturns: ReadonlyMap<string, number>
): Promise<HistoryTransfer[] | null> {
  const history: HistoryTransfer[] = []
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
    for (const transfer of result.transfers) {
      const { id, type, status, network, totalValue } = transfer
      const extra =
        input.requireExactHistoryScope &&
        !input.expectedTransferIds.includes(id) &&
        !closedReturns.has(id)
      const swapFacts = extra ? snapshotSwapTransfer(transfer) : undefined
      if (extra && !swapFacts) return null
      history.push({
        id,
        type,
        status,
        network,
        totalValue,
        ...(swapFacts ? { swapFacts } : {}),
      })
    }
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

async function readStableHistoryScope(
  input: CollectCheckoutSparkNativeRetirementEvidenceInput,
  closedReturns: ReadonlyMap<string, number>
): Promise<boolean> {
  const first = await readCompleteHistory(input, closedReturns)
  if (!first) return false
  const firstSwaps = input.requireExactHistoryScope
    ? await proveInternalSwapScope(input, first, closedReturns)
    : []
  if (!firstSwaps) return false
  const second = await readCompleteHistory(input, closedReturns)
  if (!second || JSON.stringify(first) !== JSON.stringify(second)) return false
  const secondSwaps = input.requireExactHistoryScope
    ? await proveInternalSwapScope(input, second, closedReturns)
    : []
  return (
    secondSwaps !== null &&
    JSON.stringify(firstSwaps) === JSON.stringify(secondSwaps)
  )
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
    input = {
      ...input,
      expectedTransferIds: [...input.expectedTransferIds],
      requireExactHistoryScope: true,
    }
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
    if (!(await readStableHistoryScope(input, closed))) return false
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
    if (!(await readStableHistoryScope(input, closedReturns))) return null
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
