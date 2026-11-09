import { afterEach, beforeEach, expect, test } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import { config } from "../packages/core/src/config"
import type { CachedProfile, CachedProduct } from "../packages/core/src/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getProfiles,
} from "../packages/core/src/protocol/commerce"
import { parseRelayListEvent } from "../packages/core/src/protocol/relay-list"
import {
  closePublicRelayConnections,
  type PublicRelayReadSocket,
} from "../packages/core/src/protocol/relay-reader"
import { admitFixture } from "./helpers/public-event"

const fixtureKey = new Uint8Array(32).fill(7)
const merchant = getPublicKey(fixtureKey)
const relay = (label: string) => `wss://${label}.profile-scope-fixture.net`
const app = relay("app")
const author = relay("author-write")
const explicit = relay("current-product")
const historical = Array.from({ length: 20 }, (_, i) => relay(`old-${i}`))
const allowed = new Set([app, author, explicit, ...historical])
const originalConfig = { ...config }
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const attempted = new Set<string>()
let blockedNetworkAttempts = 0
let cachedProfiles: CachedProfile[] = []
let profileEvent: ReturnType<typeof finalizeEvent> | undefined

class FixtureSocket implements PublicRelayReadSocket {
  readyState = 0
  onopen: PublicRelayReadSocket["onopen"] = null
  onmessage: PublicRelayReadSocket["onmessage"] = null
  onerror: PublicRelayReadSocket["onerror"] = null
  onclose: PublicRelayReadSocket["onclose"] = null
  constructor(readonly url: string) {
    if (!allowed.has(url)) {
      blockedNetworkAttempts++
      throw new Error("Unexpected offline relay target")
    }
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.(new Event("open"))
    })
  }
  send(payload: string) {
    const [type, subscription] = JSON.parse(payload)
    if (type !== "REQ") return
    attempted.add(this.url)
    queueMicrotask(() => {
      if (profileEvent)
        this.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify(["EVENT", subscription, profileEvent]),
          })
        )
      this.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify(["EOSE", subscription]),
        })
      )
    })
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(new Event("close"))
  }
}

beforeEach(async () => {
  attempted.clear()
  blockedNetworkAttempts = 0
  cachedProfiles = []
  profileEvent = undefined
  Object.assign(config, {
    defaultRelays: [app],
    appReadRelayUrls: [app],
    corePublicFallbackRelayUrls: [app],
  })
  globalThis.fetch = (async () => {
    blockedNetworkAttempts++
    throw new Error("Real fetch forbidden in offline fixture")
  }) as typeof fetch
  globalThis.WebSocket = FixtureSocket as unknown as typeof WebSocket
  const relayList = parseRelayListEvent(
    await admitFixture(
      finalizeEvent(
        {
          kind: 10002,
          created_at: 1,
          content: "",
          tags: [["r", author, "write"]],
        },
        fixtureKey
      )
    )
  )
  const cachedProducts: CachedProduct[] = historical.map((url, i) => ({
    id: `fixture-${i}`,
    pubkey: merchant,
    title: "Fixture",
    price: 1,
    currency: "SATS",
    images: [],
    tags: [],
    sourceRelayUrls: [url],
    cachedAt: 1,
  }))
  __setCommerceTestOverrides({
    getCachedProfiles: async (pubkeys) =>
      pubkeys.map((pubkey) =>
        cachedProfiles.find((row) => row.pubkey === pubkey)
      ),
    putCachedProfiles: async (rows) => {
      cachedProfiles = rows
    },
    getCachedProducts: async () => cachedProducts,
    getRelayLists: async () => new Map([[merchant, relayList]]),
    getRelayListsDetailed: async () => ({
      relayLists: new Map([[merchant, relayList]]),
      resolutionStates: new Map([[merchant, "network" as const]]),
    }),
  })
})

afterEach(() => {
  closePublicRelayConnections()
  __resetCommerceTestOverrides()
  Object.assign(config, originalConfig)
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  expect(blockedNetworkAttempts).toBe(0)
})

test("ordinary display uses current hints and author/configured relays, not historical product sources", async () => {
  const result = await getProfiles({
    pubkeys: [merchant],
    relayHintsByPubkey: { [merchant]: [explicit, historical[0]!] },
    onProgress: () => {},
  })
  expect(attempted).toEqual(new Set([app, author, explicit, historical[0]!]))
  expect(result.profileContexts[merchant]?.readComplete).toBe(false)
})

test.each(["full_profile", "profile_edit", "payment"] as const)(
  "strict %s discovery keeps its existing relay sources",
  async (evidenceScope) => {
    await getProfiles({
      pubkeys: [merchant],
      evidenceScope,
      requireCompleteEvidence: true,
      authorRelayPaymentPolicy: evidenceScope === "payment",
      relayHintsByPubkey: { [merchant]: [explicit, historical[0]!] },
    })
    expect(attempted).toEqual(
      evidenceScope === "payment"
        ? new Set([app, author, explicit, historical[0]!])
        : allowed
    )
  }
)

test("a narrower display read retains a newer cached profile frontier", async () => {
  profileEvent = finalizeEvent(
    {
      kind: 0,
      created_at: 1,
      tags: [],
      content: JSON.stringify({ name: "Older" }),
    },
    fixtureKey
  )
  const newer = finalizeEvent(
    {
      kind: 0,
      created_at: 2,
      tags: [],
      content: JSON.stringify({ name: "Retained" }),
    },
    fixtureKey
  )
  cachedProfiles = [
    {
      pubkey: merchant,
      name: "Retained",
      rawContent: newer.content,
      eventId: newer.id,
      eventCreatedAt: newer.created_at,
      cachedAt: 0,
    },
  ]
  const result = await getProfiles({
    pubkeys: [merchant],
    onProgress: () => {},
  })
  expect(result.data[merchant]?.name).toBe("Retained")
  expect(result.profileContexts[merchant]?.frontier?.eventId).toBe(newer.id)
  expect(result.profileContexts[merchant]?.readComplete).toBe(false)
})
