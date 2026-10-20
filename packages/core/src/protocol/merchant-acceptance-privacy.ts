import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { db, type ConduitDB, type MerchantInventoryAcceptedOrder } from "../db"
import { CommerceInboxStore, type InboxCipher } from "./commerce-inbox-store"
import { getProtectedReadAuthorization } from "./protected-read-authorization"

const FORMAT = "device-encrypted-v1" as const

export const encodeMerchantPrivateCipher = (cipher: InboxCipher) => ({
  nonce: bytesToHex(cipher.nonce),
  bytes: bytesToHex(new Uint8Array(cipher.bytes)),
})
export const decodeMerchantPrivateCipher = (cipher: {
  nonce: string
  bytes: string
}): InboxCipher => ({
  nonce: hexToBytes(cipher.nonce),
  bytes: Uint8Array.from(hexToBytes(cipher.bytes)).buffer,
})

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
  merchantPubkey: string,
  database: ConduitDB = db
): CommerceInboxStore {
  const authorization = getProtectedReadAuthorization(merchantPubkey)
  if (!authorization)
    throw new Error(
      "Reconnect the merchant account before opening accepted order evidence."
    )
  return new CommerceInboxStore(authorization, database)
}

export function merchantStockCheckpointKey(
  coordinate: string,
  rumorId: string
) {
  return `merchant-stock-checkpoint:${coordinate}:${rumorId}`
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
    evidence: JSON.stringify(encodeMerchantPrivateCipher(cipher)),
  }
}

/** Open the retained original bytes, fenced by both account and order identity. */
export async function openMerchantAcceptanceEvidence(
  accepted: MerchantInventoryAcceptedOrder,
  store = merchantAcceptanceStore(accepted.merchantPubkey)
): Promise<string> {
  store.assertCurrent()
  if (store.principal !== accepted.merchantPubkey)
    throw new Error("Accepted order belongs to another account.")
  if (accepted.evidenceFormat !== FORMAT)
    throw new Error("Accepted order evidence needs privacy migration.")
  const cipher = JSON.parse(accepted.evidence) as {
    nonce: string
    bytes: string
  }
  const evidence = await store.open<string>(
    decodeMerchantPrivateCipher(cipher),
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
  const database = store.database
  const rows = await database.merchantInventoryAcceptedOrders
    .where("merchantPubkey")
    .equals(store.principal)
    .toArray()
  for (const original of rows) {
    store.assertCurrent()
    const entries = await database.eventMarketOrganizerStockEntries
      .where("accountPubkey")
      .equals(store.principal)
      .filter((entry) => entry.orderId === original.orderId)
      .toArray()
    if (
      original.evidenceFormat === FORMAT &&
      entries.every((entry) => entry.evidence === original.evidenceBinding)
    )
      continue
    const evidence =
      original.evidenceFormat === FORMAT
        ? await openMerchantAcceptanceEvidence(original, store)
        : original.evidence
    const sealed =
      original.evidenceFormat === FORMAT
        ? original
        : await sealMerchantAcceptanceEvidence(
            store,
            original.orderId,
            evidence
          )
    if (
      entries.some(
        (entry) =>
          entry.evidence !== evidence &&
          entry.evidence !== sealed.evidenceBinding
      )
    )
      throw new Error("Imported accepted evidence requires reconciliation.")
    await database.transaction(
      "rw",
      [
        database.merchantInventoryAcceptedOrders,
        database.eventMarketOrganizerStockEntries,
      ],
      async () => {
        store.assertCurrent()
        const current = await database.merchantInventoryAcceptedOrders.get(
          original.orderId
        )
        if (!current)
          throw new Error("Accepted order changed during privacy migration.")
        if (
          current.evidenceFormat === FORMAT &&
          original.evidenceFormat !== FORMAT
        )
          throw new Error(
            "Accepted order changed during privacy migration. Retry the original order."
          )
        if (JSON.stringify(current) !== JSON.stringify(original))
          throw new Error(
            "Accepted order changed during privacy migration. Retry the original order."
          )
        const currentEntries = await database.eventMarketOrganizerStockEntries
          .where("accountPubkey")
          .equals(store.principal)
          .filter((entry) => entry.orderId === original.orderId)
          .toArray()
        if (JSON.stringify(currentEntries) !== JSON.stringify(entries))
          throw new Error(
            "Imported accepted evidence changed during privacy migration."
          )
        await database.merchantInventoryAcceptedOrders.put({
          ...current,
          identityBinding:
            original.evidenceFormat === FORMAT
              ? current.identityBinding
              : merchantAcceptanceBinding("identity", current.identityBinding),
          termsBinding:
            original.evidenceFormat === FORMAT
              ? current.termsBinding
              : merchantAcceptanceBinding("terms", current.termsBinding),
          evidenceFormat: FORMAT,
          evidenceBinding: sealed.evidenceBinding,
          evidence: sealed.evidence,
        })
        for (const entry of currentEntries)
          await database.eventMarketOrganizerStockEntries.put({
            ...entry,
            evidence: sealed.evidenceBinding!,
          })
        store.assertCurrent()
      }
    )
  }
  // Checkpoint rumors contain portable original order bytes. They are private
  // transport values, not safe plaintext local publication metadata.
  const products = await database.merchantInventoryProducts
    .where("merchantPubkey")
    .equals(store.principal)
    .toArray()
  for (const original of products) {
    const checkpoint = original.organizerStockCheckpoint
    if (!checkpoint?.rumor) continue
    const privateRumor = await store.seal(
      checkpoint.rumor,
      merchantStockCheckpointKey(original.coordinate, checkpoint.rumor.id)
    )
    await database.transaction(
      "rw",
      database.merchantInventoryProducts,
      async () => {
        store.assertCurrent()
        const current = await database.merchantInventoryProducts.get(
          original.coordinate
        )
        if (
          !current ||
          JSON.stringify(current.organizerStockCheckpoint) !==
            JSON.stringify(checkpoint)
        )
          throw new Error("Stock checkpoint changed during privacy migration.")
        const { rumor: _rumor, ...metadata } = checkpoint
        void _rumor
        current.organizerStockCheckpoint = {
          ...metadata,
          rumorId: checkpoint.rumor!.id,
          privateRumor: encodeMerchantPrivateCipher(privateRumor),
        }
        await database.merchantInventoryProducts.put(current)
        store.assertCurrent()
      }
    )
  }
  store.assertCurrent()
}
