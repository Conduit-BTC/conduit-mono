import { db, type CachedNip05Verification } from "../db"

export type Nip05VerificationStatus = "valid" | "invalid" | "unknown"

export interface ParsedNip05Identifier {
  name: string
  domain: string
  normalizedIdentifier: string
}

export interface Nip05VerificationResult {
  pubkey: string
  nip05: string
  normalizedIdentifier: string
  status: Nip05VerificationStatus
  reason?: string
  checkedAt: number
  expiresAt: number
  source: "cache" | "network" | "syntax" | "unavailable"
}

type Nip05VerificationCache = {
  get: (id: string) => Promise<CachedNip05Verification | undefined>
  put: (row: CachedNip05Verification) => Promise<void>
}

type Nip05VerificationOptions = {
  cache?: Nip05VerificationCache
  fetcher?: typeof fetch
  now?: () => number
}

export const NIP05_VERIFICATION_VALID_TTL_MS = 6 * 60 * 60_000
export const NIP05_VERIFICATION_INVALID_TTL_MS = 30 * 60_000
export const NIP05_VERIFICATION_UNKNOWN_TTL_MS = 5 * 60_000

const HEX_PUBKEY_PATTERN = /^[0-9a-f]{64}$/i

function defaultCache(): Nip05VerificationCache | null {
  if (typeof window === "undefined") return null

  return {
    get: (id) => db.nip05Verifications.get(id),
    put: (row) => db.nip05Verifications.put(row).then(() => undefined),
  }
}

function verificationTtl(status: Nip05VerificationStatus): number {
  switch (status) {
    case "valid":
      return NIP05_VERIFICATION_VALID_TTL_MS
    case "invalid":
      return NIP05_VERIFICATION_INVALID_TTL_MS
    case "unknown":
      return NIP05_VERIFICATION_UNKNOWN_TTL_MS
  }
}

function normalizePubkey(pubkey: string): string | null {
  const normalized = pubkey.trim().toLowerCase()
  return HEX_PUBKEY_PATTERN.test(normalized) ? normalized : null
}

export function parseNip05Identifier(
  nip05: string | null | undefined
): ParsedNip05Identifier | null {
  const trimmed = nip05?.trim()
  if (!trimmed || trimmed.length > 100 || /\s/.test(trimmed)) return null

  const parts = trimmed.split("@")
  if (parts.length !== 2) return null

  const [rawName, rawDomain] = parts
  const name = rawName.trim()
  const domain = rawDomain.trim().toLowerCase()

  if (!name || !domain || domain.startsWith(".") || domain.endsWith(".")) {
    return null
  }

  if (!domain.includes(".") || /[/:]/.test(domain)) return null

  return {
    name,
    domain,
    normalizedIdentifier: `${name}@${domain}`,
  }
}

export function getNip05VerificationCacheId(
  pubkey: string,
  normalizedIdentifier: string
): string {
  return `${pubkey.toLowerCase()}:${normalizedIdentifier.toLowerCase()}`
}

function rowToResult(
  row: CachedNip05Verification,
  source: Nip05VerificationResult["source"]
): Nip05VerificationResult {
  return {
    pubkey: row.pubkey,
    nip05: row.nip05,
    normalizedIdentifier: row.normalizedIdentifier,
    status: row.status,
    reason: row.reason,
    checkedAt: row.checkedAt,
    expiresAt: row.expiresAt,
    source,
  }
}

function makeResult(
  input: {
    pubkey: string
    nip05: string
    normalizedIdentifier: string
    status: Nip05VerificationStatus
    reason?: string
    source: Nip05VerificationResult["source"]
  },
  now: number
): Nip05VerificationResult {
  return {
    ...input,
    checkedAt: now,
    expiresAt: now + verificationTtl(input.status),
  }
}

function resultToRow(result: Nip05VerificationResult): CachedNip05Verification {
  return {
    id: getNip05VerificationCacheId(result.pubkey, result.normalizedIdentifier),
    pubkey: result.pubkey,
    nip05: result.nip05,
    normalizedIdentifier: result.normalizedIdentifier,
    status: result.status,
    reason: result.reason,
    checkedAt: result.checkedAt,
    expiresAt: result.expiresAt,
    cachedAt: result.checkedAt,
  }
}

function readNamesMap(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || !("names" in value)) return null

  const names = (value as { names?: unknown }).names
  if (!names || typeof names !== "object" || Array.isArray(names)) return null

  return names as Record<string, unknown>
}

function getClaimedPubkey(
  names: Record<string, unknown>,
  name: string
): string | null {
  const exact = names[name]
  const lower = names[name.toLowerCase()]
  const claimed = typeof exact === "string" ? exact : lower

  if (typeof claimed !== "string") return null

  const normalized = claimed.trim().toLowerCase()
  return HEX_PUBKEY_PATTERN.test(normalized) ? normalized : null
}

export async function getNip05Verification(
  input: {
    pubkey: string
    nip05: string
  },
  options: Nip05VerificationOptions = {}
): Promise<Nip05VerificationResult> {
  const checkedAt = options.now?.() ?? Date.now()
  const pubkey = normalizePubkey(input.pubkey)
  const parsed = parseNip05Identifier(input.nip05)

  if (!parsed) {
    return makeResult(
      {
        pubkey: input.pubkey.trim().toLowerCase(),
        nip05: input.nip05.trim(),
        normalizedIdentifier: input.nip05.trim().toLowerCase(),
        status: "invalid",
        reason: "malformed_identifier",
        source: "syntax",
      },
      checkedAt
    )
  }

  if (!pubkey) {
    return makeResult(
      {
        pubkey: input.pubkey.trim().toLowerCase(),
        nip05: input.nip05.trim(),
        normalizedIdentifier: parsed.normalizedIdentifier,
        status: "unknown",
        reason: "malformed_pubkey",
        source: "syntax",
      },
      checkedAt
    )
  }

  const cacheId = getNip05VerificationCacheId(
    pubkey,
    parsed.normalizedIdentifier
  )
  const cache = options.cache ?? defaultCache()
  let cached: CachedNip05Verification | undefined
  try {
    cached = await cache?.get(cacheId)
  } catch {
    cached = undefined
  }

  if (cached && cached.expiresAt > checkedAt) {
    return rowToResult(cached, "cache")
  }

  const fetcher = options.fetcher ?? globalThis.fetch
  if (!fetcher) {
    return makeResult(
      {
        pubkey,
        nip05: input.nip05.trim(),
        normalizedIdentifier: parsed.normalizedIdentifier,
        status: "unknown",
        reason: "fetch_unavailable",
        source: "unavailable",
      },
      checkedAt
    )
  }

  const url = `https://${parsed.domain}/.well-known/nostr.json?name=${encodeURIComponent(parsed.name)}`
  let result: Nip05VerificationResult

  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
    })

    if (!response.ok) {
      result = makeResult(
        {
          pubkey,
          nip05: input.nip05.trim(),
          normalizedIdentifier: parsed.normalizedIdentifier,
          status: "invalid",
          reason: `http_${response.status}`,
          source: "network",
        },
        checkedAt
      )
    } else {
      const names = readNamesMap(await response.json())
      const claimedPubkey = names ? getClaimedPubkey(names, parsed.name) : null

      result = makeResult(
        {
          pubkey,
          nip05: input.nip05.trim(),
          normalizedIdentifier: parsed.normalizedIdentifier,
          status: claimedPubkey === pubkey ? "valid" : "invalid",
          reason: claimedPubkey === pubkey ? undefined : "pubkey_mismatch",
          source: "network",
        },
        checkedAt
      )
    }
  } catch {
    result = makeResult(
      {
        pubkey,
        nip05: input.nip05.trim(),
        normalizedIdentifier: parsed.normalizedIdentifier,
        status: "unknown",
        reason: "network_error",
        source: "network",
      },
      checkedAt
    )
  }

  try {
    await cache?.put(resultToRow(result))
  } catch {
    // Verification cache is a performance hint, not a source of truth.
  }

  return result
}
