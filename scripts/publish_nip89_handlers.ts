import { publishConduitHandlerEvent, type ConduitAppId } from "../packages/core/src/protocol/nip89"

function readEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function readOptionalEnv(name: string): string | null {
  return process.env[name]?.trim() || null
}

function parseRelayUrls(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  const relayUrls = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return relayUrls.length > 0 ? relayUrls : undefined
}

async function main(): Promise<void> {
  const relayUrls = parseRelayUrls(readOptionalEnv("NIP89_RELAY_URLS"))
  const target = readOptionalEnv("NIP89_TARGET") ?? "all"
  const apps: Array<{ appId: ConduitAppId; envName: string }> = [
    { appId: "market", envName: "NIP89_MARKET_NSEC" },
    { appId: "merchant", envName: "NIP89_MERCHANT_NSEC" },
  ]

  for (const app of apps) {
    if (target !== "all" && target !== app.appId) continue
    const result = await publishConduitHandlerEvent({
      appId: app.appId,
      nsec: readEnv(app.envName),
      relayUrls,
    })
    console.log(`${app.appId}: ${result.address} (${result.eventId})`)
  }
}

await main()
