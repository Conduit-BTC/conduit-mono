import {
  type CommerceResult,
  getMerchantStorefront,
  type Product,
} from "@conduit/core"

export async function fetchStoreProducts(
  pubkey: string,
  accountPubkey?: string | null,
  authenticatedPubkey?: string | null
): Promise<CommerceResult<Product[]>> {
  const result = await getMerchantStorefront({
    merchantPubkey: pubkey,
    accountPubkey,
    authenticatedPubkey,
  })
  return {
    data: result.data.map((record) => record.product),
    meta: result.meta,
  }
}
