import { setTestAccountSigner as setSigner } from "./helpers/plain-signer"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
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
  config,
  createInMemoryOwnerRelayListEvidenceRepository,
  getProfiles,
  loadSelectedProfileContext,
  publishProfileContext,
  ProfilePublishSupersededError,
  type CachedProfile,
} from "@conduit/core"
import { __resetPublicReaderTestState } from "../packages/core/src/protocol/relay-reader"
import { setAppWritePlanFixture } from "./helpers/app-write-plan"

const SECRET = generateSecretKey()
const PUBKEY = getPublicKey(SECRET)
const RELAY = "wss://profile-write.fixture.conduit.market"
const NOW = Math.floor(Date.now() / 1_000)
const originalCommerceRelayUrls = [...config.commerceRelayUrls]
let durable: CachedProfile | undefined
let events: NDKEvent[]
let published: Event[]
let attemptedRelayUrls: string[]
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
  attemptedRelayUrls = []
  failWrites = false
  failReads = false
  failNetwork = false
  partial = false
  afterNetwork = undefined
  afterPublish = undefined
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetRelayPublishTestOverrides()
  __resetPublicReaderTestState()
  setSigner(new NDKPrivateKeySigner(Buffer.from(SECRET).toString("hex")))
  __setRelayListTestOverrides({
    fetchPublicEvents: async () => [],
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
    fetchPublicEventsWithDiagnostics: async () => {
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
  setAppWritePlanFixture({
    accountNetworkLocalStateRepository: { get: async () => undefined },
    ownerRelayListEvidenceRepository:
      createInMemoryOwnerRelayListEvidenceRepository(),
    planPublishRelays: async () => ({
      intent: "author_event",
      primaryRelayUrls: [RELAY],
      broadcastRelayUrls: [],
      parkedRelayUrls: [],
    }),
  })
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: async ({ relayUrl, signedEvent }) => {
      attemptedRelayUrls.push(relayUrl)
      if (relayUrl !== RELAY) return "rejected"
      published.push(structuredClone(signedEvent) as Event)
      afterPublish?.()
      return "acked"
    },
  })
})

afterEach(() => {
  config.commerceRelayUrls = [...originalCommerceRelayUrls]
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetRelayPublishTestOverrides()
  __resetPublicReaderTestState()
})

describe("selected profile publish workflow", () => {
  for (const authenticatedPubkey of [null, PUBKEY]) {
    it(`publishes to the planned primary relay with ${authenticatedPubkey ? "authenticated" : "anonymous"} context`, async () => {
      events = [
        profileEvent(JSON.stringify({ name: "Current", about: "Biography" })),
      ]

      await publishProfileContext({ displayName: "Edit" }, "market", {
        authenticatedPubkey,
      })

      expect(attemptedRelayUrls).toEqual([RELAY])
      expect(published).toHaveLength(1)
      expect(verifyEvent(published[0]!)).toBe(true)
    })
  }

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

  it("does not retain publish success when the session changes during relay publication", async () => {
    let current = true
    events = [
      profileEvent(JSON.stringify({ name: "Current", about: "Biography" })),
    ]
    afterPublish = () => {
      current = false
    }

    await expect(
      publishProfileContext({ displayName: "Edit" }, "market", {
        shouldContinue: () => current,
      })
    ).rejects.toThrow("connected account changed")
    expect(published).toHaveLength(1)
    expect(durable?.eventId).not.toBe(published[0]!.id)
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

describe("Wallets profile-address publication", () => {
  for (const [name, original, address, expected] of [
    ["clears a sparse lud16 address", { lud16: "old@wallet.example" }, "", {}],
    ["clears a sparse legacy address", { lud06: "lnurl-legacy" }, "", {}],
    [
      "clears legacy receiving fields while preserving metadata",
      {
        name: "Current",
        about: "Biography",
        lud06: "lnurl-legacy",
        extension: { keep: [1, 2] },
      },
      "",
      { name: "Current", about: "Biography", extension: { keep: [1, 2] } },
    ],
    [
      "replaces legacy receiving fields with one intended address",
      { lud06: "lnurl-legacy", extension: { keep: true } },
      "new@conduit.cash",
      { lud16: "new@conduit.cash", extension: { keep: true } },
    ],
  ] as const) {
    it(name, async () => {
      events = [profileEvent(JSON.stringify(original))]
      await publishProfileContext({ lud16: address }, "market", {
        authenticatedPubkey: PUBKEY,
        expectedLightningAddress:
          "lud16" in original ? original.lud16 : original.lud06,
      })
      expect(published).toHaveLength(1)
      expect(JSON.parse(published[0]!.content)).toEqual(expected)
      expect(
        (await loadSelectedProfileContext(PUBKEY)).frontier?.rawContent
      ).toBe(published[0]!.content)
    })
  }
  it("preserves unknown metadata while replacing both reviewed receiving fields", async () => {
    const original = {
      name: "Current",
      about: "Biography",
      lud16: "old@wallet.example",
      lud06: "lnurl-legacy",
      custom: { flags: [1, "keep"] },
      display_name: "Display",
    }
    events = [profileEvent(JSON.stringify(original))]
    await publishProfileContext({ lud16: "new@conduit.cash" }, "market", {
      authenticatedPubkey: PUBKEY,
      expectedLightningAddress: original.lud16,
    })
    expect(published).toHaveLength(1)
    const { lud06: _legacy, ...metadata } = original
    expect(JSON.parse(published[0]!.content)).toEqual({
      ...metadata,
      lud16: "new@conduit.cash",
    })
  })
  it("rejects unrelated metadata edits through the address-only workflow", async () => {
    events = [
      profileEvent(
        JSON.stringify({
          name: "Retained",
          about: "Biography",
          lud16: "old@wallet.example",
        })
      ),
    ]
    await expect(
      publishProfileContext(
        { lud16: "new@conduit.cash", name: "Erase" },
        "market",
        {
          authenticatedPubkey: PUBKEY,
          expectedLightningAddress: "old@wallet.example",
        }
      )
    ).rejects.toThrow("Choose the public Lightning address")
    expect(published).toHaveLength(0)
  })
  it("requires a fresh choice after a competing address change", async () => {
    events = [
      profileEvent(
        JSON.stringify({
          name: "Current",
          about: "Biography",
          lud16: "changed@wallet.example",
        })
      ),
    ]
    await expect(
      publishProfileContext({ lud16: "new@conduit.cash" }, "market", {
        authenticatedPubkey: PUBKEY,
        expectedLightningAddress: "reviewed@wallet.example",
      })
    ).rejects.toThrow("address changed")
    expect(published).toHaveLength(0)
  })
  it("rebases an address choice over a completed competing profile-details edit", async () => {
    events = [
      profileEvent(
        JSON.stringify({
          name: "Edited elsewhere",
          about: "Updated biography",
          lud16: "old@wallet.example",
          extension: { keep: true },
        })
      ),
    ]
    await publishProfileContext({ lud16: "new@conduit.cash" }, "market", {
      authenticatedPubkey: PUBKEY,
      expectedLightningAddress: "old@wallet.example",
    })
    expect(JSON.parse(published[0]!.content)).toEqual({
      name: "Edited elsewhere",
      about: "Updated biography",
      lud16: "new@conduit.cash",
      extension: { keep: true },
    })
  })
  it("rebases an address onto competing ordinary edits during signer consent", async () => {
    const original = profileEvent(
      JSON.stringify({
        name: "Current",
        about: "Biography",
        lud16: "old@wallet.example",
      })
    )
    const changed = profileEvent(
      JSON.stringify({
        name: "Changed",
        about: "New biography",
        extension: { concurrent: true },
        lud16: "old@wallet.example",
      }),
      NOW + 40
    )
    events = [original]
    let reads = 0
    afterNetwork = () => {
      if (++reads >= 2) events = [changed]
    }
    await publishProfileContext({ lud16: "new@conduit.cash" }, "market", {
      authenticatedPubkey: PUBKEY,
      expectedLightningAddress: "old@wallet.example",
    })
    expect(published).toHaveLength(1)
    expect(JSON.parse(published[0]!.content)).toEqual({
      name: "Changed",
      about: "New biography",
      extension: { concurrent: true },
      lud16: "new@conduit.cash",
    })
  })
  it("allows the disclosed default only after confirming an empty complete profile", async () => {
    await publishProfileContext({ lud16: "new@conduit.cash" }, "market", {
      authenticatedPubkey: PUBKEY,
      expectedLightningAddress: "",
    })
    expect(published).toHaveLength(1)
    expect(JSON.parse(published[0]!.content)).toEqual({
      lud16: "new@conduit.cash",
    })
  })
  it("never uses address-only updates to repair malformed profiles", async () => {
    events = [profileEvent("not JSON")]
    await expect(
      publishProfileContext({ lud16: "new@conduit.cash" }, "market", {
        authenticatedPubkey: PUBKEY,
        expectedLightningAddress: "",
      })
    ).rejects.toThrow("Repair your profile")
    expect(published).toHaveLength(0)
  })
})

describe("reviewed Lightning address normalization", () => {
  for (const field of ["lud16", "lud06"] as const) {
    for (const next of ["new@wallet.example", ""] as const) {
      it(`edits a padded ${field} baseline for ${next ? "replacement" : "deletion"}`, async () => {
        const baseline =
          field === "lud16"
            ? "  OLD@wallet.example  "
            : "  https://wallet.example/LNURL/Token  "
        events = [
          profileEvent(
            JSON.stringify({ [field]: baseline, extension: { keep: true } })
          ),
        ]
        await publishProfileContext({ lud16: next }, "market", {
          authenticatedPubkey: PUBKEY,
          expectedLightningAddress: baseline,
        })
        const content = JSON.parse(published[0]!.content)
        expect(published.length).toBe(1)
        expect(content.extension.keep).toBe(true)
        expect(content.lud06 === undefined).toBe(true)
        expect(content.lud16 === (next || undefined)).toBe(true)
      })
    }
  }
  it("normalizes a padded lud16 while preserving complete metadata", async () => {
    const baseline = "  OLD@wallet.example  "
    events = [
      profileEvent(
        JSON.stringify({ lud16: baseline, extension: { keep: true } })
      ),
    ]
    await publishProfileContext({ lud16: "old@wallet.example" }, "market", {
      authenticatedPubkey: PUBKEY,
      expectedLightningAddress: baseline,
    })
    expect(published.length).toBe(1)
    expect(
      JSON.parse(published[0]!.content).lud16 === "old@wallet.example"
    ).toBe(true)
    expect(JSON.parse(published[0]!.content).extension.keep).toBe(true)
  })
  it("rebases a padded reviewed address over a case-only address and ordinary metadata edit", async () => {
    const baseline = "  OLD@wallet.example  "
    events = [
      profileEvent(
        JSON.stringify({ lud16: baseline, extension: { keep: true } })
      ),
    ]
    let reads = 0
    afterNetwork = () => {
      if (++reads === 2)
        events = [
          profileEvent(
            JSON.stringify({
              lud16: "old@wallet.example",
              name: "Updated elsewhere",
              extension: { keep: true, added: true },
            }),
            NOW + 31
          ),
        ]
    }
    await publishProfileContext({ lud16: "new@wallet.example" }, "market", {
      authenticatedPubkey: PUBKEY,
      expectedLightningAddress: baseline,
    })
    expect(published.length).toBe(1)
    const content = JSON.parse(published[0]!.content)
    expect(content.name === "Updated elsewhere").toBe(true)
    expect(content.extension.keep && content.extension.added).toBe(true)
    expect(content.lud16 === "new@wallet.example").toBe(true)
  })
  it("rejects a competing destination after signing a padded baseline", async () => {
    const baseline = "  OLD@wallet.example  "
    events = [profileEvent(JSON.stringify({ lud16: baseline }))]
    let reads = 0
    afterNetwork = () => {
      if (++reads === 2)
        events = [
          profileEvent(
            JSON.stringify({ lud16: "competing@wallet.example" }),
            NOW + 31
          ),
        ]
    }
    await expect(
      publishProfileContext({ lud16: "new@wallet.example" }, "market", {
        authenticatedPubkey: PUBKEY,
        expectedLightningAddress: baseline,
      })
    ).rejects.toThrow("address changed")
    expect(reads).toBe(2)
    expect(published.length).toBe(0)
  })
  it("preserves case-sensitive legacy receiving URL paths in the choice fence", async () => {
    events = [
      profileEvent(
        JSON.stringify({ lud06: "https://wallet.example/LNURL/token" })
      ),
    ]
    await expect(
      publishProfileContext({ lud16: "new@wallet.example" }, "market", {
        authenticatedPubkey: PUBKEY,
        expectedLightningAddress: "https://wallet.example/LNURL/Token",
      })
    ).rejects.toThrow("address changed")
    expect(published.length).toBe(0)
  })
})
