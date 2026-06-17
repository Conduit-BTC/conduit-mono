import { db, type CachedRelayCapability } from "../db"
import { EVENT_KINDS } from "./kinds"
import type { RelayScanResult } from "./relay-settings"

type CapabilityEvidenceState = "unknown" | "claimed" | "observed" | "failed"

function hasSupportedNip(scan: RelayScanResult, nip: number): boolean {
  return scan.supportedNips.includes(nip)
}

function claimedOrUnknown(claimed: boolean): CapabilityEvidenceState {
  return claimed ? "claimed" : "unknown"
}

function observedOrFailed(
  record: CachedRelayCapability,
  key: CapabilityEvidenceKey,
  state: Extract<CapabilityEvidenceState, "observed" | "failed">
): CachedRelayCapability {
  return { ...record, [key]: state }
}

type CapabilityEvidenceKey =
  | "kind30402Read"
  | "kind30402Write"
  | "kind1059Read"
  | "kind1059Write"
  | "kind9735Read"
  | "kind9735Write"

function applyEventKindEvidence(
  record: CachedRelayCapability,
  eventKind: number | undefined,
  direction: "read" | "write",
  state: Extract<CapabilityEvidenceState, "observed" | "failed">
): CachedRelayCapability {
  switch (eventKind) {
    case EVENT_KINDS.PRODUCT:
      return observedOrFailed(
        record,
        direction === "read" ? "kind30402Read" : "kind30402Write",
        state
      )
    case EVENT_KINDS.GIFT_WRAP:
      return observedOrFailed(
        record,
        direction === "read" ? "kind1059Read" : "kind1059Write",
        state
      )
    case EVENT_KINDS.ZAP_RECEIPT:
      return observedOrFailed(
        record,
        direction === "read" ? "kind9735Read" : "kind9735Write",
        state
      )
    default:
      return record
  }
}

function applyEventKindsEvidence(
  record: CachedRelayCapability,
  eventKinds: readonly number[] | undefined,
  direction: "read" | "write",
  state: Extract<CapabilityEvidenceState, "observed" | "failed">
): CachedRelayCapability {
  if (!eventKinds || eventKinds.length === 0) return record
  return eventKinds.reduce(
    (next, eventKind) =>
      applyEventKindEvidence(next, eventKind, direction, state),
    record
  )
}

function tryNormalizeRelayUrlForCache(relayUrl: string): string | null {
  try {
    const trimmed = relayUrl.trim()
    if (!trimmed) return null
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `wss://${trimmed}`
    const parsed = new URL(withScheme)
    if (parsed.protocol === "http:") parsed.protocol = "ws:"
    if (parsed.protocol === "https:") parsed.protocol = "wss:"
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null
    if (!parsed.hostname) return null
    parsed.hash = ""
    parsed.search = ""
    const pathname =
      parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}`
  } catch {
    return null
  }
}

export function createRelayCapabilityRecordFromScan(
  scan: RelayScanResult
): CachedRelayCapability {
  return {
    url: scan.url,
    nip11Status: scan.reachable ? "ok" : "failed",
    nip11FetchedAt: scan.scannedAt,
    supportedNips: [...scan.supportedNips],
    paymentRequired: scan.paymentRequired,
    authRequired: scan.authRequired,
    name: scan.relayName,
    description: scan.relayDescription,
    software: scan.relaySoftware,
    version: scan.relayVersion,
    readHealth: scan.reachable ? "ok" : "failed",
    writeHealth: "unknown",
    supportsNip50Search: hasSupportedNip(scan, 50),
    supportsNip45Count: hasSupportedNip(scan, 45),
    supportsNip42Auth: hasSupportedNip(scan, 42) || scan.authRequired,
    kind30402Read: claimedOrUnknown(scan.capabilities.listings === true),
    kind30402Write: "unknown",
    kind1059Read: claimedOrUnknown(
      scan.capabilities.protectedMessages === true
    ),
    kind1059Write: "unknown",
    kind9735Read: claimedOrUnknown(hasSupportedNip(scan, 57)),
    kind9735Write: "unknown",
    latencyMs: undefined,
    timeoutCount: scan.reachable ? 0 : 1,
    failureCount: scan.reachable ? 0 : 1,
    lastSuccessfulReadAt: undefined,
    lastSuccessfulWriteAt: undefined,
    updatedAt: scan.scannedAt,
  }
}

function createUnknownRelayCapabilityRecord(
  url: string,
  now: number
): CachedRelayCapability {
  return {
    url,
    nip11Status: "unknown",
    supportedNips: [],
    paymentRequired: false,
    authRequired: false,
    readHealth: "unknown",
    writeHealth: "unknown",
    supportsNip50Search: false,
    supportsNip45Count: false,
    supportsNip42Auth: false,
    kind30402Read: "unknown",
    kind30402Write: "unknown",
    kind1059Read: "unknown",
    kind1059Write: "unknown",
    kind9735Read: "unknown",
    kind9735Write: "unknown",
    timeoutCount: 0,
    failureCount: 0,
    updatedAt: now,
  }
}

async function updateRelayCapabilityRecord(
  relayUrl: string,
  update: (record: CachedRelayCapability, now: number) => CachedRelayCapability,
  now: number = Date.now()
): Promise<CachedRelayCapability | undefined> {
  const normalized = tryNormalizeRelayUrlForCache(relayUrl)
  if (!normalized) return undefined
  const existing =
    (await db.relayCapabilities.get(normalized)) ??
    createUnknownRelayCapabilityRecord(normalized, now)
  const next = update(existing, now)
  await db.relayCapabilities.put(next)
  return next
}

export async function saveRelayCapabilityScan(
  scan: RelayScanResult
): Promise<CachedRelayCapability> {
  const record = createRelayCapabilityRecordFromScan(scan)
  await db.relayCapabilities.put(record)
  return record
}

export async function getCachedRelayCapability(
  relayUrl: string
): Promise<CachedRelayCapability | undefined> {
  const normalized = tryNormalizeRelayUrlForCache(relayUrl)
  if (!normalized) return undefined
  return await db.relayCapabilities.get(normalized)
}

export async function recordRelayCapabilityReadSuccess(
  relayUrl: string,
  eventKinds?: readonly number[],
  now: number = Date.now()
): Promise<CachedRelayCapability | undefined> {
  return await updateRelayCapabilityRecord(
    relayUrl,
    (record, updatedAt) =>
      applyRelayCapabilityReadSuccess(record, eventKinds, updatedAt),
    now
  )
}

export function applyRelayCapabilityReadSuccess(
  record: CachedRelayCapability,
  eventKinds: readonly number[] | undefined,
  updatedAt: number
): CachedRelayCapability {
  return applyEventKindsEvidence(
    {
      ...record,
      readHealth: "ok",
      lastSuccessfulReadAt: updatedAt,
      updatedAt,
    },
    eventKinds,
    "read",
    "observed"
  )
}

export async function recordRelayCapabilityReadFailure(
  relayUrl: string,
  options: { timedOut?: boolean; eventKind?: number } = {},
  now: number = Date.now()
): Promise<CachedRelayCapability | undefined> {
  return await updateRelayCapabilityRecord(
    relayUrl,
    (record, updatedAt) =>
      applyRelayCapabilityReadFailure(record, options, updatedAt),
    now
  )
}

export function applyRelayCapabilityReadFailure(
  record: CachedRelayCapability,
  options: { timedOut?: boolean; eventKind?: number },
  updatedAt: number
): CachedRelayCapability {
  return applyEventKindEvidence(
    {
      ...record,
      readHealth: "failed",
      timeoutCount: options.timedOut
        ? record.timeoutCount + 1
        : record.timeoutCount,
      failureCount: record.failureCount + 1,
      lastReadFailureAt: updatedAt,
      updatedAt,
    },
    options.eventKind,
    "read",
    "failed"
  )
}

export async function recordRelayCapabilityWriteSuccess(
  relayUrl: string,
  eventKind?: number,
  now: number = Date.now()
): Promise<CachedRelayCapability | undefined> {
  return await updateRelayCapabilityRecord(
    relayUrl,
    (record, updatedAt) =>
      applyRelayCapabilityWriteSuccess(record, eventKind, updatedAt),
    now
  )
}

export function applyRelayCapabilityWriteSuccess(
  record: CachedRelayCapability,
  eventKind: number | undefined,
  updatedAt: number
): CachedRelayCapability {
  return applyEventKindEvidence(
    {
      ...record,
      writeHealth: "ok",
      lastSuccessfulWriteAt: updatedAt,
      updatedAt,
    },
    eventKind,
    "write",
    "observed"
  )
}

export async function recordRelayCapabilityWriteFailure(
  relayUrl: string,
  options: { eventKind?: number; message?: string } = {},
  now: number = Date.now()
): Promise<CachedRelayCapability | undefined> {
  return await updateRelayCapabilityRecord(
    relayUrl,
    (record, updatedAt) =>
      applyRelayCapabilityWriteFailure(record, options, updatedAt),
    now
  )
}

export function applyRelayCapabilityWriteFailure(
  record: CachedRelayCapability,
  options: { eventKind?: number; message?: string },
  updatedAt: number
): CachedRelayCapability {
  return applyEventKindEvidence(
    {
      ...record,
      writeHealth: "failed",
      failureCount: record.failureCount + 1,
      lastWriteFailureAt: updatedAt,
      lastWriteFailureMessage: options.message,
      updatedAt,
    },
    options.eventKind,
    "write",
    "failed"
  )
}
