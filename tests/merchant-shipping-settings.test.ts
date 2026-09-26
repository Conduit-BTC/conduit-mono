import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner, type NDKEvent } from "@nostr-dev-kit/ndk"
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
import type {
  fetchSignedEventsFanoutDetailed,
  publishWithPlanner,
} from "@conduit/core"

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
  status: "success" | "partial" = "success"
) {
  return {
    events,
    eventSourceRelayUrls: {},
    relays: [
      { relayUrl: "wss://relay.example", status, eventCount: events.length },
    ],
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
        readRelayUrls: ["wss://relay.example"],
        fetchEvents,
        publishEvent,
        now: () => 1_800_000_000_000,
      },
    })
    expect(nextRevision.createdAt).toBeGreaterThan(revision.createdAt)
    expect(
      await fetchMerchantShippingSettings(pubkey, {
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
          signer,
          readRelayUrls: ["wss://relay.example"],
          fetchEvents,
          publishEvent,
        },
      })
    ).rejects.toThrow("changed on another session")
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
          signer,
          readRelayUrls: ["wss://relay.example"],
          fetchEvents,
        },
      })
    ).rejects.toThrow("could not be read")
  })
})
