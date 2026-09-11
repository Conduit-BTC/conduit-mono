import {
  type CommerceResult,
  getMerchantStorefront,
  type Product,
} from "@conduit/core"

export async function fetchStoreProducts(
  pubkey: string,
  accountPubkey?: string | null,
  authenticatedPubkey?: string | null,
  shouldContinue?: () => boolean
): Promise<CommerceResult<Product[]>> {
  const result = await getMerchantStorefront({
    merchantPubkey: pubkey,
    accountPubkey,
    authenticatedPubkey,
    shouldContinue,
  })
  return {
    data: result.data.map((record) => record.product),
    meta: result.meta,
  }
}
