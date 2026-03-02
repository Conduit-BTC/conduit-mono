const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
]

export interface ConduitConfig {
  relayUrl: string
  defaultRelays: string[]
  lightningNetwork: "mainnet" | "signet" | "testnet" | "mock"
}

// Vite only statically replaces direct property access (import.meta.env.VITE_FOO).
// Dynamic access like import.meta.env[key] returns undefined in production builds.
// Use direct access for each variable so Vite can inline them at build time.
function getViteEnv(): {
  relayUrl: string
  defaultRelays: string
  defaultRelayUrl: string
  lightningNetwork: string
} {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    return {
      relayUrl: import.meta.env.VITE_RELAY_URL ?? "",
      defaultRelays: import.meta.env.VITE_DEFAULT_RELAYS ?? "",
      defaultRelayUrl: import.meta.env.VITE_DEFAULT_RELAY_URL ?? "",
      lightningNetwork: import.meta.env.VITE_LIGHTNING_NETWORK ?? "",
    }
  }
  return { relayUrl: "", defaultRelays: "", defaultRelayUrl: "", lightningNetwork: "" }
}

function parseRelayList(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
}

function getDefaultRelays(env: ReturnType<typeof getViteEnv>): string[] {
  const raw = env.defaultRelays.trim() || env.defaultRelayUrl.trim()
  if (!raw) return DEFAULT_RELAYS
  return parseRelayList(raw)
}

const env = getViteEnv()

export const config: ConduitConfig = {
  relayUrl: env.relayUrl || "wss://relay.conduit.market",
  defaultRelays: getDefaultRelays(env),
  lightningNetwork: (env.lightningNetwork || "mainnet") as ConduitConfig["lightningNetwork"],
}

export function isMockPayments(): boolean {
  return config.lightningNetwork === "mock"
}

export function isSignet(): boolean {
  return config.lightningNetwork === "signet"
}

export function isTestnet(): boolean {
  return config.lightningNetwork === "testnet" || config.lightningNetwork === "signet"
}

export function isMainnet(): boolean {
  return config.lightningNetwork === "mainnet"
}
