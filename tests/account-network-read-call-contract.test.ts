import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"

import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getEventMarketPrivateMessageList,
} from "../packages/core/src/protocol/commerce"
import {
  emptyAccountNetworkLocalState,
  type AccountNetworkLocalStateRepository,
} from "../packages/core/src/protocol/account-network-local-state"
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
  __resetInboxRelayCache()
  __resetRelayListTestOverrides()
})

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
    calls.forEach(expectAccountPolicy)
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
      readRelayUrls: [RELAY_URL],
      fetchEvents: captureFinalRead,
      accountNetworkLocalStateRepository: repository,
      storage: null,
    })

    expect(relayListCalls).toHaveLength(2)
    relayListCalls.forEach((options) => {
      expect(options.accountPubkey).toBe(ACCOUNT)
      expect(options.accountNetworkLocalStateRepository).toBe(repository)
    })
    expect(finalReadCalls).toHaveLength(3)
    finalReadCalls.forEach(expectAccountPolicy)
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
