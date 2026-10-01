import { normalizeCheckoutSourceDomain } from "./checkout-source-domain"

/** Reviewed public identifiers only. Activation requires manual domain-control verification. */
export type CheckoutPartnerRegistration = {
  code: string
  account: string
  active: boolean
  domains?: readonly string[]
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

/** A domain never inherits a different code supplied in the same fragment. */
export function resolveCheckoutPartnerDomain(
  domain: string | null,
  registry: readonly CheckoutPartnerRegistration[] = checkoutPartnerRegistry
): string | null {
  if (
    !domain ||
    normalizeCheckoutSourceDomain(domain) !== domain ||
    registry.length > 64
  )
    return null
  const activeCodes = new Set(activeCheckoutPartnerCodes(registry))
  const matches = registry.filter(
    (entry) =>
      activeCodes.has(entry.code) &&
      entry.domains &&
      entry.domains.length <= 8 &&
      entry.domains.every(
        (item) => normalizeCheckoutSourceDomain(item) === item
      ) &&
      entry.domains.includes(domain)
  )
  return matches.length === 1 ? matches[0]!.code : null
}
