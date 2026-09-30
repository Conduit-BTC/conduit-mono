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

export function checkoutAttributionTelemetryProperties(
  attribution?: CheckoutAttribution
): Record<string, string> {
  if (!attribution)
    return { source_method: "none", source_partner_status: "none" }
  const domain = attribution.sourceDomain
  const mappedPartner = domain ? resolveCheckoutPartnerDomain(domain) : null
  const partnerCode =
    attribution.sourceMethod === "claimed"
      ? mappedPartner
      : (resolveCheckoutPartnerCode(attribution.partnerCode) ?? mappedPartner)
  return {
    source_method: attribution.sourceMethod,
    source_partner_status: (domain ? mappedPartner : partnerCode)
      ? "active"
      : "unregistered",
    ...(domain
      ? {
          source_domain:
            mappedPartner || isBoundedCheckoutSourceDomain(domain)
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
  if (
    domain !== "other" &&
    (typeof domain !== "string" ||
      normalizeCheckoutSourceDomain(domain) !== domain)
  )
    return false
  const mapped =
    domain === "other" ? null : resolveCheckoutPartnerDomain(domain as string)
  if (status !== (mapped ? "active" : "unregistered")) return false
  if (
    !mapped &&
    domain !== "other" &&
    !isBoundedCheckoutSourceDomain(domain as string)
  )
    return false
  if (method === "claimed") return code === (mapped ?? undefined)
  // An observed domain never upgrades an explicit legacy code to domain approval.
  return code === undefined
    ? mapped === null
    : typeof code === "string" && resolveCheckoutPartnerCode(code) === code
}
