import {
  fetchSignedEventsFanoutDetailed,
  closePublicRelayConnections,
} from "../../packages/core/src/protocol/relay-reader"

function parseRelayUrls(): string[] {
  const raw =
    process.env.CHECK_RELAY_URLS ||
    process.env.SEED_RELAY_URLS ||
    process.env.VITE_DEFAULT_RELAYS ||
    process.env.VITE_DEFAULT_RELAY_URL ||
    ""

  const urls = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  if (urls.length === 0) {
    throw new Error(
      "No relay URLs provided. Set CHECK_RELAY_URLS (comma-separated), e.g. CHECK_RELAY_URLS=wss://relay.conduit.market"
    )
  }

  return urls
}

function getTagValue(
  tags: string[][] | undefined,
  name: string
): string | null {
  if (!tags) return null
  for (const t of tags) {
    if (t[0] === name && typeof t[1] === "string") return t[1]
  }
  return null
}

function parsePriceTag(tags: string[][] | undefined): string | null {
  if (!tags) return null
  for (const t of tags) {
    if (t[0] !== "price") continue
    const amount = typeof t[1] === "string" ? t[1] : null
    const currency = typeof t[2] === "string" ? t[2] : null
    if (!amount || !currency) continue
    return `${amount} ${currency}`
  }
  return null
}

async function main() {
  const relayUrls = parseRelayUrls()
  const limit = Math.min(
    Math.max(Number(process.env.CHECK_LIMIT ?? 20) || 20, 1),
    200
  )

  const result = await fetchSignedEventsFanoutDetailed(
    { kinds: [30402], limit },
    { relayUrls }
  )
  const list = result.events
  closePublicRelayConnections()

  console.log(`Relays: ${relayUrls.join(", ")}`)
  console.log(`Fetched kind 30402 listings: ${list.length} (limit=${limit})`)

  for (const ev of list.slice(0, 10)) {
    const d = getTagValue(ev.tags, "d")
    const title = getTagValue(ev.tags, "title")
    const price = parsePriceTag(ev.tags)
    console.log(
      `- id=${ev.id} d=${d ?? "-"} title=${title ?? "-"} price=${price ?? "-"} pubkey=${ev.pubkey.slice(0, 8)}…`
    )
  }

  process.exit(0)
}

await main()
