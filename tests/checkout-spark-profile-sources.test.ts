import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  getProfiles,
  type CachedProfile,
} from "@conduit/core"

const secret = generateSecretKey()
const older = finalizeEvent(
  {
    kind: 0,
    created_at: 100,
    tags: [],
    content: JSON.stringify({ name: "First", lud16: "first@example.com" }),
  },
  secret
)
const newer = finalizeEvent(
  {
    kind: 0,
    created_at: 200,
    tags: [],
    content: JSON.stringify({ name: "Second", lud16: "second@example.com" }),
  },
  secret
)
let cache = new Map<string, CachedProfile>()
let observedProfile: typeof older | undefined
const query = {
  pubkeys: [older.pubkey],
  skipCache: true,
  requireCompleteEvidence: true,
  evidenceScope: "payment" as const,
}

beforeEach(() => {
  cache = new Map()
  observedProfile = undefined
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __setRelayListTestOverrides({
    fetchPublicEvents: async () => [],
    loadCached: async () => undefined,
    putCached: async () => {},
  })
  __setCommerceTestOverrides({
    getCachedProfiles: async (pubkeys) =>
      pubkeys.map((pubkey) => cache.get(pubkey)),
    putCachedProfiles: async (rows) => {
      for (const row of rows) cache.set(row.pubkey, row)
    },
    fetchPublicEvents: async () => {
      observedProfile = structuredClone(older)
      return [observedProfile]
    },
  })
})
afterEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
})

describe("checkout profile source retention", () => {
  it("returns detached signed bytes for the final observed payment frontier only", async () => {
    const progress: Awaited<ReturnType<typeof getProfiles>>[] = []
    const result = await getProfiles({
      ...query,
      onProgress: (value) => {
        progress.push(value)
      },
    })
    const context = result.profileContexts[older.pubkey]!
    expect(context.frontier?.eventId).toBe(older.id)
    expect(context.signedEvent).toEqual(structuredClone(older))
    expect(context.signedEvent).not.toBe(older)
    expect(context.signedEvent?.tags).not.toBe(older.tags)
    expect(observedProfile).not.toHaveProperty("rawEvent")
    expect(context.signedEvent).not.toBe(observedProfile)
    expect(context.signedEvent?.tags).not.toBe(observedProfile?.tags)
    expect(
      progress.every(
        (value) => !value.profileContexts[older.pubkey]?.signedEvent
      )
    ).toBe(true)
    expect(cache.get(older.pubkey)).not.toHaveProperty("signedEvent")
  })

  it("does not attach the held read's older event after another read retains a newer frontier", async () => {
    let resume!: () => void
    let started!: () => void
    const held = new Promise<void>((resolve) => {
      resume = resolve
    })
    const begun = new Promise<void>((resolve) => {
      started = resolve
    })
    let count = 0
    __setCommerceTestOverrides({
      fetchPublicEvents: async () => {
        if (++count === 1) {
          started()
          await held
          return [structuredClone(older)]
        }
        return [structuredClone(newer)]
      },
    })
    const pending = getProfiles(query)
    await begun
    const fresh = await getProfiles(query)
    resume()
    const retained = await pending
    expect(fresh.profileContexts[older.pubkey]?.signedEvent).toEqual(
      structuredClone(newer)
    )
    expect(retained.profileContexts[older.pubkey]?.frontier?.eventId).toBe(
      newer.id
    )
    expect(retained.profileContexts[older.pubkey]?.freshness).toBe("retained")
    expect(retained.profileContexts[older.pubkey]).not.toHaveProperty(
      "signedEvent"
    )
  })

  it("does not reconstruct signed bytes from a cached profile when the next read is empty", async () => {
    await getProfiles(query)
    __setCommerceTestOverrides({ fetchPublicEvents: async () => [] })
    const result = await getProfiles(query)
    expect(result.profileContexts[older.pubkey]?.frontier?.eventId).toBe(
      older.id
    )
    expect(result.profileContexts[older.pubkey]).not.toHaveProperty(
      "signedEvent"
    )
  })
})
