import { config } from "../config"
import {
  isSatsLikeCurrency,
  isUsdCurrencyCode,
  normalizeCommercePrice,
} from "../pricing"

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

const MSATS_PER_BTC = 100_000_000_000
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
]

export function isSatsCurrency(currency: string): boolean {
  return isSatsLikeCurrency(currency)
}

export function isUsdCurrency(currency: string): boolean {
  return isUsdCurrencyCode(currency)
}

export function convertCommerceAmountToSats(
  amount: number,
  currency: string,
  btcUsdRate: number | null
): number | null {
  const normalized = normalizeCommercePrice(amount, currency, btcUsdRate)
  return normalized.status === "ok" ? normalized.sats : null
}

export function normalizeLightningInvoice(invoice: string): string {
  return invoice.trim().replace(/^lightning:/i, "")
}

function bech32Polymod(values: number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index += 1) {
      if ((top >> index) & 1) {
        chk ^= BECH32_GENERATORS[index]!
      }
    }
  }
  return chk
}

function bech32HrpExpand(hrp: string): number[] {
  const values: number[] = []
  for (let index = 0; index < hrp.length; index += 1) {
    values.push(hrp.charCodeAt(index) >> 5)
  }
  values.push(0)
  for (let index = 0; index < hrp.length; index += 1) {
    values.push(hrp.charCodeAt(index) & 31)
  }
  return values
}

function isValidBech32Invoice(invoice: string): boolean {
  if (!invoice || invoice !== invoice.toLowerCase()) return false

  const separatorIndex = invoice.lastIndexOf("1")
  if (separatorIndex <= 0 || separatorIndex + 7 > invoice.length) return false

  const hrp = invoice.slice(0, separatorIndex)
  const dataPart = invoice.slice(separatorIndex + 1)
  const values: number[] = []

  for (const char of dataPart) {
    const value = BECH32_CHARSET.indexOf(char)
    if (value === -1) return false
    values.push(value)
  }

  return bech32Polymod([...bech32HrpExpand(hrp), ...values]) === 1
}

export function getLightningInvoiceNetwork(
  invoice: string
): LightningInvoiceNetwork {
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

export function isInvoiceCompatibleWithCurrentNetwork(
  invoice: string
): boolean {
  const expected = getExpectedLightningNetworks()
  const actual = getLightningInvoiceNetwork(invoice)
  return expected.includes(actual)
}

export function getLightningNetworkMismatchMessage(
  invoice: string
): string | null {
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

export function decodeLightningInvoiceAmount(
  invoice: string
): DecodedLightningInvoiceAmount {
  const normalized = normalizeLightningInvoice(invoice).toLowerCase()
  if (!isValidBech32Invoice(normalized)) {
    return { msats: null, sats: null, currency: null }
  }
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
