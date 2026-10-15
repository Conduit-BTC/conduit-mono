import type { Event } from "nostr-tools/pure"
import {
  ADDRESS_REQUEST_ORIGIN,
  ADDRESS_REQUEST_PATH,
  addressRequestHash,
  verifyAddressRequestAuthority,
  type SignedAddressNameRequest,
} from "@conduit/core/wallets/address-name-request"
import { validateApprovedNames, type ApprovedName } from "./gateway"

export interface StoredNameRequest {
  request_id: string
  owner_pubkey: string
  spark_identity: string
  desired_name: string
  note: string
  request_hash: string
  signed_payload: string
  account_proof: string
  wallet_proof: string
  created_at: number
  status: "received" | "declined"
}

/** Offline review of original evidence, at receipt time, never a fresh signature.
 * No network, credentials, database writes or approval side effects. */
export function reviewNameRequest(row: StoredNameRequest): ApprovedName {
  try {
    if (
      row.status !== "received" ||
      !Number.isSafeInteger(row.created_at) ||
      row.created_at <= 0 ||
      typeof row.signed_payload !== "string" ||
      new TextEncoder().encode(row.signed_payload).length > 8192 ||
      typeof row.account_proof !== "string" ||
      row.account_proof.length > 4096
    )
      throw new Error()
    const payload = JSON.parse(row.signed_payload) as SignedAddressNameRequest
    const saved = JSON.parse(row.account_proof) as
      Event | { version: 2; event: Event }
    const durable = "version" in saved && saved.version === 2
    const account = durable ? saved.event : (saved as Event)
    if (
      !verifyAddressRequestAuthority(
        payload,
        account,
        ADDRESS_REQUEST_PATH,
        durable ? payload.timestamp : row.created_at,
        ADDRESS_REQUEST_ORIGIN,
        row.signed_payload
      ) ||
      payload.timestamp > row.created_at + 60 ||
      row.request_id !== payload.requestId ||
      row.owner_pubkey !== payload.ownerPubkey ||
      row.spark_identity !== payload.sparkIdentity ||
      row.desired_name !== payload.desiredName ||
      row.note !== payload.note ||
      row.wallet_proof !== payload.walletSignature ||
      row.request_hash !==
        addressRequestHash(
          JSON.stringify([
            payload.ownerPubkey,
            payload.sparkIdentity,
            payload.desiredName,
            payload.note,
          ])
        )
    )
      throw new Error()
    return {
      name: payload.desiredName,
      ownerPubkey: payload.ownerPubkey,
      sparkIdentity: payload.sparkIdentity,
      registration: true,
    }
  } catch {
    // Never echo private request contents, signatures or parser errors.
    throw new Error("Request evidence is not eligible for approval.")
  }
}

export function proposeApprovedName(
  registry: { version: number; names: ApprovedName[] },
  row: StoredNameRequest
): { version: 1; names: ApprovedName[] } {
  if (registry.version !== 1)
    throw new Error("Unknown approved-name registry version.")
  validateApprovedNames(registry.names)
  const proposed = reviewNameRequest(row)
  const existing = registry.names.find((entry) => entry.name === proposed.name)
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(proposed))
      return { version: 1, names: [...registry.names] }
    throw new Error("Existing binding requires a separate explicit review.")
  }
  const names = [...registry.names, proposed]
  validateApprovedNames(names)
  return { version: 1, names }
}
