import {
  DexieCheckoutSparkSettledRepository,
  projectCheckoutSparkMerchantSettlement,
  type CheckoutSparkMerchantSettlementProjection,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"

/** Read only saved provider facts; never opens a wallet or changes payment state. */
export async function readMerchantCheckoutSparkVerification(
  principalPubkey: string,
  candidates: readonly MerchantCheckoutSparkRecoveryCandidate[],
  repository: Pick<
    DexieCheckoutSparkSettledRepository,
    "loadMerchantSettlement"
  > = new DexieCheckoutSparkSettledRepository()
): Promise<{
  verified: Record<string, CheckoutSparkMerchantSettlementProjection>
  unavailable: boolean
}> {
  const rows = await Promise.all(
    candidates
      // Recovery v2 is the initial settled-plan envelope; v3 is its progress.
      // Only recovery v1 belongs to the older, incompatible plan repository.
      .filter((candidate) => candidate.schemaVersion !== 1)
      .map(async (candidate) => {
        try {
          const record = await repository.loadMerchantSettlement(
            principalPubkey,
            candidate.checkoutId,
            candidate.planDigest
          )
          return {
            digest: candidate.planDigest,
            failed: false,
            projection: record
              ? projectCheckoutSparkMerchantSettlement(record)
              : null,
          }
        } catch {
          return {
            digest: candidate.planDigest,
            failed: true,
            projection: null,
          }
        }
      })
  )
  const verified: Record<string, CheckoutSparkMerchantSettlementProjection> = {}
  for (const row of rows) {
    if (row.projection) verified[row.digest] = row.projection
  }
  return { verified, unavailable: rows.some((row) => row.failed) }
}
