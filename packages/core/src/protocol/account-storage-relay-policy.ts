import {
  ACCOUNT_STORAGE_RELAYS,
  LEGACY_ACCOUNT_STORAGE_RELAYS,
} from "../config"
import { getConfiguredIsolatedE2eRelayUrl } from "./relay-settings"
import { normalizePublicWebSocketUrl } from "../network-target-safety"
import { relayTargetsFromUrls, type RelayOperation } from "./relay-authority"

export interface AccountStorageRelay {
  url: string
  operator: string | null
}

/** Central configured candidates, not a claim of provider durability. */
export function getAccountStorageRelays(): AccountStorageRelay[] {
  const isolated = getConfiguredIsolatedE2eRelayUrl()
  return isolated
    ? [{ url: isolated, operator: null }]
    : ACCOUNT_STORAGE_RELAYS.map((relay) => ({ ...relay }))
}

/** Explicit extra candidates remain unqualified and cannot create operator redundancy. */
export function planAccountStorageRelays(
  extraRelayUrls: readonly string[] = []
): AccountStorageRelay[] {
  const result = getAccountStorageRelays()
  if (getConfiguredIsolatedE2eRelayUrl()) return result
  for (const candidate of extraRelayUrls) {
    if (result.length >= 8) break
    const url = normalizePublicWebSocketUrl(candidate)
    if (url && !result.some((relay) => relay.url === url))
      result.push({ url, operator: null })
  }
  return result
}

/** Historical bindings validate retained proof; they never select new targets. */
export function accountStorageRelayOperator(url: string): string | null {
  return (
    ACCOUNT_STORAGE_RELAYS.find((relay) => relay.url === url)?.operator ??
    LEGACY_ACCOUNT_STORAGE_RELAYS.find((relay) => relay.url === url)
      ?.operator ??
    null
  )
}

/** Only the deployed historical default prefix is eligible for automatic transition. */
export function transitionAccountStorageRelayUrls(
  urls: readonly string[]
): string[] | undefined {
  if (
    !LEGACY_ACCOUNT_STORAGE_RELAYS.every(
      (relay, index) => urls[index] === relay.url
    )
  )
    return undefined
  return [
    ...new Set([
      ...getAccountStorageRelays().map((relay) => relay.url),
      ...urls.slice(LEGACY_ACCOUNT_STORAGE_RELAYS.length),
    ]),
  ]
}

export function validateAccountStorageRelayTransition(
  original: readonly string[],
  value: unknown
): string[] | undefined {
  const expected = transitionAccountStorageRelayUrls(original)
  if (value === undefined) return expected
  if (!expected || JSON.stringify(value) !== JSON.stringify(expected))
    throw new Error("Invalid account storage relay transition")
  return [...expected]
}

export function accountStorageRelayTargets(operation: RelayOperation) {
  return relayTargetsFromUrls(
    getAccountStorageRelays().map((relay) => relay.url),
    {
      kind: "app",
      operation,
      bucket:
        operation === "read" ? "account_storage_read" : "account_storage_write",
    }
  )
}
