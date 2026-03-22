import {
  type CommerceResult,
  getMerchantStorefront,
  type Product,
} from "@conduit/core"

export async function fetchStoreProducts(pubkey: string): Promise<CommerceResult<Product[]>> {
  const result = await getMerchantStorefront({ merchantPubkey: pubkey, limit: 50 })
  return {
    data: result.data.map((record) => record.product),
    meta: result.meta,
  }
}
