import { afterEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"

import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getMarketplaceProducts,
  getMarketplaceProductsProgressive,
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
  getEventMarketReadPlan,
} from "../packages/core/src/protocol/event-market"
import {
  discoverFutureEventMarkets,
  readEventMarketRoster,
} from "../packages/core/src/protocol/event-market-roster-read"
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
import type { PublicRelayReadOptions } from "../packages/core/src/protocol/relay-reader"
import {
  __resetRelayListTestOverrides,
  __setRelayListTestOverrides,
  getRelayListsDetailed,
  type RelayListLookupOptions,
} from "../packages/core/src/protocol/relay-list"
import { planPublishRelays } from "../packages/core/src/protocol/relay-publish"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import { visitProtectedInboxHistoryPage } from "../packages/core/src/protocol/protected-inbox-history"
import { readProtectedInbox } from "../packages/core/src/protocol/protected-inbox-read"
import type { SignedNostrEvent } from "../packages/core/src/protocol/nostr-event-signer"
import type { CommerceRelayExecutor } from "../packages/core/src/protocol/relay-executor"
import { fetchShopperPresets } from "../packages/core/src/protocol/shopper-presets"
import { getShopperTrustEvidence } from "../packages/core/src/protocol/shopper-trust"
import { futureMarketReadyReceiptSchema } from "../packages/core/src/schemas"

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
    PublicRelayReadOptions,
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
  __resetProtectedReadSigner()
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
  return async (_filter: unknown, options: PublicRelayReadOptions = {}) => {
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
    const calls: PublicRelayReadOptions[] = []
    const shouldContinue = () => true
    __setRelayListTestOverrides({
      loadCached: async () => undefined,
      fetchSignedEventsFanoutDetailed: async (_filter, options = {}) => {
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
      shouldContinue,
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
    expect(calls[0]?.shouldContinue).toBe(shouldContinue)
    calls.forEach((options) => {
      expectAccountPolicy(options)
      expect(options.authenticatedPubkey).toBe(ACCOUNT)
    })
  })

  it("carries account policy through owner preference and social reads", async () => {
    const relayListCalls: RelayListLookupOptions[] = []
    const finalReadCalls: PublicRelayReadOptions[] = []
    const captureRelayLists = async (
      _pubkeys: readonly string[],
      options: RelayListLookupOptions = {}
    ) => {
      relayListCalls.push(options)
      return new Map()
    }
    const captureFinalRead = async (
      _filter: unknown,
      options: PublicRelayReadOptions = {}
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
    const accountCalls: PublicRelayReadOptions[] = []
    let guestDirectPlan: string[] | undefined
    let accountDirectPlan: string[] | undefined
    let variationReadObserved = false
    let deletionReadObserved = false
    let collectingProductDetail = false
    const productDetailCalls: PublicRelayReadOptions[] = []
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
      fetchPublicEventsWithDiagnostics: async (filter, options = {}) => {
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
    const shouldContinue = () => true
    await getProductsByIds([productAddress], {
      authenticatedPubkey: ACCOUNT,
      shouldContinue,
    })
    const exactAccountCalls = [...accountCalls]
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
    expect(exactAccountCalls.length).toBeGreaterThan(0)
    exactAccountCalls.forEach((options) => {
      expect(options.shouldContinue).toBe(shouldContinue)
    })
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
      fetchPublicEvents: async (_filter, options = {}) => {
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

    let active = true
    const shouldContinue = () => active
    const controller = new AbortController()
    const currentReadCalls: PublicRelayReadOptions[] = []
    __setEventMarketTestOverrides({
      getRelayListsDetailed: async (pubkeys, options = {}) => {
        expectAccountPolicy(options)
        expect(options.authenticatedPubkey).toBe(ACCOUNT)
        expect(options.shouldContinue).toBe(shouldContinue)
        return {
          relayLists: new Map(
            pubkeys.map((pubkey) => [pubkey, relayList(pubkey)])
          ),
          resolutionStates: new Map(
            pubkeys.map((pubkey) => [pubkey, "network" as const])
          ),
        }
      },
    })
    const dependencies: NonNullable<
      Parameters<typeof discoverFutureEventMarkets>[1]
    > = {
      plan: (input) =>
        getEventMarketReadPlan({
          ...input,
          accountNetworkLocalStateRepository: repository,
        }),
      load: async () => [],
      retain: async () => undefined,
      fetch: async (filter, options = {}) => {
        // The dependency seam injects the final transport policy repository;
        // the current reader supplies the actual account and live view scope.
        expect(options.accountPubkey).toBe(ACCOUNT)
        expect(options.authenticatedPubkey).toBe(ACCOUNT)
        expect(options.shouldContinue).toBe(shouldContinue)
        expect(options.signal).toBe(controller.signal)
        expect(filter.authors).toEqual([thirdParty])
        currentReadCalls.push(options)
        return fetchEvents(filter, {
          ...options,
          accountNetworkLocalStateRepository: repository,
        })
      },
    }
    const currentInput = {
      authenticatedPubkey: ACCOUNT,
      shouldContinue,
      signal: controller.signal,
    }
    await discoverFutureEventMarkets(
      { ...currentInput, organizerPubkeys: [thirdParty] },
      dependencies
    )
    await readEventMarketRoster(
      { ...currentInput, reference: `30409:${thirdParty}:market` },
      dependencies
    )
    expect(currentReadCalls.length).toBeGreaterThanOrEqual(3)
    active = false
    currentReadCalls.forEach((options) =>
      expect(options.shouldContinue?.()).toBe(false)
    )
    const callsBeforeCancellation = currentReadCalls.length
    await expect(
      discoverFutureEventMarkets(
        { ...currentInput, organizerPubkeys: [thirdParty] },
        dependencies
      )
    ).rejects.toThrow("cancelled")
    expect(currentReadCalls).toHaveLength(callsBeforeCancellation)

    __setEventMarketMerchandiseTestOverrides({
      getRelayLists: async (_pubkeys, options = {}) => {
        expectAccountPolicy(options)
        return new Map([[thirdParty, relayList(thirdParty)]])
      },
      fetchSignedEventsFanoutDetailed: fetchEvents,
    })
    await getEventMarketReceiptMerchandise({
      receipt: futureMarketReadyReceiptSchema.parse({
        version: 2,
        type: "future_market_ready",
        releaseAuthorized: true,
        merchantPubkey: thirdParty,
        organizerPubkey: ACCOUNT,
        claimRef: "c".repeat(64),
        market: {
          coordinate: `30409:${ACCOUNT}:market`,
          eventId: "d".repeat(64),
          createdAt: 100_000,
        },
        calendar: {
          coordinate: `31923:${ACCOUNT}:day`,
          eventId: "e".repeat(64),
          createdAt: 100_000,
        },
        grant: { eventId: "f".repeat(64), createdAt: 99_000 },
        items: [
          {
            product: {
              coordinate: `30402:${thirdParty}:coffee`,
              eventId: "1".repeat(64),
              createdAt: 101_000,
            },
            quantity: 1,
          },
        ],
        issuedAt: 102,
      }),
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
    const calls: PublicRelayReadOptions[] = []
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

  it("carries live account authority through progressive commerce fanout", async () => {
    const calls: PublicRelayReadOptions[] = []
    const shouldContinue = () => true
    __setCommerceTestOverrides({
      accountNetworkLocalStateRepository: repository,
      getCachedProducts: async () => [],
      putCachedProducts: async () => undefined,
      getCachedProductTombstones: async () => [],
      putCachedProductTombstones: async () => undefined,
      fetchPublicEventsProgressive: async (_filter, options = {}) => {
        calls.push(options)
        return []
      },
    })

    await getMarketplaceProductsProgressive(
      {
        authenticatedPubkey: ACCOUNT,
        accountPubkey: ACCOUNT,
        shouldContinue,
      },
      () => undefined
    )

    expect(calls.length).toBeGreaterThan(0)
    calls.forEach((options) => {
      expectAccountPolicy(options)
      expect(options.authenticatedPubkey).toBe(ACCOUNT)
      expect(options.shouldContinue).toBe(shouldContinue)
    })
  })

  it("checks account relay admission on each history page and timestamp boundary", async () => {
    const secret = generateSecretKey()
    const wraps: SignedNostrEvent[] = Array.from({ length: 50 }, (_, index) =>
      finalizeEvent(
        {
          kind: 1_059,
          created_at: 100 + index,
          tags: [["p", ACCOUNT]],
          content: `synthetic-wrap-${index}`,
        },
        secret
      )
    )
    const signer = {
      authMethod: "nip07" as const,
      getPublicKey: async () => ACCOUNT,
      signEvent: async () => {
        throw new Error("unused signer")
      },
    }
    installProtectedReadSigner(signer, ACCOUNT, () => true)
    const authorization = getProtectedReadAuthorization(ACCOUNT)
    if (!authorization) throw new Error("Expected protected authorization")
    let excluded = false
    const policy: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) =>
        excluded
          ? {
              ...emptyAccountNetworkLocalState(pubkey),
              exclusions: [
                {
                  relayUrl: RELAY_URL,
                  committedAt: 1,
                  relayListFrontier: { eventId: null, createdAt: null },
                  inboxDeclarationFrontier: { eventId: null, createdAt: null },
                },
              ],
            }
          : undefined,
    }
    const opened: Array<{ since?: number; until?: number; limit?: number }> = []
    const executor: CommerceRelayExecutor = {
      req: async function* () {},
      query: async (request) => {
        const filter = request.filters[0]!
        opened.push({
          since: filter.since,
          until: filter.until,
          limit: filter.limit,
        })
        const events = wraps
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at >= filter.since) &&
              (filter.until === undefined || event.created_at <= filter.until)
          )
          .sort((left, right) => right.created_at - left.created_at)
          .slice(0, filter.limit)
        return {
          status: "success",
          events,
          observations: [{ type: "eose", relayIndex: 0 }],
          relays: [
            {
              relayIndex: 0,
              status: "success",
              auth: "not_challenged",
              eventCount: events.length,
              duplicateCount: 0,
              malformedCount: 0,
              unusableCount: 0,
            },
          ],
          attemptedCount: 1,
          completedCount: 1,
          failedCount: 0,
          authoritativeEmpty: events.length === 0,
        }
      },
    }
    const read = (options: Parameters<typeof readProtectedInbox>[0]) =>
      readProtectedInbox({ ...options, executor })
    const visits: string[] = []
    const options = {
      principalPubkey: ACCOUNT,
      relayUrl: RELAY_URL,
      declaredRelayUrls: [RELAY_URL],
      authorization,
      accountNetworkLocalStateRepository: policy,
      read,
      visit: async (event: SignedNostrEvent, assertCurrent: () => void) => {
        assertCurrent()
        visits.push(event.id)
      },
    }

    const first = await visitProtectedInboxHistoryPage(options)
    expect(first.status).toBe("advanced")
    expect(first.visitedCount).toBe(50)
    expect(first.nextCursor?.until).toBe(99)
    expect(opened).toEqual([
      { since: undefined, until: undefined, limit: 50 },
      { since: 100, until: 100, limit: 512 },
    ])
    expect(new Set(visits).size).toBe(50)

    excluded = true
    const denied = await visitProtectedInboxHistoryPage({
      ...options,
      cursor: first.nextCursor!,
    })
    expect(denied.status).toBe("unavailable")
    expect(denied.nextCursor).toEqual(first.nextCursor)
    expect(opened).toHaveLength(2)

    excluded = false
    const older = await visitProtectedInboxHistoryPage({
      ...options,
      cursor: first.nextCursor!,
    })
    expect(older.status).toBe("source_eose")
    expect(older.range).toMatchObject({
      relayUrl: RELAY_URL,
      until: 99,
      eose: true,
      observedCount: 0,
    })
    expect(opened).toHaveLength(3)

    installProtectedReadSigner(signer, ACCOUNT, () => true)
    await expect(
      visitProtectedInboxHistoryPage({ ...options, cursor: first.nextCursor! })
    ).rejects.toThrow("authority is unavailable")
    expect(opened).toHaveLength(3)

    const currentAuthorization = getProtectedReadAuthorization(ACCOUNT)
    if (!currentAuthorization)
      throw new Error("Expected replacement authorization")
    const boundaryRevokeRead = async (
      readOptions: Parameters<typeof readProtectedInbox>[0]
    ) => {
      const response = await read(readOptions)
      if (readOptions.since === 100 && readOptions.until === 100) {
        installProtectedReadSigner(signer, ACCOUNT, () => true)
      }
      return response
    }
    await expect(
      visitProtectedInboxHistoryPage({
        ...options,
        authorization: currentAuthorization,
        read: boundaryRevokeRead,
      })
    ).rejects.toThrow("authority is unavailable")
    expect(opened).toHaveLength(5)
    expect(visits).toHaveLength(50)
  })
})
