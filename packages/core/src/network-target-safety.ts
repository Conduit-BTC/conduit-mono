const MAX_UNTRUSTED_NETWORK_URL_LENGTH = 4_096
const PUBLIC_MEDIA_PROTOCOLS = new Set(["http:", "https:"])
const PUBLIC_HTTPS_PROTOCOLS = new Set(["https:"])
const PUBLIC_WEBSOCKET_PROTOCOLS = new Set(["wss:"])

const SPECIAL_USE_HOSTNAME_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "home",
  "lan",
  "arpa",
  "test",
  "invalid",
  "example",
  "example.com",
  "example.net",
  "example.org",
  "alt",
  "onion",
] as const

function parseIpv4Address(hostname: string): number | null {
  const parts = hostname.split(".")
  if (parts.length !== 4) return null

  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0
}

function ipv4Octets(value: number): [number, number, number, number] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]
}

function isPublicIpv4Address(value: number): boolean {
  const [a, b, c] = ipv4Octets(value)

  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 88 && c === 99) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 31 && c === 196) return false
  if (a === 192 && b === 52 && c === 193) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false

  return true
}

function parseIpv6Address(hostname: string): bigint | null {
  const unbracketed =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  if (!unbracketed.includes(":")) return null

  const doubleColonIndex = unbracketed.indexOf("::")
  if (
    doubleColonIndex !== -1 &&
    doubleColonIndex !== unbracketed.lastIndexOf("::")
  ) {
    return null
  }

  const [leftRaw, rightRaw = ""] =
    doubleColonIndex === -1
      ? [unbracketed]
      : [
          unbracketed.slice(0, doubleColonIndex),
          unbracketed.slice(doubleColonIndex + 2),
        ]
  const left = leftRaw ? leftRaw.split(":") : []
  const right = rightRaw ? rightRaw.split(":") : []
  const missing = 8 - left.length - right.length
  if (
    (doubleColonIndex === -1 && missing !== 0) ||
    (doubleColonIndex !== -1 && missing < 1)
  ) {
    return null
  }

  const groups = [
    ...left,
    ...Array.from({ length: Math.max(0, missing) }, () => "0"),
    ...right,
  ]
  if (groups.length !== 8) return null

  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
    value = (value << 16n) | BigInt(`0x${group}`)
  }
  return value
}

function hasIpv6Prefix(
  value: bigint,
  prefix: bigint,
  prefixLength: number
): boolean {
  const shift = BigInt(128 - prefixLength)
  return value >> shift === prefix >> shift
}

const IPV6_DOCUMENTATION_PREFIX = 0x20010db8000000000000000000000000n
const IPV6_TEREDO_PREFIX = 0x20010000000000000000000000000000n
const IPV6_6TO4_PREFIX = 0x20020000000000000000000000000000n
const IPV6_BENCHMARK_PREFIX = 0x20010002000000000000000000000000n
const IPV6_DOCUMENTATION_V2_PREFIX = 0x3fff0000000000000000000000000000n

function isPublicIpv6Address(value: bigint): boolean {
  // Globally routable unicast space is currently within 2000::/3. Keeping
  // special-purpose and transition ranges out avoids alternate local-address
  // encodings without pretending to perform DNS or routing-policy checks.
  if (value >> 125n !== 1n) return false
  if (hasIpv6Prefix(value, IPV6_DOCUMENTATION_PREFIX, 32)) return false
  if (hasIpv6Prefix(value, IPV6_TEREDO_PREFIX, 32)) return false
  if (hasIpv6Prefix(value, IPV6_6TO4_PREFIX, 16)) return false
  if (hasIpv6Prefix(value, IPV6_BENCHMARK_PREFIX, 48)) return false
  if (hasIpv6Prefix(value, IPV6_DOCUMENTATION_V2_PREFIX, 20)) return false
  return true
}

function normalizeHostnameForClassification(hostname: string): string {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/[\u3002\uff0e\uff61]/g, ".")
    .replace(/\.$/, "")
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized
}

/**
 * Return whether a URL hostname is lexically limited to a public-network
 * destination. This intentionally does not claim to resolve DNS, redirects,
 * or rebinding; callers that need that guarantee must mediate the request on a
 * trusted server and validate every resolved address and redirect hop.
 */
export function isPublicNetworkHostname(hostname: string): boolean {
  const normalized = normalizeHostnameForClassification(hostname)
  if (!normalized || normalized.length > 253) return false

  const ipv4 = parseIpv4Address(normalized)
  if (ipv4 !== null) return isPublicIpv4Address(ipv4)

  const ipv6 = parseIpv6Address(normalized)
  if (ipv6 !== null) return isPublicIpv6Address(ipv6)
  if (normalized.includes(":")) return false

  // Numeric-looking values that did not parse as canonical IPv4 are not
  // treated as DNS names. WHATWG URL parsing canonicalizes valid decimal,
  // octal, hexadecimal, and shortened IPv4 forms before this point.
  if (/^(?:0x[0-9a-f]+|[0-9.]+)$/i.test(normalized)) return false

  if (
    SPECIAL_USE_HOSTNAME_SUFFIXES.some(
      (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`)
    )
  ) {
    return false
  }

  const labels = normalized.split(".")
  if (labels.length < 2) return false
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  )
}

function normalizePublicNetworkUrl(
  raw: unknown,
  allowedProtocols: ReadonlySet<string>,
  options: { allowFragment: boolean }
): string | null {
  if (typeof raw !== "string") return null
  if (
    !raw ||
    raw !== raw.trim() ||
    raw.length > MAX_UNTRUSTED_NETWORK_URL_LENGTH
  ) {
    return null
  }

  try {
    const url = new URL(raw)
    if (
      !allowedProtocols.has(url.protocol) ||
      url.username ||
      url.password ||
      (!options.allowFragment && url.hash) ||
      !isPublicNetworkHostname(url.hostname)
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

/** Normalize an automatically loaded, untrusted public HTTP(S) media URL. */
export function normalizePublicMediaUrl(raw: unknown): string | null {
  return normalizePublicNetworkUrl(raw, PUBLIC_MEDIA_PROTOCOLS, {
    allowFragment: true,
  })
}

/** Normalize an untrusted HTTPS endpoint before a programmatic request. */
export function normalizePublicHttpsUrl(raw: unknown): string | null {
  return normalizePublicNetworkUrl(raw, PUBLIC_HTTPS_PROTOCOLS, {
    allowFragment: false,
  })
}

/** Normalize a relay hint learned from somebody else's signed event. */
export function normalizePublicWebSocketUrl(raw: unknown): string | null {
  return normalizePublicNetworkUrl(raw, PUBLIC_WEBSOCKET_PROTOCOLS, {
    allowFragment: false,
  })
}
