import { getRelayListForUser } from "@nostr-dev-kit/ndk"
import { requireNdkConnected } from "./ndk"

/**
 * Per-relay read/write preferences parsed from a NIP-65 kind:10002 event,
 * shaped to match the `SignerRelayMap` consumed by `saveSignerRelayMap`.
 */
export type Nip65RelayMap = Record<string, { read: boolean; write: boolean }>

export interface Nip65RelayUrls {
  readRelayUrls?: readonly string[]
  writeRelayUrls?: readonly string[]
  bothRelayUrls?: readonly string[]
}

/**
 * Pure merge of read/write/both URL lists (as returned by NDK's
 * `NDKRelayList`) into a single `{ url -> { read, write } }` map. Extracted
 * so it can be unit tested without an NDK instance.
 */
export function mergeNip65RelayUrls(list: Nip65RelayUrls): Nip65RelayMap {
  const map: Nip65RelayMap = {}

  for (const url of list.readRelayUrls ?? []) {
    const existing = map[url] ?? { read: false, write: false }
    map[url] = { read: true, write: existing.write }
  }

  for (const url of list.writeRelayUrls ?? []) {
    const existing = map[url] ?? { read: false, write: false }
    map[url] = { read: existing.read, write: true }
  }

  for (const url of list.bothRelayUrls ?? []) {
    map[url] = { read: true, write: true }
  }

  return map
}

/**
 * Fetch the user's NIP-65 relay list (kind 10002) via NDK and return a
 * `{ url -> { read, write } }` map suitable for merging into the signer
 * relay map used by Conduit's relay settings model.
 *
 * Returns an empty object if no event is found or if the fetch fails —
 * callers should fall back to whatever they already have.
 */
export async function fetchNip65RelayMap(
  pubkey: string,
  opts: { timeoutMs?: number } = {}
): Promise<Nip65RelayMap> {
  const timeoutMs = opts.timeoutMs ?? 6_000

  try {
    const ndk = await requireNdkConnected(timeoutMs)
    const list = await getRelayListForUser(pubkey, ndk)
    if (!list) return {}

    return mergeNip65RelayUrls({
      readRelayUrls: list.readRelayUrls,
      writeRelayUrls: list.writeRelayUrls,
      bothRelayUrls: list.bothRelayUrls,
    })
  } catch {
    return {}
  }
}
