import { afterEach, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getMarketplaceProductsProgressive,
} from "../packages/core/src/protocol/commerce"
import type { CachedProduct } from "../packages/core/src/db"
import type { fetchPublicEventsProgressive } from "../packages/core/src/protocol/relay-reader"

const secret = generateSecretKey()
function product(dTag: string) {
  return finalizeEvent(
    {
      kind: 30402,
      created_at: 1_700_000_000,
      content: "A public listing",
      tags: [
        ["d", dTag],
        ["title", dTag],
        ["type", "simple", "physical"],
        ["visibility", "public"],
        ["price", "100", "SAT"],
        ["image", "https://cdn.conduit.market/conduit-test/product.png"],
      ],
    },
    secret
  )
}

afterEach(() => __resetCommerceTestOverrides())

it("persists a batch arriving at the drain completion handoff before its callback settles", async () => {
  const first = product("drain-first")
  const handoff = product("drain-handoff")
  const cached = new Map<string, CachedProduct>()
  const snapshots: string[][] = []
  let deliver!: Parameters<typeof fetchPublicEventsProgressive>[2]
  let handoffDone!: Promise<void>
  let scheduled = false
  let readSettled = false
  __setCommerceTestOverrides({
    now: () => 1_700_000_100_000,
    getRelayLists: async () => new Map(),
    getCachedProducts: async () => [...cached.values()],
    putCachedProducts: async (rows) => {
      for (const row of rows) cached.set(row.id, row)
    },
    getCachedProductTombstones: async () => [],
    putCachedProductTombstones: async () => {},
    fetchPublicEventsWithDiagnostics: async () => ({ events: [], relays: [] }),
    fetchPublicEventsProgressive: async (_filter, _options, onProgress) => {
      deliver = onProgress
      await onProgress({
        relayUrl: "wss://first.example",
        events: [first],
        mergedEvents: [first],
        status: "success",
      })
      await handoffDone
      // The transport is still active. A final full-frontier cache write must
      // not mask a dropped progressive batch or prematurely resolved callback.
      expect(readSettled).toBe(false)
      expect(
        [...cached.values()].some((row) => row.eventId === handoff.id)
      ).toBe(true)
      expect(snapshots.some((ids) => ids.includes(handoff.id))).toBe(true)
      return [first, handoff]
    },
  })

  const read = getMarketplaceProductsProgressive(
    { merchantPubkey: first.pubkey },
    (result) => {
      snapshots.push(result.data.map((record) => record.eventId))
      if (scheduled) return
      scheduled = true
      // publishProgress resolves after this callback. One microtask allows
      // the drain's await to resume; the next delivers at the former gap
      // between loop completion and the separate .then cleanup continuation.
      handoffDone = new Promise<void>((resolve, reject) => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            Promise.resolve(
              deliver({
                relayUrl: "wss://handoff.example",
                events: [handoff],
                mergedEvents: [first, handoff],
                status: "success",
              })
            ).then(resolve, reject)
          })
        )
      })
    }
  )
  const result = await read
  readSettled = true
  expect(result.data.map((record) => record.eventId).sort()).toEqual(
    [first.id, handoff.id].sort()
  )
})
