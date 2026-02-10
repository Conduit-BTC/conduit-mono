const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.snort.social",
]

export interface ConduitConfig {
  relayUrl: string
  defaultRelays: string[]
  lightningNetwork: "mainnet" | "testnet" | "mock"
}

function getEnv(key: string, fallback: string): string {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    return (import.meta.env[key] as string) ?? fallback
  }
  return fallback
}

function parseRelayList(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
}

function getDefaultRelays(): string[] {
  // Support both names:
  // - VITE_DEFAULT_RELAY_URL (single relay URL, historically used in docs)
  // - VITE_DEFAULT_RELAYS (comma-separated list)
  //
  // If a custom list is provided, we do NOT automatically append public relays. This keeps
  // local development deterministic (local relay only) unless the developer opts in.
  const rawList = getEnv("VITE_DEFAULT_RELAYS", "").trim()
  const rawSingle = getEnv("VITE_DEFAULT_RELAY_URL", "").trim()
  const raw = rawList || rawSingle
  if (!raw) return DEFAULT_RELAYS
  return parseRelayList(raw)
}

export const config: ConduitConfig = {
  relayUrl: getEnv("VITE_RELAY_URL", "wss://relay.conduit.market"),
  defaultRelays: getDefaultRelays(),
  lightningNetwork: getEnv("VITE_LIGHTNING_NETWORK", "mainnet") as ConduitConfig["lightningNetwork"],
}

export function isMockPayments(): boolean {
  return config.lightningNetwork === "mock"
}

export function isTestnet(): boolean {
  return config.lightningNetwork === "testnet"
}

export function isMainnet(): boolean {
  return config.lightningNetwork === "mainnet"
}
