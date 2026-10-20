import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import {
  db,
  type ConduitDB,
  type MerchantInventoryAcceptedOrder,
  type MerchantInventoryProduct,
} from "../db"
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
  accepted: MerchantInventoryAcceptedOrder,
  database: ConduitDB = db
): Promise<string> {
  const store = merchantAcceptanceStore(accepted.merchantPubkey, database)
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
  const db = store.database
  const rows = await db.merchantInventoryAcceptedOrders
    .where("merchantPubkey")
    .equals(store.principal)
    .toArray()
  for (const original of rows) {
    store.assertCurrent()
    if (original.evidenceFormat === FORMAT) continue
    const protectedOrder = await protectMerchantAcceptanceRecord(
      store,
      original
    )
    await db.transaction(
      "rw",
      [db.merchantInventoryAcceptedOrders, db.eventMarketOrganizerStockEntries],
      async () => {
        store.assertCurrent()
        const current = await db.merchantInventoryAcceptedOrders.get(
          original.orderId
        )
        if (!current || current.evidenceFormat === FORMAT) return
        if (JSON.stringify(current) !== JSON.stringify(original))
          throw new Error(
            "Accepted order changed during privacy migration. Retry the original order."
          )
        const entries = await db.eventMarketOrganizerStockEntries
          .where("accountPubkey")
          .equals(store.principal)
          .filter(
            (entry) => entry.imported && entry.orderId === current.orderId
          )
          .toArray()
        for (const entry of entries) {
          if (entry.evidence !== current.evidence)
            throw new Error("Imported order evidence requires reconciliation.")
          await db.eventMarketOrganizerStockEntries.update(entry.id, {
            evidence: protectedOrder.evidenceBinding!,
          })
        }
        await db.merchantInventoryAcceptedOrders.put(protectedOrder)
        store.assertCurrent()
      }
    )
  }
  const products = await db.merchantInventoryProducts
    .where("merchantPubkey")
    .equals(store.principal)
    .toArray()
  for (const product of products) {
    const original = product.organizerStockCheckpoint
    if (!original?.rumor) continue
    const sealed = await sealMerchantStockCheckpoint(store, original)
    await db.transaction("rw", db.merchantInventoryProducts, async () => {
      store.assertCurrent()
      const current = await db.merchantInventoryProducts.get(product.coordinate)
      if (!current?.organizerStockCheckpoint?.rumor) return
      if (
        JSON.stringify(current.organizerStockCheckpoint) !==
        JSON.stringify(original)
      )
        throw new Error(
          "Private checkpoint changed during repair. Retry the saved work."
        )
      await db.merchantInventoryProducts.update(product.coordinate, {
        organizerStockCheckpoint: sealed,
      })
      store.assertCurrent()
    })
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
  database: ConduitDB
): Promise<MerchantInventoryAcceptedOrder> {
  if (!accepted.evidenceFormat) return structuredClone(accepted)
  const evidence = await openMerchantAcceptanceEvidence(accepted, database)
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
