import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { db, type MerchantInventoryAcceptedOrder } from "../db"
import { CommerceInboxStore } from "./commerce-inbox-store"
import { getProtectedReadAuthorization } from "./protected-read-authorization"

const FORMAT = "device-encrypted-v1" as const

/** Domain-separated exact-byte bindings; private terms never become DB indexes. */
export function merchantAcceptanceBinding(
  domain: string,
  value: string
): string {
  return `sha256:${bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify(["merchant-inventory-acceptance-v1", domain, value])
      )
    )
  )}`
}

export function merchantAcceptanceStore(
  merchantPubkey: string
): CommerceInboxStore {
  const authorization = getProtectedReadAuthorization(merchantPubkey)
  if (!authorization)
    throw new Error(
      "Reconnect the merchant account before opening accepted order evidence."
    )
  return new CommerceInboxStore(authorization)
}

function evidenceKey(orderId: string): string {
  return `merchant-inventory-acceptance:${orderId}`
}

export async function sealMerchantAcceptanceEvidence(
  store: CommerceInboxStore,
  orderId: string,
  evidence: string
) {
  const cipher = await store.seal(evidence, evidenceKey(orderId))
  return {
    evidenceFormat: FORMAT,
    evidenceBinding: merchantAcceptanceBinding("evidence", evidence),
    evidence: JSON.stringify({
      nonce: bytesToHex(cipher.nonce),
      bytes: bytesToHex(new Uint8Array(cipher.bytes)),
    }),
  }
}

/** Open the retained original bytes, fenced by both account and order identity. */
export async function openMerchantAcceptanceEvidence(
  accepted: MerchantInventoryAcceptedOrder
): Promise<string> {
  const store = merchantAcceptanceStore(accepted.merchantPubkey)
  if (accepted.evidenceFormat !== FORMAT)
    throw new Error("Accepted order evidence needs privacy migration.")
  const cipher = JSON.parse(accepted.evidence) as {
    nonce: string
    bytes: string
  }
  const evidence = await store.open<string>(
    {
      nonce: hexToBytes(cipher.nonce),
      bytes: Uint8Array.from(hexToBytes(cipher.bytes)).buffer,
    },
    evidenceKey(accepted.orderId)
  )
  if (
    merchantAcceptanceBinding("evidence", evidence) !== accepted.evidenceBinding
  )
    throw new Error("Accepted order evidence binding is invalid.")
  return evidence
}

/**
 * Resumable account-owned repair for preview records. Never rewrites a stock
 * decision, deletes an acceptance, or needs a signer prompt. Cipher creation is
 * outside Dexie's transaction; compare-and-replace fences concurrent repairs.
 */
export async function protectMerchantAcceptanceHistory(
  store: CommerceInboxStore
): Promise<void> {
  store.assertCurrent()
  const rows = await db.merchantInventoryAcceptedOrders
    .where("merchantPubkey")
    .equals(store.principal)
    .toArray()
  for (const original of rows) {
    store.assertCurrent()
    if (original.evidenceFormat === FORMAT) continue
    const sealed = await sealMerchantAcceptanceEvidence(
      store,
      original.orderId,
      original.evidence
    )
    await db.transaction("rw", db.merchantInventoryAcceptedOrders, async () => {
      store.assertCurrent()
      const current = await db.merchantInventoryAcceptedOrders.get(
        original.orderId
      )
      if (!current || current.evidenceFormat === FORMAT) return
      if (JSON.stringify(current) !== JSON.stringify(original))
        throw new Error(
          "Accepted order changed during privacy migration. Retry the original order."
        )
      await db.merchantInventoryAcceptedOrders.put({
        ...current,
        identityBinding: merchantAcceptanceBinding(
          "identity",
          current.identityBinding
        ),
        termsBinding: merchantAcceptanceBinding("terms", current.termsBinding),
        ...sealed,
      })
      store.assertCurrent()
    })
  }
  store.assertCurrent()
}
