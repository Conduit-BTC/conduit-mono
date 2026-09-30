/** Best-effort per-isolate hourly cardinality bound. No storage, IPs or visitor keys. */
export function createCheckoutSourceBudget(maxDomains = 64) {
  let hour = -1
  const domains = new Set<string>()
  return (properties: Record<string, unknown>, now = Date.now()): void => {
    const currentHour = Math.floor(now / 3_600_000)
    if (currentHour !== hour) {
      hour = currentHour
      domains.clear()
    }
    const domain = properties.source_domain
    if (
      typeof domain !== "string" ||
      domain === "other" ||
      properties.source_partner_status === "active"
    )
      return
    if (domains.has(domain)) return
    if (domains.size >= maxDomains) {
      properties.source_domain = "other"
      return
    }
    domains.add(domain)
  }
}
