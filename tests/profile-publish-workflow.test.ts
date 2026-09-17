import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  NDKEvent,
  NDKPrivateKeySigner,
  type NDKRelay,
} from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  __resetRelayPublishTestOverrides,
  __setRelayPublishTestOverrides,
  getProfiles,
  loadSelectedProfileContext,
  publishProfileContext,
  ProfilePublishSupersededError,
  type CachedProfile,
} from "@conduit/core"
import {
  __resetNdkTestState,
  setSigner,
} from "../packages/core/src/protocol/ndk"

const SECRET = generateSecretKey()
const PUBKEY = getPublicKey(SECRET)
const RELAY = "wss://relay.damus.io"
const NOW = Math.floor(Date.now() / 1_000)
const originalPublish = NDKEvent.prototype.publish
let durable: CachedProfile | undefined
let events: NDKEvent[]
let published: Event[]
let failWrites: boolean
let failReads: boolean
let failNetwork: boolean
let partial: boolean
let afterNetwork: (() => void) | undefined
let afterPublish: (() => void) | undefined

function profileEvent(content: string, createdAt = NOW + 30): NDKEvent {
  return new NDKEvent(
    undefined,
    finalizeEvent({ kind: 0, created_at: createdAt, content, tags: [] }, SECRET)
  )
}

beforeEach(() => {
  durable = undefined
  events = []
  published = []
  failWrites = false
  failReads = false
  failNetwork = false
  partial = false
  afterNetwork = undefined
  afterPublish = undefined
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetRelayPublishTestOverrides()
  __resetNdkTestState()
  setSigner(new NDKPrivateKeySigner(Buffer.from(SECRET).toString("hex")))
  __setRelayListTestOverrides({
    fetchEventsFanout: async () => [],
    loadCached: async () => undefined,
    putCached: async () => {},
  })
  __setCommerceTestOverrides({
    getCachedProducts: async () => [],
    getCachedProfiles: async (pubkeys) => {
      if (failReads) throw new Error("Synthetic storage read failure")
      return pubkeys.map((pubkey) => (pubkey === PUBKEY ? durable : undefined))
    },
    putCachedProfiles: async (rows) => {
      if (failWrites) throw new Error("Synthetic storage write failure")
      durable = rows.find((row) => row.pubkey === PUBKEY) ?? durable
    },
    fetchEventsFanoutWithDiagnostics: async () => {
      if (failNetwork) throw new Error("Synthetic network failure")
      afterNetwork?.()
      return {
        events,
        attemptedRelayUrls: [RELAY, "wss://nos.lol"],
        successfulRelayUrls: partial ? [RELAY] : [RELAY, "wss://nos.lol"],
        failedRelayUrls: partial ? ["wss://nos.lol"] : [],
        cappedRelayUrls: [],
      }
    },
  })
  __setRelayPublishTestOverrides({
    planPublishRelays: async () => ({
      intent: "author_event",
      primaryRelayUrls: [RELAY],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    }),
  })
  NDKEvent.prototype.publish = async function () {
    published.push(this.rawEvent() as Event)
    afterPublish?.()
    return new Set([{ url: RELAY } as NDKRelay])
  }
})

afterEach(() => {
  NDKEvent.prototype.publish = originalPublish
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetRelayPublishTestOverrides()
  __resetNdkTestState()
})

describe("selected profile publish workflow", () => {
  for (const stored of ["stale", "empty"] as const) {
    it(`publishes from exact observed raw context when writes fail over ${stored} durable storage`, async () => {
      if (stored === "stale")
        durable = {
          pubkey: PUBKEY,
          name: "Old name",
          about: "Old biography",
          lud16: "old@wallet.example",
          rawContent: JSON.stringify({
            name: "Old name",
            about: "Old biography",
            lud16: "old@wallet.example",
          }),
          eventId: "1".repeat(64),
          eventCreatedAt: NOW - 60,
          cachedAt: Date.now(),
        }
      const raw = {
        name: "New name",
        about: "New biography",
        custom_field: { enabled: true, tags: ["keep"] },
      }
      events = [profileEvent(JSON.stringify(raw))]
      failWrites = true
      const result = await publishProfileContext(
        { displayName: "User edit" },
        "market"
      )
      expect(published).toHaveLength(1)
      expect(verifyEvent(published[0]!)).toBe(true)
      expect(JSON.parse(published[0]!.content)).toEqual({
        ...raw,
        display_name: "User edit",
      })
      expect(published[0]!.created_at).toBeGreaterThan(events[0]!.created_at!)
      expect(result.frontier?.eventId).toBe(published[0]!.id)
      expect(result.persistence).toBe("session")
      expect(result.profile.lud16).toBeUndefined()
      expect((await loadSelectedProfileContext(PUBKEY)).frontier?.eventId).toBe(
        published[0]!.id
      )
    })
  }

  it("keeps display enrichment out of the exact profile edit baseline", async () => {
    const rich = profileEvent(
      JSON.stringify({
        name: "Older name",
        about: "Older bio",
        lud16: "old@wallet.example",
      }),
      NOW
    )
    events = [rich, profileEvent("{}")]
    const result = await getProfiles({
      pubkeys: [PUBKEY],
      skipCache: true,
      requireCompleteEvidence: true,
      evidenceScope: "profile_edit",
    })
    expect(result.data[PUBKEY]?.about).toBe("Older bio")
    expect(result.profileContexts[PUBKEY]?.profile.about).toBeUndefined()
    expect(result.profileContexts[PUBKEY]?.frontier?.rawContent).toBe("{}")
    await publishProfileContext(
      { name: "Edited name", about: "Edited biography" },
      "market"
    )
    expect(JSON.parse(published[0]!.content)).toEqual({
      name: "Edited name",
      about: "Edited biography",
    })
  })

  it("repairs a completely observed malformed frontier using the readable repair projection", async () => {
    events = [
      profileEvent(
        JSON.stringify({
          name: "Readable name",
          about: "Readable biography",
          lud16: "old@wallet.example",
        }),
        NOW
      ),
      profileEvent("[]"),
    ]
    failWrites = true
    const result = await publishProfileContext(
      { displayName: "Repaired" },
      "market"
    )
    expect(JSON.parse(published[0]!.content)).toEqual({
      name: "Readable name",
      about: "Readable biography",
      display_name: "Repaired",
    })
    expect(published[0]!.created_at).toBeGreaterThan(events[1]!.created_at!)
    expect(result.frontier?.validity).toBe("valid")
  })

  it("allows observed valid context under partial coverage but does not repair malformed partial context", async () => {
    partial = true
    events = [
      profileEvent(
        JSON.stringify({
          name: "Current name",
          about: "Current biography",
          extension: "keep",
        })
      ),
    ]
    await publishProfileContext({ displayName: "Edited" }, "market")
    expect(published).toHaveLength(1)
    events = [profileEvent("[]", published[0]!.created_at + 1)]
    await expect(
      publishProfileContext({ name: "Repair", about: "Biography" }, "market")
    ).rejects.toThrow("current profile could not be confirmed")
    expect(published).toHaveLength(1)
  })

  it("keeps unsaved negative authority through outage and admits a later observed valid repair", async () => {
    failWrites = true
    events = [profileEvent("[]")]
    await getProfiles({
      pubkeys: [PUBKEY],
      skipCache: true,
      requireCompleteEvidence: true,
      evidenceScope: "profile_edit",
    })
    failNetwork = true
    await expect(
      publishProfileContext({ name: "Edit", about: "Biography" }, "market")
    ).rejects.toThrow("current profile could not be confirmed")
    expect(published).toHaveLength(0)
    failNetwork = false
    events = [
      profileEvent(
        JSON.stringify({
          name: "Recovered",
          about: "Current biography",
          extension: "keep",
        }),
        NOW + 40
      ),
    ]
    failWrites = false
    const repaired = await publishProfileContext(
      { displayName: "Edited" },
      "market"
    )
    expect(repaired.persistence).toBe("durable")
    expect(published).toHaveLength(1)
    expect(JSON.parse(published[0]!.content).extension).toBe("keep")
    expect((await loadSelectedProfileContext(PUBKEY)).frontier?.eventId).toBe(
      published[0]!.id
    )
  })

  it("does not treat unavailable storage plus an empty network read as a new profile", async () => {
    failReads = true
    await expect(
      publishProfileContext(
        { name: "New name", about: "New biography" },
        "market"
      )
    ).rejects.toThrow("current profile could not be confirmed")
    expect(published).toHaveLength(0)
    await expect(loadSelectedProfileContext(PUBKEY)).rejects.toThrow(
      "context is unavailable"
    )
  })

  it("cancels before signing when the session changes during profile refresh", async () => {
    let current = true
    const originalSign = NDKEvent.prototype.sign
    let signCalls = 0
    NDKEvent.prototype.sign = async function (...args) {
      signCalls += 1
      return originalSign.apply(this, args)
    }
    try {
      events = [
        profileEvent(JSON.stringify({ name: "Name", about: "Biography" })),
      ]
      afterNetwork = () => {
        current = false
      }
      await expect(
        publishProfileContext({ displayName: "Edit" }, "market", {
          shouldContinue: () => current,
        })
      ).rejects.toThrow("connected account changed")
      expect(signCalls).toBe(0)
      expect(published).toHaveLength(0)
    } finally {
      NDKEvent.prototype.sign = originalSign
    }
  })

  it("preserves a stronger concurrent frontier instead of reporting publish success", async () => {
    events = [
      profileEvent(JSON.stringify({ name: "Current", about: "Biography" })),
    ]
    afterPublish = () => {
      const newer = profileEvent(
        JSON.stringify({ name: "Concurrent winner", about: "Keep this" }),
        published[0]!.created_at + 1
      )
      durable = {
        pubkey: PUBKEY,
        name: "Concurrent winner",
        about: "Keep this",
        rawContent: newer.content,
        eventId: newer.id,
        eventCreatedAt: newer.created_at,
        cachedAt: Date.now(),
      }
    }
    await expect(
      publishProfileContext({ displayName: "Edit" }, "market")
    ).rejects.toBeInstanceOf(ProfilePublishSupersededError)
    expect((await loadSelectedProfileContext(PUBKEY)).profile.name).toBe(
      "Concurrent winner"
    )
  })
})
