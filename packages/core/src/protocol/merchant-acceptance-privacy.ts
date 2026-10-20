import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import {
  db,
  type ConduitDB,
  type MerchantInventoryAcceptedOrder,
  type MerchantInventoryProduct,
} from "../db"
import { CommerceInboxStore, type InboxCipher } from "./commerce-inbox-store"
import { getProtectedReadAuthorization } from "./protected-read-authorization"

const FORMAT = "device-encrypted-v1" as const

const encodeMerchantPrivateCipher = (cipher: InboxCipher) => ({
  nonce: bytesToHex(cipher.nonce),
  bytes: bytesToHex(new Uint8Array(cipher.bytes)),
})
const decodeMerchantPrivateCipher = (cipher: {
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

/** Exact CAS comparison also includes persisted binary ciphertext bytes. */
export const merchantPrivateStorageJSON = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item instanceof ArrayBuffer ? bytesToHex(new Uint8Array(item)) : item
  )

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
        : await protectMerchantAcceptanceRecord(store, original)
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
        await database.merchantInventoryAcceptedOrders.put(sealed)
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
    const sealed = await sealMerchantStockCheckpoint(store, checkpoint)
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
          merchantPrivateStorageJSON(current.organizerStockCheckpoint) !==
            merchantPrivateStorageJSON(checkpoint)
        )
          throw new Error("Stock checkpoint changed during privacy migration.")
        current.organizerStockCheckpoint = sealed
        await database.merchantInventoryProducts.put(current)
        store.assertCurrent()
      }
    )
  }
  store.assertCurrent()
}

/** Prepare before an inventory transaction; never run WebCrypto in an idle transaction. */
export async function protectMerchantAcceptanceRecord(
  store: CommerceInboxStore,
  original: MerchantInventoryAcceptedOrder
): Promise<MerchantInventoryAcceptedOrder> {
  if (original.merchantPubkey !== store.principal)
    throw new Error("Accepted order belongs to another account.")
  store.assertCurrent()
  if (original.evidenceFormat === FORMAT) return original
  return {
    ...original,
    identityBinding: merchantAcceptanceBinding(
      "identity",
      original.identityBinding
    ),
    termsBinding: merchantAcceptanceBinding("terms", original.termsBinding),
    ...(await sealMerchantAcceptanceEvidence(
      store,
      original.orderId,
      original.evidence
    )),
  }
}

/** In-memory checkpoint representation; only the encrypted private transport may retain it. */
export async function merchantAcceptanceForPrivateTransport(
  accepted: MerchantInventoryAcceptedOrder,
  store: CommerceInboxStore
): Promise<MerchantInventoryAcceptedOrder> {
  store.assertCurrent()
  if (accepted.merchantPubkey !== store.principal)
    throw new Error("Accepted order belongs to another account.")
  if (!accepted.evidenceFormat) return structuredClone(accepted)
  const evidence = await openMerchantAcceptanceEvidence(accepted, store)
  const order = JSON.parse(evidence) as {
    id: string
    buyerPubkey: string
    merchantPubkey: string
  }
  const identity = JSON.stringify([
    order.id,
    order.buyerPubkey,
    order.merchantPubkey,
  ])
  if (
    order.id !== accepted.orderId ||
    order.merchantPubkey !== accepted.merchantPubkey ||
    merchantAcceptanceBinding("identity", identity) !==
      accepted.identityBinding ||
    merchantAcceptanceBinding("terms", evidence) !== accepted.termsBinding
  )
    throw new Error(
      "Accepted order attribution bindings require reconciliation."
    )
  const result = {
    ...accepted,
    identityBinding: identity,
    termsBinding: evidence,
    evidence,
  }
  delete result.evidenceFormat
  delete result.evidenceBinding
  return result
}

export type StoredMerchantStockCheckpoint = NonNullable<
  MerchantInventoryProduct["organizerStockCheckpoint"]
>
export function merchantStockCheckpointKey(id: string) {
  return `merchant-stock-checkpoint:${id}`
}

/** Keep immutable rumor bytes recoverable, without a second plaintext DB copy. */
export async function sealMerchantStockCheckpoint(
  store: CommerceInboxStore,
  checkpoint: StoredMerchantStockCheckpoint
): Promise<StoredMerchantStockCheckpoint> {
  store.assertCurrent()
  if (!checkpoint.rumor) {
    if (!checkpoint.rumorId || !checkpoint.sealedRumor)
      throw new Error("Private checkpoint evidence is unavailable.")
    return checkpoint
  }
  const sealedRumor = await store.seal(
    checkpoint.rumor,
    merchantStockCheckpointKey(checkpoint.rumor.id)
  )
  const result = { ...checkpoint, rumorId: checkpoint.rumor.id, sealedRumor }
  delete result.rumor
  return result
}
