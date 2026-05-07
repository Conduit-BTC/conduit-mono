/**
 * Per-relay health tracking with adaptive cooldowns.
 *
 * The planner uses this to skip relays that have been failing recently so
 * a slow or down relay does not drag down every fanout. Health is process-
 * local (not persisted) and intentionally simple: we count consecutive
 * failures and parked relays expire after an exponentially backed-off
 * cooldown.
 *
 * Failure semantics are decided by the caller. Treat as failure:
 * - websocket connection refused / timed out
 * - fetch timed out before any event arrived
 *
 * Treat as success:
 * - any non-empty result, OR
 * - explicit EOSE within the fetch timeout (caller may approximate this
 *   with "no error and at least one event observed")
 *
 * A successful call always resets failure counters.
 */

import { tryNormalizeRelayUrl } from "./relay-settings"

export interface RelayHealthRecord {
  url: string
  consecutiveFailures: number
  lastSuccessAt: number | null
  lastFailureAt: number | null
  /** Timestamp (ms) until which the relay is parked (skipped by planner). */
  cooldownUntil: number | null
}

export interface RelayHealthSnapshot {
  records: ReadonlyMap<string, RelayHealthRecord>
}

const BASE_COOLDOWN_MS = 30_000
const MAX_COOLDOWN_MS = 30 * 60_000
const FAILURES_BEFORE_COOLDOWN = 2

const records = new Map<string, RelayHealthRecord>()

function nowMs(): number {
  return Date.now()
}

function ensureRecord(url: string): RelayHealthRecord {
  const existing = records.get(url)
  if (existing) return existing
  const record: RelayHealthRecord = {
    url,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    cooldownUntil: null,
  }
  records.set(url, record)
  return record
}

function tryNormalize(url: string): string | null {
  const result = tryNormalizeRelayUrl(url)
  return result.ok ? result.url : null
}

export function recordRelaySuccess(url: string, now: number = nowMs()): void {
  const normalized = tryNormalize(url)
  if (!normalized) return
  const record = ensureRecord(normalized)
  record.consecutiveFailures = 0
  record.lastSuccessAt = now
  record.cooldownUntil = null
}

export function recordRelayFailure(url: string, now: number = nowMs()): void {
  const normalized = tryNormalize(url)
  if (!normalized) return
  const record = ensureRecord(normalized)
  record.consecutiveFailures += 1
  record.lastFailureAt = now

  if (record.consecutiveFailures >= FAILURES_BEFORE_COOLDOWN) {
    const overflow = record.consecutiveFailures - FAILURES_BEFORE_COOLDOWN
    const cooldown = Math.min(
      BASE_COOLDOWN_MS * Math.pow(2, overflow),
      MAX_COOLDOWN_MS
    )
    record.cooldownUntil = now + cooldown
  }
}

export function getRelayHealth(url: string): RelayHealthRecord | undefined {
  const normalized = tryNormalize(url)
  if (!normalized) return undefined
  return records.get(normalized)
}

/**
 * Returns true if the relay is currently parked. Callers may still choose
 * to use a parked relay (e.g. last-resort fallback) but the planner skips
 * them by default.
 */
export function isRelayInCooldown(url: string, now: number = nowMs()): boolean {
  const record = getRelayHealth(url)
  if (!record || record.cooldownUntil === null) return false
  return record.cooldownUntil > now
}

export function partitionByHealth(
  urls: readonly string[],
  now: number = nowMs()
): { healthy: string[]; parked: string[] } {
  const healthy: string[] = []
  const parked: string[] = []
  for (const url of urls) {
    const normalized = tryNormalize(url)
    if (!normalized) continue
    if (isRelayInCooldown(normalized, now)) parked.push(normalized)
    else healthy.push(normalized)
  }
  return { healthy, parked }
}

export function snapshotRelayHealth(): RelayHealthSnapshot {
  return { records: new Map(records) }
}

/** Test seam: clear all health state. */
export function __resetRelayHealth(): void {
  records.clear()
}
