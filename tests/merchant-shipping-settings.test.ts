import Dexie from "dexie"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { afterAll, describe, expect, it, spyOn } from "bun:test"
import { NDKPrivateKeySigner, NDKEvent } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  MERCHANT_SHIPPING_SETTINGS_D_TAG,
  fetchMerchantShippingSettings,
  isValidSignedPublicNostrEvent,
  parseMerchantShippingSettings,
  publishMerchantShippingSettings,
  selectMerchantShippingEvent,
  serializeMerchantShippingSettings,
  type MerchantShippingSettings,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"
import type {
  fetchSignedEventsFanoutDetailed,
  publishWithPlanner,
} from "@conduit/core"

const evidenceDb = new ConduitDB("merchant-shipping-settings-test", {
  indexedDB,
  IDBKeyRange,
})

afterAll(() => evidenceDb.delete())

async function signedSettings(
  signer: NDKPrivateKeySigner,
  createdAt: number,
  value = settings
): Promise<SignedPublicNostrEvent> {
  const event = new NDKEvent()
  event.kind = EVENT_KINDS.APPLICATION_DATA
  event.pubkey = (await signer.user()).pubkey
  event.created_at = createdAt
  event.tags = [["d", MERCHANT_SHIPPING_SETTINGS_D_TAG]]
  event.content = serializeMerchantShippingSettings(value)
  await event.sign(signer)
  return event.rawEvent() as SignedPublicNostrEvent
}

const settings: MerchantShippingSettings = {
  countries: [
    {
      code: "US",
      name: "United States",
      restrictTo: ["94**"],
      exclude: ["94102"],
    },
  ],
  shipsFrom: {
    location: "Oakland, Alameda County, California, United States",
    geohash: "9q9p",
  },
}

function readResult(
  events: SignedPublicNostrEvent[],
  status: "success" | "partial" = "success",
  relayUrl = "wss://relay.example"
) {
  return {
    events,
    eventSourceRelayUrls: {},
    relays: [{ relayUrl, status, eventCount: events.length }],
    eventsVerified: true,
  } as Awaited<ReturnType<typeof fetchSignedEventsFanoutDetailed>>
}

describe("Merchant shipping kind 30078 settings", () => {
  it("keeps zones and a coarse area in one versioned document", () => {
    const encoded = serializeMerchantShippingSettings(settings)
    expect(parseMerchantShippingSettings(JSON.parse(encoded))).toEqual(settings)
    expect(encoded).not.toContain("37.8")
    expect(() =>
      parseMerchantShippingSettings({
        ...JSON.parse(encoded),
        shipsFrom: { location: "Oakland", geohash: "9q9px" },
      })
    ).toThrow()
    expect(() =>
      parseMerchantShippingSettings({
        ...JSON.parse(encoded),
        countries: [{ code: "RU", restrictTo: [], exclude: [] }],
      })
    ).toThrow()
  })

  it("signs a separate merchant settings address and recovers it on a fresh read", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    let published: NDKEvent | null = null
    const fetchEvents = (async () =>
      readResult(
        published ? [published.rawEvent() as SignedPublicNostrEvent] : []
      )) as typeof fetchSignedEventsFanoutDetailed
    const publishEvent = (async (event: NDKEvent) => {
      published = event
      return { successfulRelayUrls: ["wss://relay.example"] }
    }) as typeof publishWithPlanner
    const revision = await publishMerchantShippingSettings({
      pubkey,
      settings,
      dependencies: {
        signer,
        evidenceDb,
        readRelayUrls: ["wss://relay.example"],
        fetchEvents,
        publishEvent,
        now: () => 1_800_000_000_000,
      },
    })
    expect(published).not.toBeNull()
    const raw = published!.rawEvent() as SignedPublicNostrEvent
    expect(raw.kind).toBe(EVENT_KINDS.APPLICATION_DATA)
    expect(raw.tags).toEqual([["d", MERCHANT_SHIPPING_SETTINGS_D_TAG]])
    expect(isValidSignedPublicNostrEvent(raw)).toBe(true)
    expect(revision.eventId).toBe(raw.id)
    expect(selectMerchantShippingEvent([raw], pubkey)?.id).toBe(raw.id)
    expect(
      await fetchMerchantShippingSettings(pubkey, {
        evidenceDb,
        readRelayUrls: ["wss://relay.example"],
        fetchEvents,
      })
    ).toEqual({
      state: "found",
      settings,
      revision,
      coverageComplete: true,
    })
    const cleared = { ...settings, shipsFrom: null }
    const nextRevision = await publishMerchantShippingSettings({
      pubkey,
      settings: cleared,
      acceptedRevision: revision,
      dependencies: {
        signer,
        evidenceDb,
        readRelayUrls: ["wss://relay.example"],
        fetchEvents,
        publishEvent,
        now: () => 1_800_000_000_000,
      },
    })
    expect(nextRevision.createdAt).toBeGreaterThan(revision.createdAt)
    expect(
      await fetchMerchantShippingSettings(pubkey, {
        evidenceDb,
        readRelayUrls: ["wss://relay.example"],
        fetchEvents,
      })
    ).toEqual({
      state: "found",
      settings: cleared,
      revision: nextRevision,
      coverageComplete: true,
    })
    await expect(
      publishMerchantShippingSettings({
        pubkey,
        settings,
        acceptedRevision: revision,
        dependencies: {
          evidenceDb,
          signer,
          readRelayUrls: ["wss://relay.example"],
          fetchEvents,
          publishEvent,
        },
      })
    ).rejects.toThrow("changed on another session")
  })

  it("retains a signed revision across reload and refuses replacement after complete omission on another relay", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    const raw = await signedSettings(signer, 1_800_000_000)
    const observed = await fetchMerchantShippingSettings(pubkey, {
      evidenceDb,
      readRelayUrls: ["wss://relay.example"],
      fetchEvents: (async () =>
        readResult([raw])) as typeof fetchSignedEventsFanoutDetailed,
    })
    expect(observed.state).toBe("found")
    evidenceDb.close()
    await evidenceDb.open()
    const newRelay = "wss://changed-relay.example"
    const fetchEvents = (async () =>
      readResult(
        [],
        "success",
        newRelay
      )) as typeof fetchSignedEventsFanoutDetailed
    let publishes = 0
    const publishEvent = (async () => {
      publishes += 1
      return { successfulRelayUrls: [newRelay] }
    }) as typeof publishWithPlanner
    await expect(
      publishMerchantShippingSettings({
        pubkey,
        settings: { ...settings, shipsFrom: null },
        acceptedRevision: null,
        dependencies: {
          evidenceDb,
          signer,
          readRelayUrls: [newRelay],
          fetchEvents,
          publishEvent,
        },
      })
    ).rejects.toThrow("previously published shipping settings")
    expect(publishes).toBe(0)
    const omitted = await fetchMerchantShippingSettings(pubkey, {
      evidenceDb,
      readRelayUrls: [newRelay],
      fetchEvents,
    })
    expect(omitted).toEqual({
      state: "found",
      settings,
      revision: { eventId: raw.id, createdAt: raw.created_at },
      coverageComplete: true,
      retained: true,
    })
  })

  it("preserves stronger evidence through stale and unavailable reads, then accepts a confirmed newer revision", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    const raw = await signedSettings(signer, 1_800_000_001)
    const read = (events: SignedPublicNostrEvent[]) =>
      fetchMerchantShippingSettings(pubkey, {
        evidenceDb,
        readRelayUrls: ["wss://relay.example"],
        fetchEvents: (async () =>
          readResult(events)) as typeof fetchSignedEventsFanoutDetailed,
      })
    await read([raw])
    const older = await signedSettings(signer, raw.created_at - 1, {
      ...settings,
      shipsFrom: null,
    })
    expect(await read([older])).toMatchObject({
      state: "found",
      settings,
      revision: { eventId: raw.id },
      coverageComplete: true,
      retained: true,
    })
    expect(
      await fetchMerchantShippingSettings(pubkey, {
        evidenceDb,
        readRelayUrls: ["wss://relay.example"],
        fetchEvents: (async () => {
          throw new Error("Unavailable relay")
        }) as typeof fetchSignedEventsFanoutDetailed,
      })
    ).toMatchObject({
      state: "found",
      settings,
      revision: { eventId: raw.id },
      coverageComplete: false,
      retained: true,
    })
    const confirmed = await read([raw])
    expect(confirmed).toMatchObject({ state: "found", coverageComplete: true })
    expect(confirmed).not.toHaveProperty("retained")
    const revision = await publishMerchantShippingSettings({
      pubkey,
      settings: { ...settings, shipsFrom: null },
      acceptedRevision: { eventId: raw.id, createdAt: raw.created_at },
      dependencies: {
        evidenceDb,
        signer,
        readRelayUrls: ["wss://relay.example"],
        fetchEvents: (async () =>
          readResult([raw])) as typeof fetchSignedEventsFanoutDetailed,
        publishEvent: (async () => ({
          successfulRelayUrls: ["wss://relay.example"],
        })) as typeof publishWithPlanner,
        now: () => raw.created_at * 1000,
      },
    })
    expect(await read([])).toMatchObject({
      state: "found",
      settings: { ...settings, shipsFrom: null },
      revision,
      retained: true,
    })
  })

  it("keeps retained evidence account-scoped and rejects forged local evidence", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    const raw = await signedSettings(signer, 1_800_000_000)
    await fetchMerchantShippingSettings(pubkey, {
      evidenceDb,
      readRelayUrls: ["wss://relay.example"],
      fetchEvents: (async () =>
        readResult([raw])) as typeof fetchSignedEventsFanoutDetailed,
    })
    const other = (await NDKPrivateKeySigner.generate().user()).pubkey
    const dependencies = {
      evidenceDb,
      readRelayUrls: ["wss://relay.example"],
      fetchEvents: (async () =>
        readResult([])) as typeof fetchSignedEventsFanoutDetailed,
    }
    expect(await fetchMerchantShippingSettings(other, dependencies)).toEqual({
      state: "not_found",
    })
    await evidenceDb.merchantShippingSettingsEvidence.put({
      pubkey: other,
      signedEvent: raw,
    })
    expect(await fetchMerchantShippingSettings(other, dependencies)).toEqual({
      state: "unavailable",
      reason: "invalid_document",
    })
    await evidenceDb.merchantShippingSettingsEvidence.put({
      pubkey,
      signedEvent: {
        ...raw,
        content: serializeMerchantShippingSettings({
          ...settings,
          shipsFrom: null,
        }),
      },
    })
    expect(await fetchMerchantShippingSettings(pubkey, dependencies)).toEqual({
      state: "unavailable",
      reason: "invalid_document",
    })
  })

  it("refuses saving without usable evidence storage before signing or publishing", async () => {
    const closedDb = new ConduitDB("merchant-shipping-settings-closed", {
      indexedDB,
      IDBKeyRange,
    })
    closedDb.close()
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    const sign = spyOn(signer, "sign")
    let publishes = 0
    try {
      await expect(
        publishMerchantShippingSettings({
          pubkey,
          settings,
          dependencies: {
            evidenceDb: closedDb,
            signer,
            readRelayUrls: ["wss://relay.example"],
            fetchEvents: (async () =>
              readResult([])) as typeof fetchSignedEventsFanoutDetailed,
            publishEvent: (async () => {
              publishes += 1
              return { successfulRelayUrls: ["wss://relay.example"] }
            }) as typeof publishWithPlanner,
          },
        })
      ).rejects.toThrow("device could not retain")
      expect(sign).not.toHaveBeenCalled()
      expect(publishes).toBe(0)
    } finally {
      sign.mockRestore()
      await closedDb.delete()
    }
  })

  it("adds the evidence store when upgrading v22 without changing existing cart state", async () => {
    const name = "merchant-shipping-settings-v22"
    const prior = new Dexie(name, { indexedDB, IDBKeyRange })
    prior.version(22).stores({ shoppingCarts: "id, updatedAt" })
    const existing = { id: "default", updatedAt: 1, payload: "existing cart" }
    await prior.table("shoppingCarts").put(existing)
    prior.close()
    const upgraded = new ConduitDB(name, { indexedDB, IDBKeyRange })
    try {
      await upgraded.open()
      expect(await upgraded.shoppingCarts.get("default")).toEqual(existing)
      expect(await upgraded.merchantShippingSettingsEvidence.count()).toBe(0)
    } finally {
      await upgraded.delete()
    }
  })

  it("does not authorize a replacement when another read retains a revision during an empty lookup", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    const raw = await signedSettings(signer, 1_800_000_000)
    const fetchEvents = (async () => {
      await fetchMerchantShippingSettings(pubkey, {
        evidenceDb,
        readRelayUrls: ["wss://relay.example"],
        fetchEvents: (async () =>
          readResult([raw])) as typeof fetchSignedEventsFanoutDetailed,
      })
      return readResult([])
    }) as typeof fetchSignedEventsFanoutDetailed
    await expect(
      publishMerchantShippingSettings({
        pubkey,
        settings: { ...settings, shipsFrom: null },
        acceptedRevision: null,
        dependencies: {
          evidenceDb,
          signer,
          readRelayUrls: ["wss://relay.example"],
          fetchEvents,
        },
      })
    ).rejects.toThrow("previously published shipping settings")
  })

  it("does not replace settings on an incomplete read", async () => {
    const signer = NDKPrivateKeySigner.generate()
    const pubkey = (await signer.user()).pubkey
    const fetchEvents = (async () =>
      readResult([], "partial")) as typeof fetchSignedEventsFanoutDetailed
    await expect(
      publishMerchantShippingSettings({
        pubkey,
        settings,
        dependencies: {
          evidenceDb,
          signer,
          readRelayUrls: ["wss://relay.example"],
          fetchEvents,
        },
      })
    ).rejects.toThrow("could not be read")
  })
})
