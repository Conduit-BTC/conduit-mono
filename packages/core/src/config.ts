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

export const config: ConduitConfig = {
  relayUrl: getEnv("VITE_RELAY_URL", "wss://relay.conduit.market"),
  defaultRelays: getEnv("VITE_DEFAULT_RELAYS", "")
    .split(",")
    .filter(Boolean)
    .map((r) => r.trim())
    .concat(DEFAULT_RELAYS)
    .filter((v, i, a) => a.indexOf(v) === i),
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
