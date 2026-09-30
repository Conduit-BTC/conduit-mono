/** Public, reviewed source codes. Add a code only after assigning it to one account. */
export type CheckoutPartnerRegistration = {
  code: string
  account: string
  active: boolean
}

export const checkoutPartnerRegistry: readonly CheckoutPartnerRegistration[] =
  []

export function activeCheckoutPartnerCodes(
  registry: readonly CheckoutPartnerRegistration[] = checkoutPartnerRegistry
): string[] {
  if (registry.length > 64) return []
  const counts = new Map<string, number>()
  for (const entry of registry) {
    if (
      !entry.active ||
      !entry.account ||
      !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(entry.code)
    )
      continue
    counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count === 1).map(([code]) => code)
}

export function resolveCheckoutPartnerCode(
  claim: string | undefined,
  registry: readonly CheckoutPartnerRegistration[] = checkoutPartnerRegistry
): string | null {
  if (!claim || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(claim)) return null
  return activeCheckoutPartnerCodes(registry).includes(claim) ? claim : null
}
