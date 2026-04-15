import { describe, expect, it } from "bun:test"
import NDK, {
  NDKEvent,
  NDKPrivateKeySigner,
  nip19,
  type NDKFilter,
} from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  parseProductEvent,
  type ProductSchema,
} from "@conduit/core"
import { randomBytes } from "node:crypto"

function parseRelayUrls(): string[] {
  const raw =
    process.env.CONDUIT_TEST_RELAY_URLS ||
    process.env.TEST_RELAY_URLS ||
    process.env.TEST_RELAY_URL ||
    ""

  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

async function canConnectWs(url: string, timeoutMs = 750): Promise<boolean> {
  return await new Promise((resolve) => {
    let done = false
    const ws = new WebSocket(url)

    const timeoutId = setTimeout(() => {
      if (done) return
      done = true
      try {
        ws.close()
      } catch {
        // ignore
      }
      resolve(false)
    }, timeoutMs)

    ws.onopen = () => {
      if (done) return
      done = true
      clearTimeout(timeoutId)
      try {
        ws.close()
      } catch {
        // ignore
      }
      resolve(true)
    }

    ws.onerror = () => {
      if (done) return
      done = true
      clearTimeout(timeoutId)
      resolve(false)
    }
  })
}

async function pickFirstReachableRelayUrl(
  urls: string[]
): Promise<string | null> {
  for (const url of urls) {
    if (await canConnectWs(url)) return url
  }
  return null
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
  intervalMs = 250
): Promise<T> {
  const start = Date.now()
  let lastValue: T | undefined

  while (true) {
    lastValue = await fn()
    if (predicate(lastValue)) return lastValue
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for relay condition")
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

const relayUrls = parseRelayUrls()
const describeIfRelay = relayUrls.length > 0 ? describe : describe.skip

describeIfRelay("merchant products CRUD (relay smoke)", () => {
  it("publishes, updates (same d tag), and deletes a kind 30402 listing", async () => {
    const relayUrl = await pickFirstReachableRelayUrl(relayUrls)
    if (!relayUrl) {
      throw new Error(`No reachable relay URLs. Tried: ${relayUrls.join(", ")}`)
    }

    const ndk = new NDK({ explicitRelayUrls: [relayUrl] })
    await ndk.connect(3000)

    const nsec = nip19.nsecEncode(randomBytes(32))
    const signer = new NDKPrivateKeySigner(nsec)
    ndk.signer = signer

    const user = await signer.user()
    const pubkey = user.pubkey

    const dTag = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const createdAt = Date.now()

    const baseTitle = `[TEST] Merchant CRUD Smoke ${dTag}`

    const productV1: ProductSchema = {
      id: `30402:${pubkey}:${dTag}`,
      pubkey,
      title: baseTitle,
      summary: "[TEST] Initial listing",
      price: 12.34,
      currency: "USD",
      type: "simple",
      visibility: "public",
      stock: undefined,
      images: [],
      tags: ["test", "merchant-crud"],
      location: undefined,
      createdAt,
      updatedAt: createdAt,
    }

    const ev1 = new NDKEvent(ndk)
    ev1.kind = EVENT_KINDS.PRODUCT
    ev1.created_at = Math.floor(createdAt / 1000)
    ev1.content = JSON.stringify(productV1)
    ev1.tags = [
      ["d", dTag],
      ["title", productV1.title],
      ["price", String(productV1.price), productV1.currency],
      ["summary", productV1.summary ?? ""],
      ["t", "test"],
      ["t", "merchant-crud"],
    ]
    await ev1.sign(signer)
    await ev1.publish()

    const filter: NDKFilter = {
      kinds: [EVENT_KINDS.PRODUCT],
      authors: [pubkey],
      "#d": [dTag],
      limit: 10,
    }

    const eventsAfterCreate = await pollUntil(
      async () => {
        const events = await ndk.fetchEvents(filter)
        return Array.from(events) as NDKEvent[]
      },
      (events) => events.length > 0
    )

    const parsedAfterCreate = parseProductEvent(eventsAfterCreate[0]!)
    expect(parsedAfterCreate.title).toBe(baseTitle)
    expect(parsedAfterCreate.price).toBe(12.34)

    // Ensure created_at differs so replaceable selection is deterministic.
    await new Promise((r) => setTimeout(r, 1100))

    const updatedAt = Date.now()
    const productV2: ProductSchema = {
      ...productV1,
      title: `${baseTitle} (updated)`,
      price: 99.99,
      createdAt: productV1.createdAt,
      updatedAt,
    }

    const ev2 = new NDKEvent(ndk)
    ev2.kind = EVENT_KINDS.PRODUCT
    ev2.created_at = Math.floor(updatedAt / 1000)
    ev2.content = JSON.stringify(productV2)
    ev2.tags = [
      ["d", dTag],
      ["title", productV2.title],
      ["price", String(productV2.price), productV2.currency],
      ["summary", productV2.summary ?? ""],
      ["t", "test"],
      ["t", "merchant-crud"],
    ]
    await ev2.sign(signer)
    await ev2.publish()

    const eventsAfterUpdate = await pollUntil(
      async () => {
        const events = await ndk.fetchEvents(filter)
        return Array.from(events) as NDKEvent[]
      },
      (events) => {
        if (events.length === 0) return false
        const latest = events
          .slice()
          .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0]
        const parsed = parseProductEvent(latest!)
        return parsed.title.includes("(updated)")
      }
    )

    const latestAfterUpdate = eventsAfterUpdate
      .slice()
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0]!
    const parsedAfterUpdate = parseProductEvent(latestAfterUpdate)
    expect(parsedAfterUpdate.title).toBe(`${baseTitle} (updated)`)
    expect(parsedAfterUpdate.price).toBe(99.99)

    const deletion = new NDKEvent(ndk)
    deletion.kind = EVENT_KINDS.DELETION
    deletion.created_at = Math.floor(Date.now() / 1000)
    deletion.tags = [
      ["e", latestAfterUpdate.id],
      ["k", String(EVENT_KINDS.PRODUCT)],
      ["p", pubkey],
      ["a", `30402:${pubkey}:${dTag}`],
    ]
    deletion.content = `[TEST] Delete product 30402:${pubkey}:${dTag}`
    await deletion.sign(signer)
    await deletion.publish()

    const deletionFilter: NDKFilter = {
      kinds: [EVENT_KINDS.DELETION],
      authors: [pubkey],
      "#e": [latestAfterUpdate.id],
      "#a": [`30402:${pubkey}:${dTag}`],
      limit: 10,
    }

    const deletionEvents = await pollUntil(
      async () => {
        const events = await ndk.fetchEvents(deletionFilter)
        return Array.from(events) as NDKEvent[]
      },
      (events) => events.length > 0
    )

    expect(deletionEvents.length).toBeGreaterThan(0)

    const eventsAfterDelete = await ndk.fetchEvents(filter)
    const visibleProductsAfterDelete = (
      Array.from(eventsAfterDelete) as NDKEvent[]
    ).filter((event) => {
      const eventCreatedAt = event.created_at ?? 0
      const eventAddress = `30402:${event.pubkey}:${dTag}`
      return !deletionEvents.some((deletionEvent) => {
        const deletionCreatedAt = deletionEvent.created_at ?? 0
        if (deletionCreatedAt < eventCreatedAt) return false

        return deletionEvent.tags.some(
          (tag) =>
            (tag[0] === "e" && tag[1] === event.id) ||
            (tag[0] === "a" && tag[1] === eventAddress)
        )
      })
    })

    expect(visibleProductsAfterDelete.length).toBe(0)
  }, 30_000)
})
