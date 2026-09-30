import {
  isBoundedCheckoutSourceDomain,
  normalizeCheckoutSourceDomain,
} from "./checkout-source-domain"
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
    const partnerCode = resolveCheckoutPartnerDomain(domain, registry)
    return {
      sourceDomain: domain,
      sourceMethod: input.source.method,
      ...(partnerCode ? { partnerCode } : {}),
    }
  }
  const partnerCode = resolveCheckoutPartnerCode(input.partner, registry)
  return partnerCode ? { sourceMethod: "partner", partnerCode } : undefined
}

export function checkoutAttributionTelemetryProperties(
  attribution?: CheckoutAttribution
): Record<string, string> {
  if (!attribution)
    return { source_method: "none", source_partner_status: "none" }
  const domain = attribution.sourceDomain
  const partnerCode = domain
    ? resolveCheckoutPartnerDomain(domain)
    : resolveCheckoutPartnerCode(attribution.partnerCode)
  return {
    source_method: attribution.sourceMethod,
    source_partner_status: partnerCode ? "active" : "unregistered",
    ...(domain
      ? {
          source_domain:
            partnerCode || isBoundedCheckoutSourceDomain(domain)
              ? domain
              : "other",
        }
      : {}),
    ...(partnerCode ? { partner_code: partnerCode } : {}),
  }
}

/** Client and ingest independently reject inconsistent or forged activation labels. */
export function hasValidCheckoutAttributionTelemetry(
  properties: Readonly<Record<string, unknown>>
): boolean {
  const domain = properties.source_domain
  const method = properties.source_method
  const status = properties.source_partner_status
  const code = properties.partner_code
  if (domain === undefined && method === undefined && status === undefined)
    return true // Existing funnel/partner-only contracts.
  if (method === "none")
    return status === "none" && domain === undefined && code === undefined
  if (method === "partner")
    return (
      domain === undefined &&
      status === "active" &&
      typeof code === "string" &&
      resolveCheckoutPartnerCode(code) === code
    )
  if (method !== "claimed" && method !== "referrer") return false
  if (domain === "other") return status === "unregistered" && code === undefined
  if (
    typeof domain !== "string" ||
    normalizeCheckoutSourceDomain(domain) !== domain
  )
    return false
  const mapped = resolveCheckoutPartnerDomain(domain)
  if (mapped) return status === "active" && code === mapped
  return (
    status === "unregistered" &&
    code === undefined &&
    isBoundedCheckoutSourceDomain(domain)
  )
}
