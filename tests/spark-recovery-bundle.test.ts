import { describe, expect, it } from "bun:test"

import { formatSparkRecoveryBundleForClipboard } from "../apps/market/src/lib/spark-recovery-bundle"

describe("Spark recovery bundle", () => {
  it("keeps the recovery phrase, account number, and network together", () => {
    expect(
      formatSparkRecoveryBundleForClipboard({
        mnemonic: "synthetic recovery words",
        accountNumber: 7,
        network: "mainnet",
      })
    ).toBe(
      "synthetic recovery words\nSpark account number: 7\nSpark network: mainnet"
    )
  })

  it("records regtest explicitly", () => {
    expect(
      formatSparkRecoveryBundleForClipboard({
        mnemonic: "synthetic recovery words",
        accountNumber: 0,
        network: "regtest",
      })
    ).toContain("Spark network: regtest")
  })
})
