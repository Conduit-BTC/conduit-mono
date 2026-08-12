export function formatMerchantOrderAmount(
  amount: number,
  currency: string
): string {
  const normalizedCurrency = currency.trim().toUpperCase()
  if (normalizedCurrency === "SAT" || normalizedCurrency === "SATS") {
    return `${amount.toLocaleString()} sats`
  }
  return `${amount.toLocaleString()} ${normalizedCurrency}`
}
