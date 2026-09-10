import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"

import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getEventMarketPrivateMessageList,
  getMarketplaceProducts,
  getMerchantStorefront,
  getProductDetail,
  getProductsByIds,
  getProfiles,
} from "../packages/core/src/protocol/commerce"
import {
  emptyAccountNetworkLocalState,
  filterEligibleAccountRelayUrls,
  type AccountNetworkLocalStateRepository,
} from "../packages/core/src/protocol/account-network-local-state"
import {
  __resetEventMarketTestOverrides,
  __setEventMarketTestOverrides,
  getEventMarket,
  getOrganizerEventMarketsDetailed,
} from "../packages/core/src/protocol/event-market"
import {
  __resetEventMarketMerchandiseTestOverrides,
  __setEventMarketMerchandiseTestOverrides,
  getEventMarketReceiptMerchandise,
} from "../packages/core/src/protocol/event-market-merchandise"
import { createInMemoryInboxDeclarationEvidenceRepository } from "../packages/core/src/protocol/inbox-declaration-evidence"
import { readLatestFollowLists } from "../packages/core/src/protocol/follows"
import { readMediaServerPreferences } from "../packages/core/src/protocol/media-server-preferences"
import {
  __resetInboxRelayCache,
  inspectOwnPrivateMessageRelayReadiness,
} from "../packages/core/src/protocol/messaging"
import type { FetchEventsFanoutOptions } from "../packages/core/src/protocol/ndk"
import {
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  getRelayListsDetailed,
  type RelayListLookupOptions,
} from "../packages/core/src/protocol/relay-list"
import { planPublishRelays } from "../packages/core/src/protocol/relay-publish"
import { fetchShopperPresets } from "../packages/core/src/protocol/shopper-presets"
import { getShopperTrustEvidence } from "../packages/core/src/protocol/shopper-trust"
import type { EventMarketReadyReceiptSchema } from "../packages/core/src/schemas"

const ACCOUNT = "a".repeat(64)
const RELAY_URL = "wss://removed-read.conduit.market"

const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
  get: async (pubkey) => ({
    ...emptyAccountNetworkLocalState(pubkey),
    exclusions: [
      {
        relayUrl: RELAY_URL,
        committedAt: 1_700_000_000_000,
        relayListFrontier: { eventId: null, createdAt: null },
        inboxDeclarationFrontier: { eventId: null, createdAt: null },
      },
    ],
  }),
}

function expectAccountPolicy(
  options: Pick<
    FetchEventsFanoutOptions,
    "accountPubkey" | "accountNetworkLocalStateRepository"
  >
): void {
  expect(options.accountPubkey).toBe(ACCOUNT)
  expect(options.accountNetworkLocalStateRepository).toBe(repository)
}

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetEventMarketMerchandiseTestOverrides()
  __resetEventMarketTestOverrides()
  __resetInboxRelayCache()
  __resetRelayListTestOverrides()
})

function relayList(pubkey: string) {
  return {
    pubkey,
    readRelayUrls: [RELAY_URL],
    writeRelayUrls: [RELAY_URL],
    eventCreatedAt: 1,
    cachedAt: 1,
  }
}

function finalIoRecorder(openedRelayUrls: string[]) {
  return async (_filter: unknown, options: FetchEventsFanoutOptions = {}) => {
    const candidates = options.relayUrls ?? []
    const admitted = options.accountPubkey
      ? await filterEligibleAccountRelayUrls({
          accountPubkey: options.accountPubkey,
          authenticatedPubkey: options.authenticatedPubkey,
          candidateRelayUrls: candidates,
          ownerSelectedRelayUrls: options.ownerSelectedRelayUrls,
          repository: options.accountNetworkLocalStateRepository,
        })
      : [...candidates]
    openedRelayUrls.push(...admitted)
    return {
      events: [],
      relays: admitted.map((relayUrl) => ({
        relayUrl,
        status: "success" as const,
        eventCount: 0,
      })),
      eventsVerified: true,
    }
  }
}

describe("account network read call contract", () => {
  it("carries account policy through relay-list discovery and publish planning", async () => {
    const calls: FetchEventsFanoutOptions[] = []
    __setRelayListTestOverrides({
      loadCached: async () => undefined,
      fetchEventsFanoutDetailed: async (_filter, options = {}) => {
        calls.push(options)
        return {
          events: [],
          relays: (options.relayUrls ?? []).map((relayUrl) => ({
            relayUrl,
            status: "success" as const,
            eventCount: 0,
          })),
          eventsVerified: true,
        }
      },
    })

    await getRelayListsDetailed([ACCOUNT], {
      skipCache: true,
      relayUrls: [RELAY_URL],
      accountPubkey: ACCOUNT,
      authenticatedPubkey: ACCOUNT,
      accountNetworkLocalStateRepository: repository,
    })
    await planPublishRelays({
      intent: "author_event",
      authorPubkey: ACCOUNT,
      authenticatedPubkey: ACCOUNT,
      accountPubkey: ACCOUNT,
      accountNetworkLocalStateRepository: repository,
      refreshRelayLists: true,
    })

    expect(calls.length).toBeGreaterThanOrEqual(2)
    calls.forEach((options) => {
      expectAccountPolicy(options)
      expect(options.authenticatedPubkey).toBe(ACCOUNT)
    })
  })

  it("carries account policy through owner preference and social reads", async () => {
    const relayListCalls: RelayListLookupOptions[] = []
    const finalReadCalls: FetchEventsFanoutOptions[] = []
    const captureRelayLists = async (
      _pubkeys: readonly string[],
      options: RelayListLookupOptions = {}
    ) => {
      relayListCalls.push(options)
      return new Map()
    }
    const captureFinalRead = async (
      _filter: unknown,
      options: FetchEventsFanoutOptions = {}
    ) => {
      finalReadCalls.push(options)
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

    await fetchShopperPresets(ACCOUNT, {
      authenticatedPubkey: ACCOUNT,
      readRelayUrls: [RELAY_URL],
      getRelayLists: captureRelayLists,
      fetchEvents: captureFinalRead,
      accountNetworkLocalStateRepository: repository,
    })
    await readLatestFollowLists(
      { pubkeys: [ACCOUNT], authenticatedPubkey: ACCOUNT },
      {
        resolveRelayListsDetailed: async (_pubkeys, options = {}) => {
          relayListCalls.push(options)
          return {
            relayLists: new Map(),
            resolutionStates: new Map([[ACCOUNT, "lookup-unavailable"]]),
          }
        },
        fetchEvents: captureFinalRead,
        accountNetworkLocalStateRepository: repository,
      }
    )
    await readMediaServerPreferences(ACCOUNT, {
      authenticatedPubkey: ACCOUNT,
      readRelayUrls: [RELAY_URL],
      fetchEvents: captureFinalRead,
      accountNetworkLocalStateRepository: repository,
      storage: null,
    })

    expect(relayListCalls).toHaveLength(2)
    relayListCalls.forEach((options) => {
      expect(options.accountPubkey).toBe(ACCOUNT)
      expect(options.authenticatedPubkey).toBe(ACCOUNT)
      expect(options.accountNetworkLocalStateRepository).toBe(repository)
    })
    expect(finalReadCalls).toHaveLength(3)
    finalReadCalls.forEach((options) => {
      expectAccountPolicy(options)
      expect(options.authenticatedPubkey).toBe(ACCOUNT)
    })
  })

  it("admits no removed relay I/O from owner and social read plans", async () => {
    const openedRelayUrls: string[] = []
    const fetchEvents = finalIoRecorder(openedRelayUrls)

    await fetchShopperPresets(ACCOUNT, {
      authenticatedPubkey: ACCOUNT,
      readRelayUrls: [RELAY_URL],
      getRelayLists: async () => new Map([[ACCOUNT, relayList(ACCOUNT)]]),
      fetchEvents,
      accountNetworkLocalStateRepository: repository,
    })
    await readLatestFollowLists(
      { pubkeys: [ACCOUNT], authenticatedPubkey: ACCOUNT },
      {
        resolveRelayLists: async () => new Map([[ACCOUNT, relayList(ACCOUNT)]]),
        fetchEvents,
        accountNetworkLocalStateRepository: repository,
      }
    )

    expect(openedRelayUrls).not.toContain(RELAY_URL)
  })

  it("admits no removed relay I/O from generic product reads with an explicit account", async () => {
    const openedRelayUrls: string[] = []
    const accountCalls: FetchEventsFanoutOptions[] = []
    let guestDirectPlan: string[] | undefined
    let accountDirectPlan: string[] | undefined
    let variationReadObserved = false
    let deletionReadObserved = false
    let collectingProductDetail = false
    const productDetailCalls: FetchEventsFanoutOptions[] = []
    const merchantPubkey = "b".repeat(64)
    const productDTag = "removed-relay-product"
    const productAddress = `30402:${merchantPubkey}:${productDTag}`
    const variableProduct = {
      id: "c".repeat(64),
      kind: 30402,
      pubkey: merchantPubkey,
      created_at: 100,
      content: "Variable product",
      sig: "d".repeat(128),
      tags: [
        ["d", productDTag],
        ["title", "Variable product"],
        ["price", "1000", "SATS"],
        ["type", "variable", "physical"],
        ["image", "https://cdn.conduit.market/product.png"],
      ],
    }

    __setRelayListTestOverrides({
      loadCached: async (pubkey) => relayList(pubkey),
    })
    __setCommerceTestOverrides({
      accountNetworkLocalStateRepository: repository,
      getCachedProducts: async () => [],
      putCachedProducts: async () => undefined,
      getCachedProductTombstones: async () => [],
      putCachedProductTombstones: async () => undefined,
      fetchEventsFanoutWithDiagnostics: async (filter, options = {}) => {
        const candidates = options.relayUrls ?? []
        const directProductRead = filter["#d"]?.includes(productDTag) === true
        if (options.accountPubkey) {
          accountCalls.push(options)
          if (collectingProductDetail) productDetailCalls.push(options)
          if (directProductRead) accountDirectPlan ??= [...candidates]
          variationReadObserved ||= (filter["#a"]?.length ?? 0) > 0
          deletionReadObserved ||= filter.kinds?.includes(5) === true
        } else if (directProductRead) {
          guestDirectPlan ??= [...candidates]
        }
        const admitted = options.accountPubkey
          ? await filterEligibleAccountRelayUrls({
              accountPubkey: options.accountPubkey,
              authenticatedPubkey: options.authenticatedPubkey,
              candidateRelayUrls: candidates,
              ownerSelectedRelayUrls: options.ownerSelectedRelayUrls,
              repository: options.accountNetworkLocalStateRepository,
            })
          : [...candidates]
        if (options.accountPubkey) openedRelayUrls.push(...admitted)
        const events =
          filter.kinds?.includes(30402) && directProductRead
            ? [variableProduct as never]
            : []
        return {
          events,
          attemptedRelayUrls: admitted,
          successfulRelayUrls: admitted,
          failedRelayUrls: [],
          cappedRelayUrls: [],
        }
      },
    })

    await getProductsByIds([productAddress])
    await getProductsByIds([productAddress], {
      authenticatedPubkey: ACCOUNT,
    })
    collectingProductDetail = true
    await getProductDetail({
      productId: productAddress,
      authenticatedPubkey: ACCOUNT,
    })
    collectingProductDetail = false
    await getMerchantStorefront({
      merchantPubkey,
      accountPubkey: ACCOUNT,
    })
    await getMarketplaceProducts({ accountPubkey: ACCOUNT })

    expect(accountCalls.length).toBeGreaterThanOrEqual(4)
    expect(accountDirectPlan).toEqual(guestDirectPlan)
    expect(accountDirectPlan).toContain(RELAY_URL)
    expect(variationReadObserved).toBe(true)
    expect(deletionReadObserved).toBe(true)
    expect(productDetailCalls.length).toBeGreaterThanOrEqual(3)
    productDetailCalls.forEach((options) => {
      expect(options.authenticatedPubkey).toBe(ACCOUNT)
    })
    accountCalls.forEach(expectAccountPolicy)
    expect(openedRelayUrls).not.toContain(RELAY_URL)
  })

  it("keeps profile discovery public while applying explicit account exclusions at final I/O", async () => {
    const openedRelayUrls: string[] = []
    const merchantPubkey = "b".repeat(64)
    let guestPlan: string[] | undefined
    let accountPlan: string[] | undefined

    __setRelayListTestOverrides({
      loadCached: async (pubkey) => relayList(pubkey),
    })
    __setCommerceTestOverrides({
      accountNetworkLocalStateRepository: repository,
      getCachedProducts: async () => [],
      getCachedProfiles: async () => [undefined],
      putCachedProfiles: async () => undefined,
      fetchEventsFanout: async (_filter, options = {}) => {
        const candidates = options.relayUrls ?? []
        if (options.accountPubkey) {
          accountPlan = [...candidates]
          expectAccountPolicy(options)
        } else {
          guestPlan = [...candidates]
        }
        const admitted = options.accountPubkey
          ? await filterEligibleAccountRelayUrls({
              accountPubkey: options.accountPubkey,
              authenticatedPubkey: options.authenticatedPubkey,
              candidateRelayUrls: candidates,
              ownerSelectedRelayUrls: options.ownerSelectedRelayUrls,
              repository: options.accountNetworkLocalStateRepository,
            })
          : [...candidates]
        if (options.accountPubkey) openedRelayUrls.push(...admitted)
        return []
      },
    })

    await getProfiles({ pubkeys: [merchantPubkey], skipCache: true })
    await getProfiles({
      pubkeys: [merchantPubkey],
      accountPubkey: ACCOUNT,
      skipCache: true,
    })

    expect(accountPlan).toEqual(guestPlan)
    expect(accountPlan).toContain(RELAY_URL)
    expect(openedRelayUrls).not.toContain(RELAY_URL)
  })

  it("admits no removed relay I/O from event-market and shopper-trust reads", async () => {
    const openedRelayUrls: string[] = []
    const fetchEvents = finalIoRecorder(openedRelayUrls)
    const thirdParty = "b".repeat(64)

    __setEventMarketTestOverrides({
      getRelayListsDetailed: async (pubkeys, options = {}) => {
        expectAccountPolicy(options)
        return {
          relayLists: new Map(
            pubkeys.map((pubkey) => [pubkey, relayList(pubkey)])
          ),
          resolutionStates: new Map(
            pubkeys.map((pubkey) => [pubkey, "network" as const])
          ),
        }
      },
      fetchEventsFanoutDetailed: fetchEvents,
      loadCachedEvidence: async () => [],
      persistCachedEvidence: async () => undefined,
    })
    await getOrganizerEventMarketsDetailed({
      organizerPubkey: thirdParty,
      authenticatedPubkey: ACCOUNT,
      accountNetworkLocalStateRepository: repository,
      projection: "discovery",
    })
    await getEventMarket({
      reference: `30405:${thirdParty}:market`,
      authenticatedPubkey: ACCOUNT,
      accountNetworkLocalStateRepository: repository,
    })

    __setEventMarketMerchandiseTestOverrides({
      getRelayLists: async (_pubkeys, options = {}) => {
        expectAccountPolicy(options)
        return new Map([[thirdParty, relayList(thirdParty)]])
      },
      fetchEventsFanoutDetailed: fetchEvents,
    })
    await getEventMarketReceiptMerchandise({
      receipt: {
        merchantPubkey: thirdParty,
        organizerPubkey: ACCOUNT,
        claimRef: "claim",
        items: [],
      } as EventMarketReadyReceiptSchema,
      authenticatedPubkey: ACCOUNT,
      accountNetworkLocalStateRepository: repository,
    })

    await getShopperTrustEvidence(
      { merchantPubkey: ACCOUNT, shopperPubkey: thirdParty },
      {
        cache: null,
        relayUrls: [RELAY_URL],
        authenticatedPubkey: ACCOUNT,
        accountNetworkLocalStateRepository: repository,
        fetchEvents,
      }
    )

    expect(openedRelayUrls).not.toContain(RELAY_URL)
  })

  it("carries account policy through owner inbox discovery", async () => {
    const calls: FetchEventsFanoutOptions[] = []
    await inspectOwnPrivateMessageRelayReadiness(ACCOUNT, {
      relayUrls: [RELAY_URL],
      evidenceRepository: createInMemoryInboxDeclarationEvidenceRepository(),
      accountNetworkLocalStateRepository: repository,
      fetchEventsWithDiagnostics: async (_filter, options = {}) => {
        calls.push(options)
        return {
          events: [],
          attemptedRelayUrls: [...(options.relayUrls ?? [])],
          successfulRelayUrls: [...(options.relayUrls ?? [])],
          failedRelayUrls: [],
        }
      },
    })

    expect(calls).toHaveLength(1)
    expectAccountPolicy(calls[0]!)
  })

  it("carries account policy through every event-market page and boundary read", async () => {
    const calls: FetchEventsFanoutOptions[] = []
    const wrap = new NDKEvent()
    wrap.id = "1".repeat(64)
    wrap.pubkey = "b".repeat(64)
    wrap.kind = 1059
    wrap.created_at = 100
    wrap.tags = [["p", ACCOUNT]]
    wrap.content = "ciphertext"

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      accountNetworkLocalStateRepository: repository,
      getNdk: async () => ({ signer: {} as NDKSigner }) as never,
      resolveInboxRelayUrls: async () => [RELAY_URL],
      fetchEventsFanoutWithDiagnostics: async (filter, options = {}) => {
        calls.push(options)
        if (filter.since === 100 && filter.until === 100) {
          return {
            events: [wrap],
            attemptedRelayUrls: [RELAY_URL],
            successfulRelayUrls: [RELAY_URL],
            failedRelayUrls: [],
            cappedRelayUrls: [],
          }
        }
        if (calls.length === 1) {
          return {
            events: [wrap],
            attemptedRelayUrls: [RELAY_URL],
            successfulRelayUrls: [RELAY_URL],
            failedRelayUrls: [],
            cappedRelayUrls: [RELAY_URL],
          }
        }
        return {
          events: [],
          attemptedRelayUrls: [RELAY_URL],
          successfulRelayUrls: [RELAY_URL],
          failedRelayUrls: [],
          cappedRelayUrls: [],
        }
      },
      giftUnwrap: async () => null,
    })

    await getEventMarketPrivateMessageList(ACCOUNT)

    expect(calls.length).toBeGreaterThanOrEqual(3)
    calls.forEach(expectAccountPolicy)
  })
})
