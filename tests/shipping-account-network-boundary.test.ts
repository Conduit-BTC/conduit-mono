import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"

import {
  emptyAccountNetworkLocalState,
  type AccountNetworkLocalStateRepository,
} from "../packages/core/src/protocol/account-network-local-state"
import type { FetchEventsFanoutOptions } from "../packages/core/src/protocol/ndk"
import type {
  RelayListLookupOptions,
  RelayList,
} from "../packages/core/src/protocol/relay-list"
import {
  __resetShippingTestOverrides,
  __setShippingTestOverrides,
  getShippingOptions,
  getShippingOptionsByCoordinates,
} from "../packages/core/src/protocol/shipping"

const ACCOUNT = "c".repeat(64)
const OTHER_ACCOUNT = "e".repeat(64)
const MERCHANT = "d".repeat(64)
const REMOVED_RELAY = "wss://removed-shipping.conduit.market"
const RETAINED_RELAY = "wss://retained-shipping.conduit.market"
const OWNER_WS_RELAY = "ws://owner-shipping.example:4848"
const REMOTE_WS_RELAY = "ws://remote-shipping.example:4848"
const COORDINATE = `30406:${MERCHANT}:standard`

const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
  get: async (pubkey) => ({
    ...emptyAccountNetworkLocalState(pubkey),
    exclusions: [
      {
        relayUrl: REMOVED_RELAY,
        committedAt: 1_700_000_000_000,
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
      },
    ],
  }),
}

function relayList(pubkey: string): RelayList {
  return {
    pubkey,
    readRelayUrls: [REMOVED_RELAY, RETAINED_RELAY],
    writeRelayUrls: [REMOVED_RELAY, RETAINED_RELAY],
    eventCreatedAt: 1,
    cachedAt: 1,
  }
}

function successfulEmptyRead(options: FetchEventsFanoutOptions = {}) {
  return {
    events: [],
    relays: (options.relayUrls ?? []).map((relayUrl) => ({
      relayUrl,
      status: "success" as const,
      eventCount: 0,
    })),
    eventsVerified: true,
  }
}

afterEach(() => {
  __resetShippingTestOverrides()
})

describe("shipping account network boundary", () => {
  it("removes excluded relays only at account-scoped final I/O", async () => {
    const relayListCalls: RelayListLookupOptions[] = []
    const finalReadCalls: FetchEventsFanoutOptions[] = []
    __setShippingTestOverrides({
      getRelayLists: async (pubkeys, options = {}) => {
        relayListCalls.push(options)
        return new Map(pubkeys.map((pubkey) => [pubkey, relayList(pubkey)]))
      },
      fetchEventsFanoutDetailed: async (_filter, options = {}) => {
        finalReadCalls.push(options)
        return successfulEmptyRead(options)
      },
      getCachedDeletionTombstones: async () => [],
      putCachedDeletionTombstones: async () => undefined,
      getCachedOptionFrontiers: async () => [],
      putCachedOptionFrontiers: async () => undefined,
    })

    await expect(
      getShippingOptionsByCoordinates([COORDINATE])
    ).resolves.toEqual([])
    const guestRelayUrls = finalReadCalls[0]?.relayUrls ?? []
    expect(guestRelayUrls).toContain(REMOVED_RELAY)
    expect(guestRelayUrls).toContain(RETAINED_RELAY)

    finalReadCalls.length = 0
    await expect(
      getShippingOptionsByCoordinates([COORDINATE], {
        accountPubkey: ACCOUNT,
        accountNetworkLocalStateRepository: repository,
      })
    ).resolves.toEqual([])

    expect(relayListCalls).toHaveLength(2)
    expect(relayListCalls[1]).toMatchObject({
      accountPubkey: ACCOUNT,
      accountNetworkLocalStateRepository: repository,
    })
    expect(finalReadCalls).toHaveLength(2)
    for (const call of finalReadCalls) {
      expect(call.accountPubkey).toBe(ACCOUNT)
      expect(call.accountNetworkLocalStateRepository).toBe(repository)
      expect(call.relayUrls).toEqual(
        guestRelayUrls.filter((relayUrl) => relayUrl !== REMOVED_RELAY)
      )
    }
  })

  it("threads the account policy through the retained author-wide reader", async () => {
    const relayListCalls: RelayListLookupOptions[] = []
    const broadReadCalls: FetchEventsFanoutOptions[] = []
    const exactReadCalls: FetchEventsFanoutOptions[] = []
    __setShippingTestOverrides({
      getRelayLists: async (pubkeys, options = {}) => {
        relayListCalls.push(options)
        return new Map(pubkeys.map((pubkey) => [pubkey, relayList(pubkey)]))
      },
      fetchEventsFanout: async (_filter, options = {}) => {
        broadReadCalls.push(options)
        const event = new NDKEvent()
        event.pubkey = MERCHANT
        event.tags = [["d", "standard"]]
        return [event]
      },
      fetchEventsFanoutDetailed: async (_filter, options = {}) => {
        exactReadCalls.push(options)
        return successfulEmptyRead(options)
      },
      getCachedDeletionTombstones: async () => [],
      putCachedDeletionTombstones: async () => undefined,
      getCachedOptionFrontiers: async () => [],
      putCachedOptionFrontiers: async () => undefined,
    })

    await expect(
      getShippingOptions(MERCHANT, {
        accountPubkey: ACCOUNT,
        accountNetworkLocalStateRepository: repository,
      })
    ).resolves.toEqual([])

    expect(relayListCalls).toHaveLength(2)
    for (const call of relayListCalls) {
      expect(call.accountPubkey).toBe(ACCOUNT)
      expect(call.accountNetworkLocalStateRepository).toBe(repository)
      expect(call.allowInsecureRelayUrlsForPubkey).toBeUndefined()
    }
    expect(broadReadCalls).toHaveLength(1)
    expect(exactReadCalls).toHaveLength(2)
    for (const call of [...broadReadCalls, ...exactReadCalls]) {
      expect(call.accountPubkey).toBe(ACCOUNT)
      expect(call.accountNetworkLocalStateRepository).toBe(repository)
      expect(call.relayUrls).not.toContain(REMOVED_RELAY)
      expect(call.relayUrls).toContain(RETAINED_RELAY)
    }
  })

  it("admits only the exact authenticated owner's selected ws relay", async () => {
    const relayListCalls: RelayListLookupOptions[] = []
    const finalReadCalls: FetchEventsFanoutOptions[] = []
    let authorityReads = 0
    __setShippingTestOverrides({
      readAccountRelaySettingsPlanningSnapshot: async () => {
        authorityReads += 1
        return {
          settings: {
            version: 1,
            updatedAt: 1,
            entries: [
              {
                url: OWNER_WS_RELAY,
                readEnabled: true,
                writeEnabled: false,
                section: "public",
                capabilities: {
                  nip11: false,
                  search: false,
                  dm: false,
                  auth: false,
                  commerce: false,
                },
                warnings: {
                  dmWithoutAuth: false,
                  staleRelayInfo: false,
                  unreachable: false,
                  commercePartialSupport: false,
                },
              },
            ],
          },
          signedRelayListAuthoritative: true,
        }
      },
      getRelayLists: async (pubkeys, options = {}) => {
        relayListCalls.push(options)
        return new Map(
          pubkeys.map((pubkey) => [
            pubkey,
            {
              ...relayList(pubkey),
              readRelayUrls: [REMOTE_WS_RELAY, RETAINED_RELAY],
              writeRelayUrls: [REMOTE_WS_RELAY, RETAINED_RELAY],
            },
          ])
        )
      },
      fetchEventsFanoutDetailed: async (_filter, options = {}) => {
        finalReadCalls.push(options)
        return successfulEmptyRead(options)
      },
      getCachedDeletionTombstones: async () => [],
      putCachedDeletionTombstones: async () => undefined,
      getCachedOptionFrontiers: async () => [],
      putCachedOptionFrontiers: async () => undefined,
    })

    await expect(
      getShippingOptionsByCoordinates([COORDINATE], {
        authenticatedPubkey: ACCOUNT,
        accountNetworkLocalStateRepository: repository,
      })
    ).resolves.toEqual([])

    expect(authorityReads).toBe(1)
    expect(relayListCalls).toHaveLength(1)
    expect(relayListCalls[0]).toMatchObject({
      accountPubkey: ACCOUNT,
      authenticatedPubkey: ACCOUNT,
      ownerSelectedRelayUrls: [OWNER_WS_RELAY],
    })
    expect(finalReadCalls).toHaveLength(2)
    for (const call of finalReadCalls) {
      expect(call.accountPubkey).toBe(ACCOUNT)
      expect(call.authenticatedPubkey).toBe(ACCOUNT)
      expect(call.relayUrls).toContain(OWNER_WS_RELAY)
      expect(call.ownerSelectedRelayUrls).toEqual([OWNER_WS_RELAY])
      expect(call.relayUrls).not.toContain(REMOTE_WS_RELAY)
      expect(call.relayUrls).toContain(RETAINED_RELAY)
    }

    relayListCalls.length = 0
    finalReadCalls.length = 0
    await expect(
      getShippingOptionsByCoordinates([COORDINATE], {
        accountPubkey: ACCOUNT,
        authenticatedPubkey: OTHER_ACCOUNT,
        accountNetworkLocalStateRepository: repository,
      })
    ).resolves.toEqual([])

    expect(authorityReads).toBe(1)
    expect(relayListCalls[0]?.authenticatedPubkey).toBeUndefined()
    for (const call of finalReadCalls) {
      expect(call.authenticatedPubkey).toBeUndefined()
      expect(call.ownerSelectedRelayUrls).toEqual([])
      expect(call.relayUrls).not.toContain(OWNER_WS_RELAY)
      expect(call.relayUrls).not.toContain(REMOTE_WS_RELAY)
    }
  })

  it("threads live caller authority through relay-list and final shipping reads", async () => {
    const relayListCalls: RelayListLookupOptions[] = []
    const finalReadCalls: FetchEventsFanoutOptions[] = []
    const controller = new AbortController()
    const shouldContinue = () => true
    __setShippingTestOverrides({
      getRelayLists: async (pubkeys, options = {}) => {
        relayListCalls.push(options)
        return new Map(pubkeys.map((pubkey) => [pubkey, relayList(pubkey)]))
      },
      fetchEventsFanoutDetailed: async (_filter, options = {}) => {
        finalReadCalls.push(options)
        return successfulEmptyRead(options)
      },
      getCachedDeletionTombstones: async () => [],
      putCachedDeletionTombstones: async () => undefined,
      getCachedOptionFrontiers: async () => [],
      putCachedOptionFrontiers: async () => undefined,
    })

    await expect(
      getShippingOptionsByCoordinates([COORDINATE], {
        accountPubkey: ACCOUNT,
        authenticatedPubkey: ACCOUNT,
        accountNetworkLocalStateRepository: repository,
        shouldContinue,
        signal: controller.signal,
      })
    ).resolves.toEqual([])

    expect(relayListCalls).toHaveLength(1)
    expect(relayListCalls[0]?.shouldContinue).toBe(shouldContinue)
    expect(relayListCalls[0]?.signal).toBe(controller.signal)
    expect(finalReadCalls).toHaveLength(2)
    for (const call of finalReadCalls) {
      expect(call.shouldContinue).toBe(shouldContinue)
      expect(call.signal).toBe(controller.signal)
    }
  })
})
