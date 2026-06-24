import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import { getWalletCapabilityPills } from "../apps/market/src/lib/wallet-capabilities"

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
    expect(content).toContain("getWalletCapabilityPills")
    expect(content).toContain(
      'balance.status === "available" || balance.status === "error"'
    )
  })

  it("renders advertised Alby NWC permissions as supported capability pills", () => {
    const capabilities = getWalletCapabilityPills({
      methods: [
        "get_balance",
        "get_budget",
        "get_info",
        "list_transactions",
        "lookup_invoice",
        "make_invoice",
        "pay_invoice",
        "sign_message",
      ],
      notifications: ["payment_received", "payment_sent"],
    })

    expect(capabilities).toEqual([
      {
        id: "method:get_balance",
        label: "Read balance",
        variant: "success",
      },
      {
        id: "method:get_budget",
        label: "Read budget",
        variant: "success",
      },
      {
        id: "method:get_info",
        label: "Read node info",
        variant: "success",
      },
      {
        id: "method:list_transactions",
        label: "Read transaction history",
        variant: "success",
      },
      {
        id: "method:lookup_invoice",
        label: "Lookup invoices",
        variant: "success",
      },
      {
        id: "method:make_invoice",
        label: "Create invoices",
        variant: "success",
      },
      {
        id: "method:pay_invoice",
        label: "Send payments",
        variant: "success",
      },
      {
        id: "method:sign_message",
        label: "Sign messages",
        variant: "success",
      },
      {
        id: "notification:wallet",
        label: "Wallet notifications",
        variant: "success",
      },
    ])
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
    expect(content).toContain("Automatic wallet payment will be skipped")
    expect(content).toContain("Send order and show invoice")
    expect(content).toContain("if (canAttemptLightningPayment)")
  })
})
