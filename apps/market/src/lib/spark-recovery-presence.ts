export type SparkRecoveryPresence = "ready" | "missing" | "unavailable"

export const SPARK_RECOVERY_PRESENCE_TIMEOUT_MS = 5_000

/** A read-only local preflight. A stalled or failed read cannot prove absence. */
export async function checkSparkRecoveryPresence(
  walletId: string,
  hasRecovery: (walletId: string) => Promise<boolean>,
  timeoutMs = SPARK_RECOVERY_PRESENCE_TIMEOUT_MS
): Promise<SparkRecoveryPresence> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async (): Promise<SparkRecoveryPresence> => {
    try {
      return (await hasRecovery(walletId)) ? "ready" : "missing"
    } catch {
      return "unavailable"
    }
  }
  const bound = new Promise<SparkRecoveryPresence>((resolve) => {
    timer = setTimeout(() => resolve("unavailable"), timeoutMs)
  })
  try {
    return await Promise.race([read(), bound])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
