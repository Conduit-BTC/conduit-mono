import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("Market wallet route contracts", () => {
  it("lets the shared NWC parser validate wallet connection strings", async () => {
    const content = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(content).toContain("parseNwcUri(trimmed)")
    expect(content).not.toContain('startsWith("nostr+walletconnect://")')
  })

  it("renders connected wallet balance copy and refresh controls on the wallet route", async () => {
    const content = await readFile("apps/market/src/routes/wallet.tsx", "utf8")

    expect(content).toContain("Connected wallet balance")
    expect(content).toContain("formatWalletMsatsAsSats")
    expect(content).toContain("useWallet({ refreshBalance: true })")
    expect(content).toContain("wallet.refreshBalance")
    expect(content).toContain("Wallet does not advertise get_balance")
    expect(content).toContain("Read balance")
    expect(content).toContain("Read budget")
    expect(content).toContain(
      'balance.status === "available" || balance.status === "error"'
    )
  })

  it("does not put wallet balance in the global Market header by default", async () => {
    const content = await readFile(
      "apps/market/src/components/MarketHeader.tsx",
      "utf8"
    )

    expect(content).not.toContain("Connected wallet balance")
    expect(content).not.toContain("balanceMsats")
    expect(content).not.toContain("refreshBalance: true")
  })

  it("opts checkout into wallet readiness reads for zap out", async () => {
    const content = await readFile(
      "apps/market/src/routes/checkout.tsx",
      "utf8"
    )

    expect(content).toContain(
      "const wallet = useWallet({ refreshBalance: true })"
    )
    expect(content).toContain("Wallet balance")
    expect(content).toContain("getKnownWalletPaymentConstraint")
  })
})
