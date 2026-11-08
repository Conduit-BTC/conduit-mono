import { normalizeCheckoutSourceDomain } from "./checkout-source-domain"
import {
  resolveCheckoutPartnerCode,
  resolveCheckoutPartnerDomain,
  type CheckoutPartnerRegistration,
} from "./checkout-partner-registry"

export type CheckoutSource = { domain: string; method: "claimed" | "referrer" }
export type CheckoutAttribution = {
  sourceDomain?: string
  sourceMethod: "claimed" | "referrer" | "partner"
  partnerCode?: string
}

export function resolveCheckoutAttribution(
  input: { source?: CheckoutSource; partner?: string },
  registry?: readonly CheckoutPartnerRegistration[]
): CheckoutAttribution | undefined {
  if (input.source) {
    const domain = normalizeCheckoutSourceDomain(input.source.domain)
    if (
      domain !== input.source.domain ||
      !["claimed", "referrer"].includes(input.source.method)
    )
      return undefined
    const mappedPartner = resolveCheckoutPartnerDomain(domain, registry)
    const partnerCode =
      input.source.method === "referrer"
        ? (resolveCheckoutPartnerCode(input.partner, registry) ?? mappedPartner)
        : mappedPartner
    return {
      sourceDomain: domain,
      sourceMethod: input.source.method,
      ...(partnerCode ? { partnerCode } : {}),
    }
  }
  const partnerCode = resolveCheckoutPartnerCode(input.partner, registry)
  return partnerCode ? { sourceMethod: "partner", partnerCode } : undefined
}
