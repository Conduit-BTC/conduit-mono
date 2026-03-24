import { config } from "../config"

export type LightningInvoiceNetwork =
  | "mainnet"
  | "testnet"
  | "signet"
  | "regtest"
  | "unknown"

export function normalizeLightningInvoice(invoice: string): string {
  return invoice.trim().replace(/^lightning:/i, "")
}

export function getLightningInvoiceNetwork(invoice: string): LightningInvoiceNetwork {
  const normalized = normalizeLightningInvoice(invoice).toLowerCase()

  if (normalized.startsWith("lnbc")) return "mainnet"
  if (normalized.startsWith("lnbcrt")) return "regtest"
  if (normalized.startsWith("lnsb")) return "signet"
  if (normalized.startsWith("lntb")) return "testnet"

  return "unknown"
}

export function getExpectedLightningNetworks(): LightningInvoiceNetwork[] {
  if (config.lightningNetwork === "mock") return ["regtest"]
  if (config.lightningNetwork === "mainnet") return ["mainnet"]
  if (config.lightningNetwork === "signet") return ["signet", "testnet"]
  if (config.lightningNetwork === "testnet") return ["testnet", "signet"]
  return []
}

export function isInvoiceCompatibleWithCurrentNetwork(invoice: string): boolean {
  const expected = getExpectedLightningNetworks()
  const actual = getLightningInvoiceNetwork(invoice)
  return expected.includes(actual)
}

export function getLightningNetworkMismatchMessage(invoice: string): string | null {
  const actual = getLightningInvoiceNetwork(invoice)
  if (actual === "unknown") {
    return "This invoice format could not be verified against the current Lightning network."
  }

  const expected = getExpectedLightningNetworks()
  if (expected.includes(actual)) return null

  const expectedLabel =
    config.lightningNetwork === "mock"
      ? "mock/regtest"
      : config.lightningNetwork === "signet"
        ? "signet/testnet"
        : config.lightningNetwork

  return `This invoice is for ${actual}, but Conduit is currently running in ${expectedLabel} mode.`
}
