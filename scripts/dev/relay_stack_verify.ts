/**
 * relay_stack_verify.ts
 *
 * Verifies the local relay dev stack is running and demonstrates
 * how the frontend connects to each relay role.
 *
 * Prerequisites:
 *   bun run relay:stack:up
 *
 * Usage:
 *   bun scripts/dev/relay_stack_verify.ts
 *
 * With seeding:
 *   SEED_NSEC=<nsec> bun scripts/dev/relay_stack_verify.ts
 */

import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"

// ── Relay URLs matching docker-compose.dev.yml ──

const L2_RELAY_URL = "ws://127.0.0.1:3334" // Conduit L2 (commerce-aware queries)
const MERCHANT_RELAY_URL = "ws://127.0.0.1:3355" // Haven (merchant source of truth)
const PUBLIC_RELAY_URL = "ws://127.0.0.1:7777" // nostr-rs-relay (generic)

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

// ── 1. Check relay availability ──

async function checkRelay(name: string, httpUrl: string): Promise<boolean> {
  try {
    const res = await fetch(httpUrl, {
      headers: { Accept: "application/nostr+json" },
    })
    if (res.ok) {
      const info = await res.json()
      console.log(`  [OK] ${name} (${httpUrl})`)
      if (info.name) console.log(`       name: ${info.name}`)
      if (info.tags) console.log(`       tags: ${JSON.stringify(info.tags)}`)
      return true
    }
    console.log(`  [FAIL] ${name} -- HTTP ${res.status}`)
    return false
  } catch (e) {
    console.log(`  [FAIL] ${name} -- ${(e as Error).message}`)
    return false
  }
}

// ── 2. Demonstrate L2 commerce query (search + sort) ──

async function demoL2CommerceQuery(ndk: NDK) {
  console.log("\n--- L2 Commerce Query Demo ---")
  console.log("Querying conduitl2 for kind:30402 with price_asc sort...")

  const events = Array.from(
    await ndk.fetchEvents({
      kinds: [30402 as number],
      limit: 10,
      search: "conduit-l2:q=;sort=price_asc",
    })
  )

  if (events.length === 0) {
    console.log("  No products found. Seed some first:")
    console.log(
      "  SEED_NSEC=... SEED_RELAY_URLS=ws://127.0.0.1:3334,ws://127.0.0.1:3355,ws://127.0.0.1:7777 bun run seed:products"
    )
    return
  }

  console.log(`  Found ${events.length} products (sorted by price ascending):`)
  for (const ev of events) {
    const priceTag = ev.tags.find((t) => t[0] === "price")
    const titleTag = ev.tags.find((t) => t[0] === "title")
    const price = priceTag ? `${priceTag[1]} ${priceTag[2] ?? ""}` : "N/A"
    const title = titleTag ? titleTag[1] : "(untitled)"
    console.log(`    ${price.padEnd(12)} ${title}`)
  }
}

// ── 3. Demonstrate merchant relay read ──

async function demoMerchantRead(ndk: NDK) {
  console.log("\n--- Merchant Relay Read Demo ---")
  console.log("Querying Haven outbox for kind:30402 products...")

  const events = Array.from(
    await ndk.fetchEvents({
      kinds: [30402 as number],
      limit: 10,
    })
  )

  console.log(`  Found ${events.length} products on merchant relay.`)
  for (const ev of events) {
    const titleTag = ev.tags.find((t) => t[0] === "title")
    console.log(`    ${titleTag ? titleTag[1] : ev.id}`)
  }
}

// ── 4. Demonstrate public relay read ──

async function demoPublicRead(ndk: NDK) {
  console.log("\n--- Public Relay Read Demo ---")
  console.log("Querying public relay for kind:30402 products...")

  const events = Array.from(
    await ndk.fetchEvents({
      kinds: [30402 as number],
      limit: 10,
    })
  )

  console.log(`  Found ${events.length} products on public relay.`)
}

// ── 5. Optional: seed products to all relays ──

async function seedToAllRelays() {
  const nsec = process.env.SEED_NSEC?.trim()
  if (!nsec) return false

  console.log("\n--- Seeding Products to All Relays ---")

  const allRelays = [L2_RELAY_URL, MERCHANT_RELAY_URL, PUBLIC_RELAY_URL]
  const signer = new NDKPrivateKeySigner(nsec)
  const ndk = new NDK({ explicitRelayUrls: allRelays, signer })
  await ndk.connect(3000)

  const pubkey = await signer.user().then((u) => u.pubkey)
  console.log(`  Publisher pubkey: ${pubkey}`)

  const products = [
    {
      d: "demo-apple",
      title: "Apple",
      price: "19",
      currency: "USD",
      summary: "Red fruit",
    },
    {
      d: "demo-banana",
      title: "Banana",
      price: "7",
      currency: "USD",
      summary: "Yellow fruit",
    },
    {
      d: "demo-carrot",
      title: "Carrot",
      price: "12",
      currency: "USD",
      summary: "Orange root",
    },
  ]

  for (const p of products) {
    const ev = new NDKEvent(ndk)
    ev.kind = 30402
    ev.created_at = nowSec()
    ev.content = JSON.stringify({
      title: p.title,
      summary: p.summary,
      price: Number(p.price),
      currency: p.currency,
      updatedAt: nowSec(),
    })
    ev.tags = [
      ["d", p.d],
      ["title", p.title],
      ["price", p.price, p.currency],
      ["summary", p.summary],
    ]
    try {
      await ev.publish()
      console.log(`  Published: ${p.title} (${p.price} ${p.currency})`)
    } catch (error) {
      console.log(
        `  [WARN] Publish failed for ${p.title}: ${(error as Error).message}`
      )
    }
  }

  // Allow relay processing time
  await new Promise((resolve) => setTimeout(resolve, 1000))
  return true
}

// ── Main ──

async function main() {
  console.log("=== Conduit Relay Stack Verification ===\n")

  // 1. Check relay availability
  console.log("Checking relay availability:")
  const l2Ok = await checkRelay(
    "Conduit L2 (commerce)",
    `http://127.0.0.1:3334`
  )
  const merchantOk = await checkRelay(
    "Haven (merchant)",
    `http://127.0.0.1:3355`
  )
  const publicOk = await checkRelay("Public relay", `http://127.0.0.1:7777`)

  if (!l2Ok && !merchantOk && !publicOk) {
    console.log("\nNo relays running. Start the stack first:")
    console.log("  bun run relay:stack:up")
    process.exit(1)
  }

  // 2. Seed if SEED_NSEC is provided
  await seedToAllRelays()

  // 3. Demonstrate L2 commerce queries
  if (l2Ok) {
    const ndkL2 = new NDK({ explicitRelayUrls: [L2_RELAY_URL] })
    await ndkL2.connect(3000)
    await demoL2CommerceQuery(ndkL2)
  }

  // 4. Demonstrate merchant relay reads
  if (merchantOk) {
    const ndkMerchant = new NDK({ explicitRelayUrls: [MERCHANT_RELAY_URL] })
    await ndkMerchant.connect(3000)
    await demoMerchantRead(ndkMerchant)
  }

  // 5. Demonstrate public relay reads
  if (publicOk) {
    const ndkPublic = new NDK({ explicitRelayUrls: [PUBLIC_RELAY_URL] })
    await ndkPublic.connect(3000)
    await demoPublicRead(ndkPublic)
  }

  // 6. Frontend integration summary
  console.log("\n=== Frontend Integration ===")
  console.log(`
To wire these relays into your local app, add to apps/market/.env.local
or apps/merchant/.env.local:

  VITE_RELAY_URL=ws://127.0.0.1:7777
  VITE_L2_RELAY_URLS=${L2_RELAY_URL}
  VITE_MERCHANT_RELAY_URLS=${MERCHANT_RELAY_URL}
  VITE_PUBLIC_RELAY_URLS=${PUBLIC_RELAY_URL}
  VITE_LIGHTNING_NETWORK=mock

VITE_RELAY_URL is included to avoid implicit fallback to external public relays
during local development.

Relay role URLs are parsed in packages/core/src/config.ts and consumed by
source-aware reads in packages/core/src/protocol/commerce.ts.

Read plans route queries through sources in precedence order:
  marketplace_products:  cache -> l2 -> public -> local_cache
  merchant_storefront:   cache -> l2 -> merchant -> public -> local_cache
  product_detail:        cache -> l2 -> merchant -> public -> local_cache

Current implementation keeps public/merchant fanout as baseline fallback;
this script demonstrates direct L2 commerce queries explicitly.

L2 queries use the conduit-l2: search DSL for sorting and filtering:
  search: "conduit-l2:q=apple;sort=price_asc"
  search: "conduit-l2:q=;sort=newest"
  search: "conduit-l2:q=;sort=price_desc;partial=1"

Haven merchant relay endpoints:
  ws://127.0.0.1:3355/         Outbox (public products, source of truth)
  ws://127.0.0.1:3355/chat     Chat (NIP-17 encrypted DMs)
  ws://127.0.0.1:3355/inbox    Inbox (buyer interactions, zaps)
  ws://127.0.0.1:3355/private  Private (drafts, eCash)

Local Haven publishing note:
  Outbox writes are limited to owner/whitelisted pubkeys.
  For nak-based local demos, add npubs to:
    relays/haven/whitelist_npubs.dev.json
  then recreate Haven:
    docker compose -f docker-compose.dev.yml up -d haven --force-recreate
`)

  console.log("=== Done ===")
  process.exit(0)
}

await main()
