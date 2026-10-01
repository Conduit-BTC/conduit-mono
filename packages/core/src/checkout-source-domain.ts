import { parse } from "tldts"

/** Domain-only input. URL extraction is deliberately disabled at the PSL boundary. */
export function normalizeCheckoutSourceDomain(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null
  const input = value.trim()
  if (!input || /[\s:/?#@\\%\[\]]/u.test(input)) return null
  let hostname: string
  try {
    // WHATWG URL supplies browser/Worker-consistent IDNA conversion, only after
    // rejecting URL syntax. The resulting hostname is validated again below.
    hostname = new URL(`https://${input}`).hostname
      .toLowerCase()
      .replace(/\.$/, "")
  } catch {
    return null
  }
  if (
    hostname.length > 253 ||
    hostname
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null
  if (
    /(^|\.)(?:localhost|local|test|invalid|internal|lan|home|onion|alt|arpa|example)$/.test(
      hostname
    )
  )
    return null
  const result = parse(hostname, {
    extractHostname: false,
    validateHostname: true,
    allowPrivateDomains: true,
    detectIp: true,
  })
  if (result.isIp || (!result.isIcann && !result.isPrivate) || !result.domain)
    return null
  return result.domain
}

/** Only the hostname escapes this function; the referrer URL is never retained. */
export function checkoutSourceFromReferrer(value: string): string | null {
  if (!value || value.length > 8192) return null
  try {
    const url = new URL(value)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null
    return normalizeCheckoutSourceDomain(url.hostname)
  } catch {
    return null
  }
}
