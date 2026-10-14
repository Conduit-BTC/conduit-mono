import { config } from "../config"
import {
  encodeLnurl,
  fetchLnurlPayMetadata,
  isValidLud16Address,
  normalizeSafeLnurlPayRequestUrl,
  type LnurlPayMetadata,
} from "./lightning"

export type CheckoutSparkReceiverMode = "private" | "public"

/** Trusted deployment policy, not a claim from metadata, recovery or a wallet brand. */
export interface CheckoutSparkReceiverContract {
  readonly schemaVersion: 1
  readonly contractId: string
  readonly qualification: "accepted" | "pending"
  readonly payRequestOrigins: readonly string[]
  readonly callbackOrigins: readonly string[]
  readonly verifyOrigins: readonly string[]
  /** Exact verifier URL is one qualified origin + this prefix + payment hash. */
  readonly verifyPathPrefix: string
  readonly modes: readonly CheckoutSparkReceiverMode[]
  /** Public mode requires a provider-authoritative historical account field. */
  readonly binding: "metadata_hash" | "verifier_recipient"
}

/** Portable issuance facts only. A fresh qualified provider read is still required. */
export interface CheckoutSparkReceiverBinding {
  readonly schemaVersion: 1
  readonly contractId: string
  readonly mode: CheckoutSparkReceiverMode
  readonly lud16: string
  readonly payRequestUrl: string
  readonly callbackUrl: string
  readonly metadata: string
  readonly verifyUrl: string
}

declare const capabilityBrand: unique symbol
export interface CheckoutSparkReceiverCapability {
  readonly [capabilityBrand]: true
}

export type CheckoutSparkReceiverCapabilityResult =
  | {
      readonly status: "supported"
      readonly capability: CheckoutSparkReceiverCapability
    }
  | { readonly status: "unsupported" | "unavailable" | "conflicting" }

export interface CheckoutSparkReceiverDependencies {
  /** Only trusted deployment configuration may supply these descriptors. */
  readonly contracts?: readonly CheckoutSparkReceiverContract[]
  readonly fetchMetadata?: typeof fetchLnurlPayMetadata
}

interface CapabilitySnapshot {
  readonly contract: CheckoutSparkReceiverContract
  readonly mode: CheckoutSparkReceiverMode
  readonly lud16: string
  readonly payRequestUrl: string
  readonly callbackUrl: string
  readonly metadata: string
}

const capabilities = new WeakMap<
  CheckoutSparkReceiverCapability,
  CapabilitySnapshot
>()
const EMPTY_CONTRACTS: readonly CheckoutSparkReceiverContract[] = Object.freeze(
  []
)
const CONTRACT_KEYS = [
  "schemaVersion",
  "contractId",
  "qualification",
  "payRequestOrigins",
  "callbackOrigins",
  "verifyOrigins",
  "verifyPathPrefix",
  "modes",
  "binding",
]
const BINDING_KEYS = [
  "schemaVersion",
  "contractId",
  "mode",
  "lud16",
  "payRequestUrl",
  "callbackUrl",
  "metadata",
  "verifyUrl",
]

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function origins(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16)
    throw new Error("Receiver contract is invalid.")
  const result = value.map((raw) => {
    const safe = typeof raw === "string" && normalizeSafeLnurlPayRequestUrl(raw)
    if (!safe) throw new Error("Receiver contract is invalid.")
    const url = new URL(safe)
    if (url.pathname !== "/" || url.search || url.hash)
      throw new Error("Receiver contract is invalid.")
    return url.origin
  })
  if (new Set(result).size !== result.length)
    throw new Error("Receiver contract is invalid.")
  return Object.freeze(result)
}

/** Fail closed on malformed policy; no advertised capability activates a receiver. */
export function parseCheckoutSparkReceiverContracts(
  raw: unknown
): readonly CheckoutSparkReceiverContract[] {
  let value: unknown
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw
  } catch {
    throw new Error("Receiver configuration is invalid.")
  }
  if (!Array.isArray(value) || value.length > 32)
    throw new Error("Receiver configuration is invalid.")
  const result = value.map((entry): CheckoutSparkReceiverContract => {
    const record = object(entry)
    if (
      !record ||
      Object.keys(record).length !== CONTRACT_KEYS.length ||
      Object.keys(record).some((key) => !CONTRACT_KEYS.includes(key)) ||
      record.schemaVersion !== 1 ||
      typeof record.contractId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(record.contractId) ||
      (record.qualification !== "accepted" &&
        record.qualification !== "pending") ||
      (record.binding !== "metadata_hash" &&
        record.binding !== "verifier_recipient") ||
      typeof record.verifyPathPrefix !== "string" ||
      !/^\/(?:[a-zA-Z0-9_-]+\/)+$/.test(record.verifyPathPrefix) ||
      !Array.isArray(record.modes) ||
      record.modes.length === 0 ||
      record.modes.length > 2 ||
      record.modes.some((mode) => mode !== "private" && mode !== "public") ||
      new Set(record.modes).size !== record.modes.length ||
      (record.binding === "metadata_hash" && record.modes.includes("public"))
    ) {
      throw new Error("Receiver contract is invalid.")
    }
    return Object.freeze({
      schemaVersion: 1,
      contractId: record.contractId,
      qualification: record.qualification as "accepted" | "pending",
      payRequestOrigins: origins(record.payRequestOrigins),
      callbackOrigins: origins(record.callbackOrigins),
      verifyOrigins: origins(record.verifyOrigins),
      verifyPathPrefix: record.verifyPathPrefix,
      modes: Object.freeze([
        ...record.modes,
      ]) as readonly CheckoutSparkReceiverMode[],
      binding: record.binding as CheckoutSparkReceiverContract["binding"],
    })
  })
  if (
    new Set(result.map((contract) => contract.contractId)).size !==
    result.length
  )
    throw new Error("Receiver configuration is invalid.")
  return Object.freeze(result)
}

/** No production receiver is implicitly qualified, including the reference deployment. */
export function getCheckoutSparkReceiverContracts(
  raw: unknown = config.checkoutSparkReceiverContracts
): readonly CheckoutSparkReceiverContract[] {
  return raw === undefined || raw === null || raw === ""
    ? EMPTY_CONTRACTS
    : parseCheckoutSparkReceiverContracts(raw)
}

export function normalizeCheckoutSparkReceiverAddress(
  value: string
): string | undefined {
  const result = value.trim().toLowerCase()
  return isValidLud16Address(result) ? result : undefined
}

function identifierMatches(raw: string, lud16: string): boolean {
  if (new TextEncoder().encode(raw).byteLength > 65_536) return false
  try {
    const entries: unknown = JSON.parse(raw)
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          entry.some((part) => typeof part !== "string")
      )
    )
      return false
    const identifiers = entries.filter(
      (entry) => entry[0] === "text/identifier"
    )
    return (
      identifiers.length === 1 &&
      identifiers[0][1] === lud16 &&
      entries.some((entry) => entry[0] === "text/plain" && entry[1].length > 0)
    )
  } catch {
    return false
  }
}

function snapshotMetadata(
  metadata: LnurlPayMetadata,
  lud16: string,
  mode: CheckoutSparkReceiverMode,
  contracts: readonly CheckoutSparkReceiverContract[]
): CapabilitySnapshot | undefined {
  const [username, domain] = lud16.split("@")
  const payRequestUrl = `https://${domain}/.well-known/lnurlp/${username}`
  const callbackUrl = normalizeSafeLnurlPayRequestUrl(metadata.callback)
  if (
    !callbackUrl ||
    metadata.tag !== "payRequest" ||
    metadata.payRequestUrl !== payRequestUrl ||
    metadata.lnurl !== encodeLnurl(payRequestUrl) ||
    !Number.isSafeInteger(metadata.minSendable) ||
    !Number.isSafeInteger(metadata.maxSendable) ||
    metadata.minSendable <= 0 ||
    metadata.maxSendable < metadata.minSendable ||
    typeof metadata.metadata !== "string" ||
    !identifierMatches(metadata.metadata, lud16)
  )
    return undefined
  const contract = contracts.find(
    (candidate) =>
      candidate.qualification === "accepted" &&
      candidate.modes.includes(mode) &&
      candidate.payRequestOrigins.includes(new URL(payRequestUrl).origin) &&
      candidate.callbackOrigins.includes(new URL(callbackUrl).origin) &&
      (mode !== "public" || candidate.binding === "verifier_recipient")
  )
  return (
    contract &&
    Object.freeze({
      contract,
      mode,
      lud16,
      payRequestUrl,
      callbackUrl,
      metadata: metadata.metadata,
    })
  )
}

export async function observeCheckoutSparkReceiverCapability(
  input: {
    readonly lud16: string
    readonly mode: CheckoutSparkReceiverMode
    readonly assertCurrent: () => void
  },
  dependencies: CheckoutSparkReceiverDependencies = {}
): Promise<CheckoutSparkReceiverCapabilityResult> {
  input.assertCurrent()
  const lud16 = normalizeCheckoutSparkReceiverAddress(input.lud16)
  if (!lud16 || (input.mode !== "private" && input.mode !== "public"))
    return { status: "conflicting" }
  const contracts = parseCheckoutSparkReceiverContracts(
    dependencies.contracts ?? getCheckoutSparkReceiverContracts()
  )
  const origin = new URL(`https://${lud16.split("@")[1]}`).origin
  if (
    !contracts.some(
      (contract) =>
        contract.qualification === "accepted" &&
        contract.modes.includes(input.mode) &&
        contract.payRequestOrigins.includes(origin)
    )
  )
    return { status: "unsupported" }
  let metadata: LnurlPayMetadata
  try {
    metadata = await (dependencies.fetchMetadata ?? fetchLnurlPayMetadata)(
      lud16
    )
  } catch {
    input.assertCurrent()
    return { status: "unavailable" }
  }
  input.assertCurrent()
  const snapshot = snapshotMetadata(metadata, lud16, input.mode, contracts)
  if (!snapshot) return { status: "conflicting" }
  const capability = Object.freeze({}) as CheckoutSparkReceiverCapability
  capabilities.set(capability, snapshot)
  return { status: "supported", capability }
}

function verifyUrlMatches(
  contract: CheckoutSparkReceiverContract,
  verifyUrl: string,
  paymentHash: string
): boolean {
  const safe = normalizeSafeLnurlPayRequestUrl(verifyUrl)
  if (!safe || safe !== verifyUrl || !/^[a-f0-9]{64}$/.test(paymentHash))
    return false
  const url = new URL(safe)
  return (
    !url.search &&
    !url.hash &&
    contract.verifyOrigins.includes(url.origin) &&
    url.pathname === `${contract.verifyPathPrefix}${paymentHash}`
  )
}

export function createCheckoutSparkReceiverBinding(
  capability: CheckoutSparkReceiverCapability,
  input: { readonly verifyUrl: string; readonly paymentHash: string }
): CheckoutSparkReceiverBinding {
  const snapshot = capabilities.get(capability)
  if (
    !snapshot ||
    !verifyUrlMatches(snapshot.contract, input.verifyUrl, input.paymentHash)
  )
    throw new Error("Checkout receiver verification endpoint is unavailable.")
  return Object.freeze({
    schemaVersion: 1,
    contractId: snapshot.contract.contractId,
    mode: snapshot.mode,
    lud16: snapshot.lud16,
    payRequestUrl: snapshot.payRequestUrl,
    callbackUrl: snapshot.callbackUrl,
    metadata: snapshot.metadata,
    verifyUrl: input.verifyUrl,
  })
}

/** Shape validation does not produce authority; callers must still re-read the provider. */
export function freezeCheckoutSparkReceiverBinding(
  raw: unknown
): CheckoutSparkReceiverBinding {
  const value = object(raw)
  if (
    !value ||
    Object.keys(value).length !== BINDING_KEYS.length ||
    Object.keys(value).some((key) => !BINDING_KEYS.includes(key)) ||
    value.schemaVersion !== 1 ||
    typeof value.contractId !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(value.contractId) ||
    (value.mode !== "private" && value.mode !== "public") ||
    typeof value.lud16 !== "string" ||
    normalizeCheckoutSparkReceiverAddress(value.lud16) !== value.lud16 ||
    typeof value.metadata !== "string" ||
    !identifierMatches(value.metadata, value.lud16) ||
    [value.payRequestUrl, value.callbackUrl, value.verifyUrl].some(
      (url) =>
        typeof url !== "string" || normalizeSafeLnurlPayRequestUrl(url) !== url
    )
  )
    throw new Error("Checkout receiver binding is invalid.")
  return Object.freeze({
    schemaVersion: 1,
    contractId: value.contractId,
    mode: value.mode,
    lud16: value.lud16,
    payRequestUrl: value.payRequestUrl as string,
    callbackUrl: value.callbackUrl as string,
    metadata: value.metadata,
    verifyUrl: value.verifyUrl as string,
  })
}

export function assertCheckoutSparkReceiverBinding(
  capability: CheckoutSparkReceiverCapability,
  binding: CheckoutSparkReceiverBinding,
  paymentHash: string
): CheckoutSparkReceiverContract {
  const snapshot = capabilities.get(capability)
  if (
    !snapshot ||
    binding.contractId !== snapshot.contract.contractId ||
    binding.mode !== snapshot.mode ||
    binding.lud16 !== snapshot.lud16 ||
    binding.payRequestUrl !== snapshot.payRequestUrl ||
    binding.callbackUrl !== snapshot.callbackUrl ||
    !identifierMatches(binding.metadata, snapshot.lud16) ||
    !verifyUrlMatches(snapshot.contract, binding.verifyUrl, paymentHash)
  )
    throw new Error("Checkout receiver binding is unavailable.")
  return snapshot.contract
}
