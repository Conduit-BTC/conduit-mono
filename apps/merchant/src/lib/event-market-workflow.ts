import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
} from "@conduit/core"

export type OrganizerCollectionMembershipAction = "accept" | "remove"

export interface SavedOrganizerEventMarketReference {
  reference: string
  title?: string
  savedAt: number
}

const EVENT_MARKET_STORAGE_PREFIX = "conduit:merchant:event-markets:v1"
const PRODUCT_COORDINATE_PATTERN = /^30402:[0-9a-f]{64}:.+$/i

type NormalizedSavedOrganizerEventMarketReference =
  SavedOrganizerEventMarketReference & {
    coordinate: string
    organizerPubkey: string
    relayHints: string[]
  }

export function getOrganizerEventMarketStorageKey(
  organizerPubkey: string
): string {
  return `${EVENT_MARKET_STORAGE_PREFIX}:${organizerPubkey.trim().toLowerCase()}`
}

function normalizeSavedReference(
  value: unknown
): NormalizedSavedOrganizerEventMarketReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as {
    reference?: unknown
    title?: unknown
    savedAt?: unknown
  }
  const rawReference =
    typeof candidate.reference === "string" ? candidate.reference.trim() : ""
  const decoded = decodeEventMarketReference(rawReference, [30405])
  if (
    !decoded ||
    typeof candidate.savedAt !== "number" ||
    !Number.isFinite(candidate.savedAt)
  ) {
    return null
  }

  const title =
    typeof candidate.title === "string" && candidate.title.trim()
      ? candidate.title.trim()
      : undefined
  return {
    reference:
      decoded.relayHints.length > 0
        ? encodeEventMarketNaddr(decoded.coordinate, decoded.relayHints)
        : decoded.coordinate,
    title,
    savedAt: candidate.savedAt,
    coordinate: decoded.coordinate,
    organizerPubkey: decoded.authorPubkey,
    relayHints: decoded.relayHints,
  }
}

function mergeSavedReferences(
  references: readonly NormalizedSavedOrganizerEventMarketReference[]
): SavedOrganizerEventMarketReference {
  const sorted = [...references].sort(
    (left, right) => right.savedAt - left.savedAt
  )
  const newest = sorted[0]!
  const relayHints = Array.from(
    new Set(sorted.flatMap((reference) => reference.relayHints))
  )
  return {
    reference:
      relayHints.length > 0
        ? encodeEventMarketNaddr(newest.coordinate, relayHints)
        : newest.coordinate,
    title: newest.title ?? sorted.find((reference) => reference.title)?.title,
    savedAt: newest.savedAt,
  }
}

export function loadSavedOrganizerEventMarkets(
  organizerPubkey: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!organizerPubkey.trim() || !storage) return []
  try {
    const raw = storage.getItem(
      getOrganizerEventMarketStorageKey(organizerPubkey)
    )
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    const normalizedOrganizer = organizerPubkey.trim().toLowerCase()
    const byCoordinate = new Map<
      string,
      NormalizedSavedOrganizerEventMarketReference[]
    >()
    for (const value of parsed) {
      const normalized = normalizeSavedReference(value)
      if (!normalized || normalized.organizerPubkey !== normalizedOrganizer)
        continue
      byCoordinate.set(normalized.coordinate, [
        ...(byCoordinate.get(normalized.coordinate) ?? []),
        normalized,
      ])
    }
    return Array.from(byCoordinate.values())
      .map(mergeSavedReferences)
      .sort((left, right) => right.savedAt - left.savedAt)
  } catch {
    return []
  }
}

export function rememberOrganizerEventMarket(
  organizerPubkey: string,
  entry: SavedOrganizerEventMarketReference,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!organizerPubkey.trim() || !storage) return []
  const normalized = normalizeSavedReference(entry)
  const normalizedOrganizer = organizerPubkey.trim().toLowerCase()
  if (!normalized || normalized.organizerPubkey !== normalizedOrganizer)
    return loadSavedOrganizerEventMarkets(organizerPubkey, storage)

  const current = loadSavedOrganizerEventMarkets(organizerPubkey, storage)
  const sameIdentity = current.flatMap((item) => {
    const existing = normalizeSavedReference(item)
    return existing?.coordinate === normalized.coordinate ? [existing] : []
  })
  const merged = mergeSavedReferences([normalized, ...sameIdentity])
  const next = [
    merged,
    ...current.filter((item) => {
      const existing = normalizeSavedReference(item)
      return existing?.coordinate !== normalized.coordinate
    }),
  ].sort((left, right) => right.savedAt - left.savedAt)
  try {
    storage.setItem(
      getOrganizerEventMarketStorageKey(organizerPubkey),
      JSON.stringify(next)
    )
  } catch {
    // The public coordinate remains usable for this session when storage is
    // unavailable. Relay evidence, not local storage, is authoritative.
  }
  return next
}

export function forgetOrganizerEventMarket(
  organizerPubkey: string,
  reference: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!organizerPubkey.trim() || !storage) return []
  const target = decodeEventMarketReference(reference, [30405])
  const next = loadSavedOrganizerEventMarkets(organizerPubkey, storage).filter(
    (item) => {
      const existing = decodeEventMarketReference(item.reference, [30405])
      return target
        ? existing?.coordinate !== target.coordinate
        : item.reference !== reference.trim()
    }
  )
  try {
    storage.setItem(
      getOrganizerEventMarketStorageKey(organizerPubkey),
      JSON.stringify(next)
    )
  } catch {
    // Keep local-storage failure from blocking organizer relay workflows.
  }
  return next
}

export function findSavedOrganizerEventMarketReference(
  references: readonly SavedOrganizerEventMarketReference[],
  reference: string
): SavedOrganizerEventMarketReference | undefined {
  const target = decodeEventMarketReference(reference, [30405])
  if (!target) return undefined
  return references.find(
    (item) =>
      decodeEventMarketReference(item.reference, [30405])?.coordinate ===
      target.coordinate
  )
}

export function updateOrganizerCollectionProducts(
  currentProductCoordinates: readonly string[],
  productCoordinate: string,
  action: OrganizerCollectionMembershipAction
): string[] {
  const normalizedTarget = productCoordinate.trim()
  if (!PRODUCT_COORDINATE_PATTERN.test(normalizedTarget)) {
    throw new Error("Expected an exact kind-30402 product coordinate.")
  }

  const current = Array.from(
    new Set(
      currentProductCoordinates
        .map((coordinate) => coordinate.trim())
        .filter((coordinate) => PRODUCT_COORDINATE_PATTERN.test(coordinate))
    )
  )
  if (action === "remove") {
    return current.filter((coordinate) => coordinate !== normalizedTarget)
  }
  return current.includes(normalizedTarget)
    ? current
    : [...current, normalizedTarget]
}

export type OrganizerEventMarketDisplayState =
  "active" | "ended" | "degraded" | "deleted" | "unavailable"

export function getOrganizerEventMarketDisplayState(
  state: string
): OrganizerEventMarketDisplayState {
  switch (state) {
    case "active":
      return "active"
    case "ended":
      return "ended"
    case "deleted":
      return "deleted"
    case "partial":
    case "stale":
    case "missing":
    case "malformed":
    case "conflicting":
    case "unsupported":
      return "degraded"
    default:
      return "unavailable"
  }
}
