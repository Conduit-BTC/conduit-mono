import { formatPrice, formatSats, type Product } from "@conduit/core"

const SATS_PER_BTC = 100_000_000

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase()
}

export function isSatsCurrency(currency: string): boolean {
  const code = normalizeCurrency(currency)
  return code === "SAT" || code === "SATS"
}

export function isUsdCurrency(currency: string): boolean {
  return normalizeCurrency(currency) === "USD"
}

export function getConfiguredBtcUsdRate(): number | null {
  const raw = import.meta.env.VITE_BTC_USD_RATE
  if (typeof raw !== "string") return null

  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null

  return parsed
}

function formatNativePrice(amount: number, currency: string): string {
  if (isSatsCurrency(currency)) return formatSats(amount)
  if (isUsdCurrency(currency)) return formatPrice(amount, "USD")

  return `${amount.toLocaleString()} ${normalizeCurrency(currency)}`
}

function formatApproxUsdFromSats(sats: number, btcUsdRate: number): string {
  const usd = (sats / SATS_PER_BTC) * btcUsdRate
  if (usd < 0.01) return "~$0.01"

  return `~${formatPrice(usd, "USD")}`
}

function formatApproxSatsFromUsd(usd: number, btcUsdRate: number): string {
  const sats = Math.round((usd / btcUsdRate) * SATS_PER_BTC)
  return `~${formatSats(sats)}`
}

export function getProductPriceDisplay(
  product: Pick<Product, "price" | "currency">,
  btcUsdRate: number | null = getConfiguredBtcUsdRate()
): { primary: string; secondary: string | null } {
  const primary = formatNativePrice(product.price, product.currency)

  if (!btcUsdRate) {
    return { primary, secondary: null }
  }

  if (isSatsCurrency(product.currency)) {
    return {
      primary,
      secondary: formatApproxUsdFromSats(product.price, btcUsdRate),
    }
  }

  if (isUsdCurrency(product.currency)) {
    return {
      primary,
      secondary: formatApproxSatsFromUsd(product.price, btcUsdRate),
    }
  }

  return { primary, secondary: null }
}

export function getComparablePriceValue(
  product: Pick<Product, "price" | "currency">,
  btcUsdRate: number | null = getConfiguredBtcUsdRate()
): number | null {
  if (isSatsCurrency(product.currency)) return product.price

  if (isUsdCurrency(product.currency)) {
    if (!btcUsdRate) return null
    return Math.round((product.price / btcUsdRate) * SATS_PER_BTC)
  }

  return null
}
