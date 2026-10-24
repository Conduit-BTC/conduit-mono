import { z } from "zod"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import type { SignedNostrEvent } from "../protocol/nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "../protocol/signed-event"
import { isValidSparkMnemonic, normalizeSparkMnemonic } from "./spark-recovery"
import {
  addressRequestRecordSchema,
  requestEvidence,
} from "./address-request-record"

import {
  PORTABLE_WALLET_KIND,
  PORTABLE_WALLET_PREFIX,
  PORTABLE_WALLET_TAG,
} from "./portable-wallet-address"
export {
  PORTABLE_WALLET_KIND,
  PORTABLE_WALLET_PREFIX,
  PORTABLE_WALLET_TAG,
} from "./portable-wallet-address"
export const portableWalletRecordSchema = z.strictObject({
  format: z.literal("conduit.portable-wallet"),
  version: z.literal(1),
  ownerPubkey: z.string().regex(/^[0-9a-f]{64}$/),
  walletId: z.string().regex(/^[0-9a-f]{64}$/),
  provider: z.literal("spark"),
  network: z.enum(["mainnet", "testnet", "signet", "regtest"]),
  accountNumber: z.number().int().min(0).max(0x7fffffff),
  mnemonic: z
    .string()
    .max(512)
    .refine(isValidSparkMnemonic)
    .transform(normalizeSparkMnemonic),
  identityPublicKey: z.string().regex(/^(02|03)[0-9a-f]{64}$/),
  name: z.string().trim().min(1).max(80),
  lightningAddress: z
    .string()
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+$/)
    .nullable(),
  setupPending: z.boolean(),
  lifecycle: z.enum(["active", "removed"]),
  // Per-wallet preference timestamps select one winner without a separate registry.
  paySelectedAt: z.number().int().nonnegative(),
  receiveSelectedAt: z.number().int().nonnegative(),
  addressRequest: addressRequestRecordSchema.optional(),
})
export type PortableWalletRecord = z.infer<typeof portableWalletRecordSchema>

export function portableWalletId(
  input: Pick<
    PortableWalletRecord,
    "ownerPubkey" | "network" | "accountNumber" | "identityPublicKey"
  >
): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          PORTABLE_WALLET_TAG,
          input.ownerPubkey,
          input.network,
          input.accountNumber,
          input.identityPublicKey,
        ])
      )
    )
  )
}
function isNip44Ciphertext(content: string): boolean {
  if (
    content.length < 132 ||
    content.length > 32768 ||
    content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(content)
  )
    return false
  try {
    const bytes = atob(content)
    return (
      bytes.charCodeAt(0) === 2 && bytes.length >= 99 && btoa(bytes) === content
    )
  } catch {
    return false
  }
}
export function isPortableWalletEvent(
  event: SignedNostrEvent,
  owner: string
): boolean {
  return (
    isValidSignedPublicNostrEvent(event) &&
    event.pubkey === owner &&
    event.kind === PORTABLE_WALLET_KIND &&
    isNip44Ciphertext(event.content) &&
    event.tags.filter((t) => t[0] === "d").length === 1 &&
    new RegExp("^" + PORTABLE_WALLET_PREFIX + "[0-9a-f]{64}$").test(
      event.tags.find((t) => t[0] === "d")?.[1] ?? ""
    ) &&
    event.tags.some((t) => t[0] === "t" && t[1] === PORTABLE_WALLET_TAG)
  )
}
export function parsePortableWalletRecord(
  plaintext: string,
  event: SignedNostrEvent
): PortableWalletRecord {
  if (plaintext.length > 16000 || !isPortableWalletEvent(event, event.pubkey))
    throw new Error("Invalid wallet record.")
  const record = portableWalletRecordSchema.parse(JSON.parse(plaintext))
  if (
    record.ownerPubkey !== event.pubkey ||
    portableWalletId(record) !== record.walletId ||
    event.tags.find((t) => t[0] === "d")?.[1] !==
      PORTABLE_WALLET_PREFIX + record.walletId
  )
    throw new Error("Wallet record identity does not match.")
  if (record.addressRequest) {
    const request = requestEvidence(record.addressRequest)
    if (
      request.ownerPubkey !== record.ownerPubkey ||
      request.sparkIdentity !== record.identityPublicKey ||
      request.network !== record.network
    )
      throw new Error("Address request does not belong to this wallet.")
  }
  return record
}
/** NIP-01: newest timestamp, then lowest event ID. Arrival order never wins. */
export function compareWalletEvents(
  a: SignedNostrEvent,
  b: SignedNostrEvent
): number {
  return b.created_at - a.created_at || a.id.localeCompare(b.id)
}
