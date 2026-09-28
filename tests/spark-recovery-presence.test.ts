import { describe, expect, it } from "bun:test"

import { checkSparkRecoveryPresence } from "../apps/market/src/lib/spark-recovery-presence"

describe("Spark recovery presence preflight", () => {
  it("distinguishes a present envelope from a fulfilled absence", async () => {
    expect(
      await checkSparkRecoveryPresence("wallet", async () => true, 20)
    ).toBe("ready")
    expect(
      await checkSparkRecoveryPresence("wallet", async () => false, 20)
    ).toBe("missing")
  })

  it("treats a rejected read as unavailable, not missing", async () => {
    expect(
      await checkSparkRecoveryPresence(
        "wallet",
        async () => {
          throw new Error("local storage unavailable")
        },
        20
      )
    ).toBe("unavailable")
  })

  it("bounds a stalled read and ignores its late result", async () => {
    let resolveRead: ((available: boolean) => void) | undefined
    const stalled = new Promise<boolean>((resolve) => {
      resolveRead = resolve
    })
    const outcome = await checkSparkRecoveryPresence("wallet", () => stalled, 5)
    expect(outcome).toBe("unavailable")
    resolveRead?.(true)
    await stalled
    expect(outcome).toBe("unavailable")
  })
})
