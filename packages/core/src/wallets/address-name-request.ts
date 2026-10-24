import { secp256k1 } from "@noble/curves/secp256k1.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { verifyEvent, type Event } from "nostr-tools/pure"

export const ADDRESS_REQUEST_ORIGIN = "https://conduit.cash"
export const ADDRESS_REQUEST_ACTION = "address_name_request"
export const ADDRESS_REQUEST_PATH = "/api/name-requests"
export interface AddressNameRequest {
  requestId: string
  desiredName: string
  ownerPubkey: string
  sparkIdentity: string
  network: "mainnet"
  note: string
  timestamp: number
}
export interface SignedAddressNameRequest extends AddressNameRequest {
  walletSignature: string
}
export type AddressNameRequestStatus =
  | "received"
  | "pending"
  | "not_received"
  | "approved"
  | "declined"
  | "unavailable"
  | "origin_forbidden"
  | "preview_expired"
  | "challenge_failed"
  | "rate_limited"
  | "invalid"

/** Only an explicit gateway record-absence response can release a pending request. */
export async function decodeAddressNameRequestResponse(
  result: Response
): Promise<AddressNameRequestStatus> {
  let value: unknown
  try {
    value = await result.json()
  } catch {
    return "pending"
  }
  if (!result.ok && result.status !== 404) {
    const status =
      value && typeof value === "object"
        ? (value as Record<string, unknown>).status
        : undefined
    const expected: Record<string, number[]> = {
      origin_forbidden: [403],
      preview_expired: [403],
      challenge_failed: [400],
      rate_limited: [429],
      invalid: [400, 401, 409],
      unavailable: [503],
    }
    return typeof status === "string" &&
      expected[status]?.includes(result.status)
      ? (status as AddressNameRequestStatus)
      : "pending"
  }
  if (result.status === 404)
    return value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      (value as Record<string, unknown>).status === "not_received"
      ? "not_received"
      : "pending"
  const status =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).status
      : undefined
  return status === "received" ||
    status === "pending" ||
    status === "approved" ||
    status === "declined"
    ? status
    : "unavailable"
}

export function addressRequestHash(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)))
}
export function validSparkIdentity(value: string): boolean {
  if (!/^(02|03)[a-f0-9]{64}$/.test(value)) return false
  try {
    secp256k1.Point.fromHex(value)
    return true
  } catch {
    return false
  }
}
export function validAddressNameRequest(value: AddressNameRequest): boolean {
  return (
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.requestId
    ) &&
    /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(value.desiredName) &&
    value.desiredName.length >= 3 &&
    value.desiredName.length <= 64 &&
    /^[a-f0-9]{64}$/.test(value.ownerPubkey) &&
    validSparkIdentity(value.sparkIdentity) &&
    value.network === "mainnet" &&
    typeof value.note === "string" &&
    value.note.length <= 1000 &&
    Number.isSafeInteger(value.timestamp) &&
    value.timestamp > 0
  )
}
export function addressNameRequestMessage(value: AddressNameRequest): string {
  if (!validAddressNameRequest(value)) throw new Error("Invalid name request.")
  return [
    "conduit:address-name-request:v1",
    "conduit.cash",
    value.requestId,
    value.desiredName,
    value.ownerPubkey,
    value.sparkIdentity,
    value.network,
    addressRequestHash(value.note),
    String(value.timestamp),
  ].join("\n")
}
export function addressNameRequestPayload(
  value: SignedAddressNameRequest
): string {
  return JSON.stringify({
    requestId: value.requestId,
    desiredName: value.desiredName,
    ownerPubkey: value.ownerPubkey,
    sparkIdentity: value.sparkIdentity,
    network: value.network,
    note: value.note,
    timestamp: value.timestamp,
    walletSignature: value.walletSignature,
  })
}
export function verifyAddressWalletSignature(
  message: string,
  signature: string,
  identity: string
): boolean {
  try {
    return (
      /^(?:[a-f0-9]{2}){8,72}$/.test(signature) &&
      validSparkIdentity(identity) &&
      secp256k1.verify(
        hexToBytes(signature),
        sha256(new TextEncoder().encode(message)),
        hexToBytes(identity),
        { prehash: false, format: "der" }
      )
    )
  } catch {
    return false
  }
}
export function verifyAddressRequestAuthority(
  input: SignedAddressNameRequest,
  event: Event,
  path = ADDRESS_REQUEST_PATH,
  now = Math.floor(Date.now() / 1000),
  origin = ADDRESS_REQUEST_ORIGIN,
  payload?: string
): boolean {
  try {
    if (
      !validAddressNameRequest(input) ||
      Math.abs(now - input.timestamp) > 60 ||
      event.pubkey !== input.ownerPubkey ||
      event.kind !== 27235 ||
      event.content !== "" ||
      Math.abs(now - event.created_at) > 60 ||
      !verifyEvent(event) ||
      event.tags.length !== 3
    )
      return false
    const expected = [
      ["u", `${origin}${path}`],
      ["method", "POST"],
      [
        "payload",
        addressRequestHash(payload ?? addressNameRequestPayload(input)),
      ],
    ]
    return (
      JSON.stringify(event.tags) === JSON.stringify(expected) &&
      verifyAddressWalletSignature(
        addressNameRequestMessage(input),
        input.walletSignature,
        input.sparkIdentity
      )
    )
  } catch {
    return false
  }
}

/** Public readiness has no wallet data and cannot submit or activate anything. */
export async function addressRequestAvailability(
  fetcher: typeof fetch
): Promise<"ready" | AddressNameRequestStatus> {
  try {
    const result = await fetcher(
      `${ADDRESS_REQUEST_ORIGIN}${ADDRESS_REQUEST_PATH}/availability`,
      {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(20_000),
      }
    )
    if (result.ok) {
      const value = (await result.json()) as { status?: string }
      return value.status === "ready" ? "ready" : "unavailable"
    }
    const status = await decodeAddressNameRequestResponse(result)
    return status === "origin_forbidden" || status === "preview_expired"
      ? status
      : "unavailable"
  } catch {
    return "unavailable"
  }
}

export function addressRequestFailureMessage(
  status: AddressNameRequestStatus
): string {
  switch (status) {
    case "origin_forbidden":
      return "This build is not authorized for real name requests. Open the current trusted preview or production app."
    case "preview_expired":
      return "This preview's authorization has expired. Open a newer preview or production app; your saved request is preserved."
    case "challenge_failed":
      return "The security check was rejected. Complete a fresh check, then retry the same saved request."
    case "rate_limited":
      return "Too many attempts. Wait a minute, then check your saved request's status."
    case "invalid":
      return "The gateway rejected the request's identity proof. Reconnect your signer and check the saved request."
    case "unavailable":
      return "Name-request service or preview authorization is unavailable. Saved progress is preserved; try again later or use production."
    default:
      return "Submission could not be confirmed. Check the same saved request before retrying."
  }
}
