import {
  decodeEventMarketReference,
  encodeEventMarketNaddr,
} from "@conduit/core"

export type OrganizerCollectionMembershipAction = "accept" | "remove"

export interface SavedOrganizerEventMarketReference {
  reference: string
  title?: string
  savedAt: number
  expectedCollectionCreatedAt?: number
}

const EVENT_MARKET_STORAGE_PREFIX = "conduit:merchant:event-markets:v1"
const DISCOVERED_EVENT_MARKET_STORAGE_PREFIX =
  "conduit:merchant:discovered-event-markets:v1"
const PRODUCT_COORDINATE_PATTERN = /^30402:[0-9a-f]{64}:.+$/i
// Core reads at most eight relays. Keep one slot available for the normal
// organizer/default fallback when a saved naddr is opened in a fresh session.
const SAVED_EVENT_MARKET_RELAY_HINT_LIMIT = 7

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

export function getDiscoveredEventMarketStorageKey(
  merchantPubkey: string
): string {
  return `${DISCOVERED_EVENT_MARKET_STORAGE_PREFIX}:${merchantPubkey.trim().toLowerCase()}`
}

function normalizeSavedReference(
  value: unknown
): NormalizedSavedOrganizerEventMarketReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as {
    reference?: unknown
    title?: unknown
    savedAt?: unknown
    expectedCollectionCreatedAt?: unknown
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
  const expectedCollectionCreatedAt =
    typeof candidate.expectedCollectionCreatedAt === "number" &&
    Number.isFinite(candidate.expectedCollectionCreatedAt)
      ? candidate.expectedCollectionCreatedAt
      : undefined
  return {
    reference:
      decoded.relayHints.length > 0
        ? encodeEventMarketNaddr(decoded.coordinate, decoded.relayHints)
        : decoded.coordinate,
    title,
    savedAt: candidate.savedAt,
    ...(expectedCollectionCreatedAt !== undefined
      ? { expectedCollectionCreatedAt }
      : {}),
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
  const mergedRelayHints = Array.from(
    new Set(sorted.flatMap((reference) => reference.relayHints))
  )
  const completeExplicitReference = sorted.find((reference) =>
    mergedRelayHints.every((relayUrl) =>
      reference.relayHints.includes(relayUrl)
    )
  )
  const relayHints = completeExplicitReference
    ? completeExplicitReference.relayHints
    : mergedRelayHints.slice(0, SAVED_EVENT_MARKET_RELAY_HINT_LIMIT)
  const expectedCollectionCreatedAt = Math.max(
    ...sorted.map((reference) => reference.expectedCollectionCreatedAt ?? 0)
  )
  return {
    reference:
      relayHints.length > 0
        ? encodeEventMarketNaddr(newest.coordinate, relayHints)
        : newest.coordinate,
    title: newest.title ?? sorted.find((reference) => reference.title)?.title,
    savedAt: newest.savedAt,
    ...(expectedCollectionCreatedAt > 0 ? { expectedCollectionCreatedAt } : {}),
  }
}

function loadSavedReferences(
  storageKey: string,
  storage: Pick<Storage, "getItem">,
  expectedOrganizerPubkey?: string
): SavedOrganizerEventMarketReference[] {
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    const byCoordinate = new Map<
      string,
      NormalizedSavedOrganizerEventMarketReference[]
    >()
    for (const value of parsed) {
      const normalized = normalizeSavedReference(value)
      if (
        !normalized ||
        (expectedOrganizerPubkey &&
          normalized.organizerPubkey !== expectedOrganizerPubkey)
      ) {
        continue
      }
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

function rememberSavedReference(
  storageKey: string,
  entry: SavedOrganizerEventMarketReference,
  storage: Pick<Storage, "getItem" | "setItem">,
  expectedOrganizerPubkey?: string
): SavedOrganizerEventMarketReference[] {
  const normalized = normalizeSavedReference(entry)
  if (
    !normalized ||
    (expectedOrganizerPubkey &&
      normalized.organizerPubkey !== expectedOrganizerPubkey)
  ) {
    return loadSavedReferences(storageKey, storage, expectedOrganizerPubkey)
  }

  const current = loadSavedReferences(
    storageKey,
    storage,
    expectedOrganizerPubkey
  )
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
    storage.setItem(storageKey, JSON.stringify(next))
  } catch {
    // The public coordinate remains usable for this session when storage is
    // unavailable. Relay evidence, not local storage, is authoritative.
  }
  return next
}

export function loadSavedOrganizerEventMarkets(
  organizerPubkey: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!organizerPubkey.trim() || !storage) return []
  return loadSavedReferences(
    getOrganizerEventMarketStorageKey(organizerPubkey),
    storage,
    organizerPubkey.trim().toLowerCase()
  )
}

export function loadSavedDiscoveredEventMarkets(
  merchantPubkey: string,
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!merchantPubkey.trim() || !storage) return []
  return loadSavedReferences(
    getDiscoveredEventMarketStorageKey(merchantPubkey),
    storage
  )
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
  const normalizedOrganizer = organizerPubkey.trim().toLowerCase()
  return rememberSavedReference(
    getOrganizerEventMarketStorageKey(organizerPubkey),
    entry,
    storage,
    normalizedOrganizer
  )
}

export function rememberDiscoveredEventMarket(
  merchantPubkey: string,
  entry: SavedOrganizerEventMarketReference,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof localStorage ===
  "undefined"
    ? null
    : localStorage
): SavedOrganizerEventMarketReference[] {
  if (!merchantPubkey.trim() || !storage) return []
  return rememberSavedReference(
    getDiscoveredEventMarketStorageKey(merchantPubkey),
    entry,
    storage
  )
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

export function findOrganizerEventMarketByReference<
  T extends { collectionCoordinate: string },
>(markets: readonly T[], reference: string): T | undefined {
  const target = decodeEventMarketReference(reference, [30405])
  if (!target) return undefined
  return markets.find(
    (market) => market.collectionCoordinate === target.coordinate
  )
}

export function isPreferredOrganizerEventMarketListResolution(
  market: { state: string } | undefined
): boolean {
  return (
    market !== undefined &&
    market.state !== "missing" &&
    market.state !== "unavailable" &&
    market.state !== "stale"
  )
}

export function shouldResolveOrganizerEventMarketReference(
  listMarket: { state: string; collectionCreatedAt?: number } | undefined,
  savedReference: SavedOrganizerEventMarketReference | undefined
): boolean {
  if (!isPreferredOrganizerEventMarketListResolution(listMarket)) return true
  const expectedCollectionCreatedAt =
    savedReference?.expectedCollectionCreatedAt
  return (
    expectedCollectionCreatedAt !== undefined &&
    (listMarket?.collectionCreatedAt ?? 0) < expectedCollectionCreatedAt
  )
}

function reconcileOrganizerEventMarketNaddr(
  coordinate: string,
  references: readonly (string | undefined)[]
): string {
  const relayHints = Array.from(
    new Set(
      references.flatMap(
        (reference) =>
          decodeEventMarketReference(reference ?? "", [30405])?.relayHints ?? []
      )
    )
  ).slice(0, SAVED_EVENT_MARKET_RELAY_HINT_LIMIT)
  return encodeEventMarketNaddr(coordinate, relayHints)
}

export function selectOrganizerEventMarketResolution<
  T extends {
    state: string
    collectionCoordinate: string
    collectionCreatedAt?: number
    naddr: string
  },
>(
  listMarket: T | undefined,
  hintedMarket: T | undefined,
  savedReference?: SavedOrganizerEventMarketReference
): T | undefined {
  const expectedCollectionCreatedAt =
    savedReference?.expectedCollectionCreatedAt ?? 0
  const hintedReachesExpectedFrontier =
    !!hintedMarket &&
    (hintedMarket.collectionCreatedAt ?? 0) >= expectedCollectionCreatedAt
  const selected = isPreferredOrganizerEventMarketListResolution(listMarket)
    ? hintedReachesExpectedFrontier &&
      (hintedMarket?.collectionCreatedAt ?? 0) >
        (listMarket?.collectionCreatedAt ?? 0)
      ? hintedMarket
      : listMarket
    : (hintedMarket ?? listMarket)
  if (!selected) return undefined
  const selectedReferenceIsNewerThanList =
    expectedCollectionCreatedAt >
    (isPreferredOrganizerEventMarketListResolution(listMarket)
      ? (listMarket?.collectionCreatedAt ?? 0)
      : 0)
  const reconciledNaddr = reconcileOrganizerEventMarketNaddr(
    selected.collectionCoordinate,
    selectedReferenceIsNewerThanList
      ? [
          savedReference?.reference,
          selected.naddr,
          hintedMarket?.naddr,
          isPreferredOrganizerEventMarketListResolution(listMarket)
            ? listMarket?.naddr
            : undefined,
        ]
      : [
          selected.naddr,
          savedReference?.reference,
          hintedMarket?.naddr,
          isPreferredOrganizerEventMarketListResolution(listMarket)
            ? listMarket?.naddr
            : undefined,
        ]
  )
  if (reconciledNaddr === selected.naddr) return selected
  return {
    ...selected,
    naddr: reconciledNaddr,
  }
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
