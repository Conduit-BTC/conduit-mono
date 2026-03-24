import { config } from "../config"

export type LightningInvoiceNetwork =
  | "mainnet"
  | "testnet"
  | "signet"
  | "regtest"
  | "unknown"

export type DecodedLightningInvoiceAmount = {
  msats: number | null
  sats: number | null
  currency: "SATS" | "MSATS" | null
}

const SATS_PER_BTC = 100_000_000
const MSATS_PER_BTC = 100_000_000_000

function normalizeCurrencyCode(currency: string): string {
  return currency.trim().toUpperCase()
}

export function isSatsCurrency(currency: string): boolean {
  const normalized = normalizeCurrencyCode(currency)
  return normalized === "SAT" || normalized === "SATS"
}

export function isUsdCurrency(currency: string): boolean {
  return normalizeCurrencyCode(currency) === "USD"
}

export function convertCommerceAmountToSats(
  amount: number,
  currency: string,
  btcUsdRate: number | null
): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null

  if (isSatsCurrency(currency)) {
    return Math.round(amount)
  }

  if (isUsdCurrency(currency)) {
    if (!btcUsdRate || !Number.isFinite(btcUsdRate) || btcUsdRate <= 0) return null
    return Math.round((amount / btcUsdRate) * SATS_PER_BTC)
  }

  return null
}

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

export function decodeLightningInvoiceAmount(invoice: string): DecodedLightningInvoiceAmount {
  const normalized = normalizeLightningInvoice(invoice).toLowerCase()
  const match = normalized.match(/^ln(?:bc|tb|sb|bcrt)(\d+)?([munp]?)1/)

  if (!match) {
    return { msats: null, sats: null, currency: null }
  }

  const [, rawAmount, rawUnit] = match
  if (!rawAmount) {
    return { msats: null, sats: null, currency: null }
  }

  try {
    const amount = BigInt(rawAmount)
    let msatsBig: bigint

    switch (rawUnit) {
      case "":
        msatsBig = amount * BigInt(MSATS_PER_BTC)
        break
      case "m":
        msatsBig = amount * 100_000_000n
        break
      case "u":
        msatsBig = amount * 100_000n
        break
      case "n":
        msatsBig = amount * 100n
        break
      case "p":
        if (amount % 10n !== 0n) {
          return { msats: null, sats: null, currency: null }
        }
        msatsBig = amount / 10n
        break
      default:
        return { msats: null, sats: null, currency: null }
    }

    if (msatsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { msats: null, sats: null, currency: null }
    }

    const msats = Number(msatsBig)
    if (msats % 1000 === 0) {
      return {
        msats,
        sats: msats / 1000,
        currency: "SATS",
      }
    }

    return {
      msats,
      sats: null,
      currency: "MSATS",
    }
  } catch {
    return { msats: null, sats: null, currency: null }
  }
}
