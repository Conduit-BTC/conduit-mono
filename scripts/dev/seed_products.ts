import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function parseRelayUrls(): string[] {
  const raw =
    process.env.SEED_RELAY_URLS ||
    process.env.VITE_DEFAULT_RELAY_URL ||
    "wss://relay.damus.io,wss://relay.primal.net"

  const urls = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  if (urls.length === 0) throw new Error("No relay URLs provided")
  return urls
}

function parseCount(): number {
  const raw = process.env.SEED_COUNT?.trim()
  if (!raw) return 6
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 50) {
    throw new Error("SEED_COUNT must be a number between 1 and 50")
  }
  return Math.floor(n)
}

type SeedProduct = {
  d: string
  title: string
  amount: string
  currency: string
  summary?: string
  images?: Array<{ url: string; dim?: string }>
  content: string
  tags?: string[]
}

function defaultProducts(): SeedProduct[] {
  // Minimal market-spec-aligned tags: d, title, price. Content is Markdown.
  return [
    {
      d: "conduit-sticker-pack",
      title: "Conduit Sticker Pack",
      amount: "5",
      currency: "USD",
      summary: "A small pack of Conduit stickers.",
      images: [
        {
          url: "https://images.unsplash.com/photo-1600267165477-6f0c7c77b0aa?auto=format&fit=crop&w=1200&q=60",
          dim: "1200x800",
        },
      ],
      content: "Vinyl stickers. Ships in an envelope.",
      tags: ["stickers", "merch"],
    },
    {
      d: "conduit-tee",
      title: "Conduit T-Shirt",
      amount: "25",
      currency: "USD",
      summary: "Soft tee with a simple Conduit mark.",
      images: [
        {
          url: "https://images.unsplash.com/photo-1520975682030-54bd1f103676?auto=format&fit=crop&w=1200&q=60",
          dim: "1200x800",
        },
      ],
      content: "100% cotton. Sizes S-XL.",
      tags: ["apparel", "merch"],
    },
    {
      d: "nostr-coffee",
      title: "Nostr Coffee Beans",
      amount: "18",
      currency: "USD",
      summary: "Medium roast, whole bean.",
      images: [
        {
          url: "https://images.unsplash.com/photo-1512568400610-62da28bc8a13?auto=format&fit=crop&w=1200&q=60",
          dim: "1200x800",
        },
      ],
      content: "Tasting notes: chocolate, citrus, and caramel.",
      tags: ["coffee", "food"],
    },
    {
      d: "bitcoin-book",
      title: "Bitcoin Zine",
      amount: "9",
      currency: "USD",
      summary: "A short printed zine about Bitcoin and Nostr.",
      images: [
        {
          url: "https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?auto=format&fit=crop&w=1200&q=60",
          dim: "1200x800",
        },
      ],
      content: "Printed on recycled paper. 24 pages.",
      tags: ["books", "zine"],
    },
    {
      d: "merchant-onboarding",
      title: "Merchant Onboarding Call",
      amount: "49",
      currency: "USD",
      summary: "30 minute setup call to get your shop live.",
      images: [
        {
          url: "https://images.unsplash.com/photo-1521737852567-6949f3f9f2b5?auto=format&fit=crop&w=1200&q=60",
          dim: "1200x800",
        },
      ],
      content:
        "Includes relay setup, listing basics, and payment handle check.",
      tags: ["service"],
    },
    {
      d: "digital-wallpaper",
      title: "Conduit Wallpaper Pack (Digital)",
      amount: "3",
      currency: "USD",
      summary: "A few high-res wallpapers.",
      images: [
        {
          url: "https://images.unsplash.com/photo-1526498460520-4c246339dccb?auto=format&fit=crop&w=1200&q=60",
          dim: "1200x800",
        },
      ],
      content: "Download link sent after manual confirmation in MVP.",
      tags: ["digital"],
    },
  ]
}

async function main() {
  const relayUrls = parseRelayUrls()
  const count = parseCount()

  const nsec = process.env.SEED_NSEC?.trim()
  if (!nsec) {
    throw new Error(
      "Missing SEED_NSEC. For safety we require an explicit Nostr nsec for publishing sample listings.\n" +
        "Create a fresh test key and keep it out of apps; use this script only for seeding."
    )
  }

  const signer = new NDKPrivateKeySigner(nsec)
  const ndk = new NDK({
    explicitRelayUrls: relayUrls,
    signer,
  })

  console.log("Seeding products...")
  console.log(`Relays: ${relayUrls.join(", ")}`)

  await ndk.connect(3000)

  const pubkey = await signer.user().then((u) => u.pubkey)
  console.log(`Publisher pubkey: ${pubkey}`)

  const all = defaultProducts().slice(0, count)

  for (const p of all) {
    const ev = new NDKEvent(ndk)
    ev.kind = 30402
    ev.created_at = nowSec()
    ev.content = p.content

    // Required tags per market-spec
    ev.tags = [
      ["d", p.d],
      ["title", p.title],
      ["price", p.amount, p.currency],
    ]

    // Optional tags (all best-effort, safe for clients to ignore)
    if (p.summary) ev.tags.push(["summary", p.summary])
    for (const t of p.tags ?? []) ev.tags.push(["t", t])

    for (const img of p.images ?? []) {
      if (img.dim) ev.tags.push(["image", img.url, img.dim])
      else ev.tags.push(["image", img.url])
    }

    // Publish
    await ev.publish()

    console.log(`Published: d=${p.d} id=${ev.id}`)
  }

  console.log("Done.")
  console.log(
    "Tip: point your app's VITE_DEFAULT_RELAY_URL to one of the relays above to see the seeded listings."
  )
}

await main()
