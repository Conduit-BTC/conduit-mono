import {
  DexieCheckoutSparkSettledRepository,
  projectCheckoutSparkMerchantSettlement,
  type CheckoutSparkMerchantSettlementProjection,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"

export type MerchantCheckoutSparkRetirementRead =
  "retired" | "not_retired" | "unavailable"

/** Read only saved provider facts; never opens a wallet or changes payment state. */
export async function readMerchantCheckoutSparkVerification(
  principalPubkey: string,
  candidates: readonly MerchantCheckoutSparkRecoveryCandidate[],
  repository: Pick<
    DexieCheckoutSparkSettledRepository,
    "loadMerchantSettlement" | "load"
  > = new DexieCheckoutSparkSettledRepository()
): Promise<{
  verified: Record<string, CheckoutSparkMerchantSettlementProjection>
  retirement: Record<string, MerchantCheckoutSparkRetirementRead>
  unavailable: boolean
}> {
  const rows = await Promise.all(
    candidates
      // Recovery v2 is the initial settled-plan envelope; v3 is its progress.
      // Only recovery v1 belongs to the older, incompatible plan repository.
      .filter((candidate) => candidate.schemaVersion !== 1)
      .map(async (candidate) => {
        let projection: CheckoutSparkMerchantSettlementProjection | null = null
        try {
          const record = await repository.loadMerchantSettlement(
            principalPubkey,
            candidate.checkoutId,
            candidate.planDigest
          )
          projection = record
            ? projectCheckoutSparkMerchantSettlement(record)
            : null
          // Retirement is a separate local terminal fact, not an inference from
          // paid totals. Bind it to this principal's exact saved order evidence.
          const snapshot = await repository.load(
            candidate.checkoutId,
            candidate.planDigest
          )
          const retirement: MerchantCheckoutSparkRetirementRead =
            snapshot.status !== "retired"
              ? "not_retired"
              : snapshot.planDigest === candidate.planDigest &&
                  Number.isSafeInteger(snapshot.retiredAt) &&
                  snapshot.retiredAt >= 0 &&
                  record?.merchantPubkey === principalPubkey &&
                  record.checkoutId === candidate.checkoutId &&
                  record.orderId === candidate.orderId &&
                  record.planDigest === candidate.planDigest
                ? "retired"
                : "unavailable"
          return {
            digest: candidate.planDigest,
            failed: retirement === "unavailable",
            projection,
            retirement,
          }
        } catch {
          return {
            digest: candidate.planDigest,
            failed: true,
            projection,
            retirement: "unavailable" as const,
          }
        }
      })
  )
  const verified: Record<string, CheckoutSparkMerchantSettlementProjection> = {}
  const retirement: Record<string, MerchantCheckoutSparkRetirementRead> = {}
  for (const row of rows) {
    if (row.projection) verified[row.digest] = row.projection
    if (retirement[row.digest] !== "retired") {
      retirement[row.digest] = row.retirement
    }
  }
  return { verified, retirement, unavailable: rows.some((row) => row.failed) }
}
