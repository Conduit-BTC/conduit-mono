import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetInboxRelayCache,
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  applyE2eRelayIsolation,
  buildFutureMarketPrivateRumor,
  config,
  EVENT_KINDS,
  futureMarketReadyReceiptSchema,
  futureMarketRevocationSchema,
  getEventMarketPrivateMessageList,
  reduceFutureMarketOrganizerClaims,
  resolveEventMarketOrganizerInbox,
  type FutureMarketReadyReceiptSchema,
} from "@conduit/core"
import type { SignedPublicNostrEvent } from "@conduit/core/protocol/signed-event"
import {
  __resetProtectedReadSigner,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type { NostrEventSigner } from "../packages/core/src/protocol/nostr-event-signer"
const ORGANIZER_SECRET = generateSecretKey()
const MERCHANT_SECRET = generateSecretKey()
const WRAP_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const MARKET = `30409:${ORGANIZER}:market`
const CALENDAR = `31923:${ORGANIZER}:market-day`
const ISSUED_AT = 1_700_000_100
const originalConfig = structuredClone(config)
afterEach(() => {
  Object.assign(config, structuredClone(originalConfig))
  __resetInboxRelayCache()
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
})
function protectedReadSigner(secret: Uint8Array): NostrEventSigner {
  const pubkey = getPublicKey(secret)
  return {
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, secret),
  }
}
function readyPayload(
  overrides: Partial<FutureMarketReadyReceiptSchema> = {}
): FutureMarketReadyReceiptSchema {
  return futureMarketReadyReceiptSchema.parse({
    version: 2,
    type: "future_market_ready",
    releaseAuthorized: true,
    claimRef: "a".repeat(64),
    merchantPubkey: MERCHANT,
    organizerPubkey: ORGANIZER,
    market: { coordinate: MARKET, eventId: "b".repeat(64), createdAt: 100_000 },
    calendar: {
      coordinate: CALENDAR,
      eventId: "c".repeat(64),
      createdAt: 100_000,
    },
    grant: { eventId: "d".repeat(64), createdAt: 99_000 },
    items: [
      {
        product: {
          coordinate: `30402:${MERCHANT}:coffee`,
          eventId: "e".repeat(64),
          createdAt: 101_000,
        },
        quantity: 1,
      },
    ],
    issuedAt: ISSUED_AT,
    ...overrides,
  })
}
function revocationPayload(readyReceiptId: string) {
  const receipt = readyPayload()
  return futureMarketRevocationSchema.parse({
    version: 2,
    type: "future_market_revoked",
    claimRef: receipt.claimRef,
    merchantPubkey: MERCHANT,
    organizerPubkey: ORGANIZER,
    market: receipt.market,
    calendar: receipt.calendar,
    grant: receipt.grant,
    readyReceiptId,
    issuedAt: ISSUED_AT + 1,
  })
}
function signedWrap(
  recipientPubkey: string,
  nonce?: number,
  createdAt = ISSUED_AT
): NDKEvent {
  const raw = finalizeEvent(
    {
      kind: EVENT_KINDS.GIFT_WRAP,
      created_at: createdAt,
      tags: [["p", recipientPubkey]],
      content: `ciphertext-${recipientPubkey}-${nonce ?? ""}`,
    },
    WRAP_SECRET
  ) as SignedPublicNostrEvent
  return new NDKEvent(undefined, raw)
}
const organizerSigner = {
  user: async () => ({ pubkey: ORGANIZER }),
} as unknown as NDKSigner
// Compose the actual shared encrypted inbox scan with the current claim reducer.
async function readCurrentClaims(input: {
  organizerPubkey: string
  marketCoordinate: string
}) {
  const read = await getEventMarketPrivateMessageList(input.organizerPubkey)
  return {
    ...read,
    data: reduceFutureMarketOrganizerClaims({
      ...input,
      messages: read.messages,
    }),
  }
}
describe("current Event Market private inbox authority and bounded scanning", () => {
  it("accepts only the exact configured E2E loopback declaration", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const otherLoopbackRelayUrl = "ws://127.0.0.1:7788"
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
    const declaration = (relayUrl: string, createdAt: number) =>
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
          created_at: createdAt,
          tags: [["relay", relayUrl]],
          content: "",
        },
        ORGANIZER_SECRET
      )
    const resolve = (relayUrl: string, createdAt: number) =>
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: [isolatedRelayUrl],
        now: () => createdAt * 1_000,
        fetchEventsWithDiagnostics: async () => ({
          events: [new NDKEvent(undefined, declaration(relayUrl, createdAt))],
          attemptedRelayUrls: [isolatedRelayUrl],
          successfulRelayUrls: [isolatedRelayUrl],
          failedRelayUrls: [],
        }),
      })

    await expect(resolve(isolatedRelayUrl, ISSUED_AT)).resolves.toEqual({
      state: "ready",
      organizerPubkey: ORGANIZER,
      relayUrls: [isolatedRelayUrl],
    })

    __resetInboxRelayCache()
    await expect(
      resolve(otherLoopbackRelayUrl, ISSUED_AT + 1)
    ).resolves.toMatchObject({ state: "blocked", reason: "malformed" })
  })

  it("requires a current secure organizer kind-10050 declaration", async () => {
    __resetInboxRelayCache()
    const declaration = finalizeEvent(
      {
        kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
        created_at: ISSUED_AT,
        tags: [["relay", "wss://organizer.inbox.relay.dev"]],
        content: "",
      },
      ORGANIZER_SECRET
    )
    await expect(
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: ["wss://discovery.relay.dev"],
        now: () => ISSUED_AT * 1_000,
        fetchEventsWithDiagnostics: async () => ({
          events: [new NDKEvent(undefined, declaration)],
          attemptedRelayUrls: ["wss://discovery.relay.dev"],
          successfulRelayUrls: ["wss://discovery.relay.dev"],
          failedRelayUrls: [],
        }),
      })
    ).resolves.toEqual({
      state: "ready",
      organizerPubkey: ORGANIZER,
      relayUrls: ["wss://organizer.inbox.relay.dev"],
    })

    expect(
      await resolveEventMarketOrganizerInbox("not-a-pubkey")
    ).toMatchObject({ state: "blocked", reason: "invalid_organizer" })

    __resetInboxRelayCache()
    await expect(
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: ["wss://discovery.relay.dev"],
        fetchEventsWithDiagnostics: async () => ({
          events: [],
          attemptedRelayUrls: ["wss://discovery.relay.dev"],
          successfulRelayUrls: ["wss://discovery.relay.dev"],
          failedRelayUrls: [],
        }),
      })
    ).resolves.toMatchObject({ state: "blocked", reason: "not_observed" })
  })

  it("reads handoff wraps from declared kind-10050 relays only", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const compatibilityRelay = "wss://compatibility.relay.dev"
    const wrap = signedWrap(ORGANIZER)
    const seenPlans: string[][] = []
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (_filter, options) => {
        const relays = [...(options?.relayUrls ?? [])]
        seenPlans.push(relays)
        return relays.includes(compatibilityRelay) ? [wrap] : []
      },
      giftUnwrap: async () => buildFutureMarketPrivateRumor(readyPayload()),
    })

    expect(
      (await getEventMarketPrivateMessageList(ORGANIZER)).messages
    ).toEqual([])
    expect(seenPlans).toEqual([[declaredRelay]])

    __setCommerceTestOverrides({
      fetchEventsFanout: async (_filter, options) => {
        const relays = [...(options?.relayUrls ?? [])]
        seenPlans.push(relays)
        return relays.includes(declaredRelay) ? [wrap] : []
      },
    })
    expect(
      (await getEventMarketPrivateMessageList(ORGANIZER)).messages.map(
        (message) => message.type
      )
    ).toEqual(["future_market_ready"])
    expect(seenPlans.at(-1)).toEqual([declaredRelay])
  })

  it("reads handoff wraps only from the exact configured E2E loopback", async () => {
    const isolatedRelayUrl = "ws://127.0.0.1:7777"
    const otherLoopbackRelayUrl = "ws://127.0.0.1:7788"
    Object.assign(config, applyE2eRelayIsolation(config, [isolatedRelayUrl]))
    const wrap = signedWrap(ORGANIZER)
    const seenPlans: string[][] = []
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [
        otherLoopbackRelayUrl,
        isolatedRelayUrl,
      ],
      fetchEventsFanout: async (_filter, options) => {
        const relays = [...(options?.relayUrls ?? [])]
        seenPlans.push(relays)
        return relays.includes(isolatedRelayUrl) ? [wrap] : []
      },
      giftUnwrap: async () => buildFutureMarketPrivateRumor(readyPayload()),
    })

    const exact = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(exact.messages.map((message) => message.type)).toEqual([
      "future_market_ready",
    ])
    expect(exact.inbox).toMatchObject({
      declarationState: "declared",
      coverage: "complete",
      readSource: "declared",
    })
    expect(seenPlans).toEqual([[isolatedRelayUrl]])

    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [otherLoopbackRelayUrl],
    })
    const rejected = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(rejected.messages).toEqual([])
    expect(rejected.inbox).toMatchObject({
      declarationState: "not_observed",
      coverage: "unavailable",
      readSource: "declared",
    })
    expect(seenPlans).toHaveLength(1)
  })

  it("coalesces concurrent bounded inbox reads before fetch and decrypt", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildFutureMarketPrivateRumor(readyPayload())
    const readyWrap = signedWrap(ORGANIZER)
    let declarationCount = 0
    let fetchCount = 0
    let unwrapCount = 0
    let releaseDeclarations!: () => void
    const declarationsReady = new Promise<void>((resolve) => {
      releaseDeclarations = resolve
    })

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => {
        declarationCount += 1
        if (declarationCount === 2) releaseDeclarations()
        return [declaredRelay]
      },
      fetchEventsFanout: async () => {
        fetchCount += 1
        await declarationsReady
        return [readyWrap]
      },
      giftUnwrap: async () => {
        unwrapCount += 1
        return readyRumor
      },
    })

    const [first, second] = await Promise.all([
      getEventMarketPrivateMessageList(ORGANIZER),
      getEventMarketPrivateMessageList(ORGANIZER),
    ])

    expect(declarationCount).toBe(2)
    expect(fetchCount).toBe(1)
    expect(unwrapCount).toBe(1)
    expect(first.messages.map((message) => message.id)).toEqual(
      second.messages.map((message) => message.id)
    )
    expect(first.inbox?.coverage).toBe("complete")
  })

  it("rejects an in-flight scan after same-account signer session replacement", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const firstRumor = buildFutureMarketPrivateRumor(readyPayload())
    const secondRumor = buildFutureMarketPrivateRumor(
      readyPayload({ issuedAt: ISSUED_AT + 1 })
    )
    const firstWrap = signedWrap(ORGANIZER, 501, ISSUED_AT + 1)
    const secondWrap = signedWrap(ORGANIZER, 502, ISSUED_AT + 2)
    let fetchCount = 0
    let releaseFirstFetch!: () => void
    let markFirstFetchStarted!: () => void
    const firstFetchGate = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve
    })
    const firstFetchStarted = new Promise<void>((resolve) => {
      markFirstFetchStarted = resolve
    })
    const unwrappedIds: string[] = []

    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanoutWithDiagnostics: async (_filter, options) => {
        fetchCount += 1
        const isFirst = fetchCount === 1
        if (isFirst) {
          markFirstFetchStarted()
          await firstFetchGate
        }
        return {
          events: [isFirst ? firstWrap : secondWrap],
          attemptedRelayUrls: [...(options?.relayUrls ?? [])],
          successfulRelayUrls: [...(options?.relayUrls ?? [])],
          failedRelayUrls: [],
          cappedRelayUrls: [],
        }
      },
      giftUnwrap: async (event) => {
        unwrappedIds.push(event.id)
        return event.id === firstWrap.id ? firstRumor : secondRumor
      },
    })

    installProtectedReadSigner(
      protectedReadSigner(ORGANIZER_SECRET),
      ORGANIZER,
      () => true
    )
    const staleSessionRead = getEventMarketPrivateMessageList(ORGANIZER)
    await firstFetchStarted

    installProtectedReadSigner(
      protectedReadSigner(ORGANIZER_SECRET),
      ORGANIZER,
      () => true
    )
    const currentSessionRead = await getEventMarketPrivateMessageList(ORGANIZER)
    releaseFirstFetch()

    await expect(staleSessionRead).rejects.toThrow(
      "Protected-read authority changed during inbox synchronization"
    )
    expect(currentSessionRead.messages.map((message) => message.id)).toEqual([
      secondRumor.id,
    ])
    expect(currentSessionRead.inbox?.coverage).toBe("complete")
    expect(unwrappedIds).toEqual([secondWrap.id])
  })

  it("does not carry partial decrypted evidence into a replacement signer session", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const firstRumor = buildFutureMarketPrivateRumor(readyPayload())
    const secondRumor = buildFutureMarketPrivateRumor(
      readyPayload({ issuedAt: ISSUED_AT + 1 })
    )
    const firstWrap = signedWrap(ORGANIZER, 601, ISSUED_AT + 1)
    const secondWrap = signedWrap(ORGANIZER, 602, ISSUED_AT + 2)
    let currentWrap = firstWrap
    let firstSession = true

    __setCommerceTestOverrides({
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanoutWithDiagnostics: async (_filter, options) => ({
        events: [currentWrap],
        attemptedRelayUrls: [...(options?.relayUrls ?? [])],
        successfulRelayUrls: [...(options?.relayUrls ?? [])],
        failedRelayUrls: firstSession ? [...(options?.relayUrls ?? [])] : [],
        cappedRelayUrls: [],
      }),
      giftUnwrap: async (event) =>
        event.id === firstWrap.id ? firstRumor : secondRumor,
    })

    installProtectedReadSigner(
      protectedReadSigner(ORGANIZER_SECRET),
      ORGANIZER,
      () => true
    )
    const partial = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(partial.messages.map((message) => message.id)).toEqual([
      firstRumor.id,
    ])
    expect(partial.inbox?.coverage).toBe("partial")

    firstSession = false
    currentWrap = secondWrap
    installProtectedReadSigner(
      protectedReadSigner(ORGANIZER_SECRET),
      ORGANIZER,
      () => true
    )
    const replacement = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(replacement.messages.map((message) => message.id)).toEqual([
      secondRumor.id,
    ])
    expect(replacement.inbox?.coverage).toBe("complete")
  })

  it("rejects an in-flight read after the declared relay plan changes", async () => {
    const oldRelay = "wss://organizer.old-inbox.relay.dev"
    const newRelay = "wss://organizer.new-inbox.relay.dev"
    const oldRumor = buildFutureMarketPrivateRumor(readyPayload())
    const newRumor = buildFutureMarketPrivateRumor(
      readyPayload({ issuedAt: ISSUED_AT + 1 })
    )
    const oldWrap = signedWrap(ORGANIZER, 701, ISSUED_AT + 1)
    const newWrap = signedWrap(ORGANIZER, 702, ISSUED_AT + 2)
    let declaredRelay = oldRelay
    let releaseOldRelay!: () => void
    let markOldRelayStarted!: () => void
    const oldRelayGate = new Promise<void>((resolve) => {
      releaseOldRelay = resolve
    })
    const oldRelayStarted = new Promise<void>((resolve) => {
      markOldRelayStarted = resolve
    })

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (_filter, options) => {
        if (options?.relayUrls?.[0] === oldRelay) {
          markOldRelayStarted()
          await oldRelayGate
          return [oldWrap]
        }
        return [newWrap]
      },
      giftUnwrap: async (event) =>
        event.id === oldWrap.id ? oldRumor : newRumor,
    })

    const superseded = getEventMarketPrivateMessageList(ORGANIZER)
    await oldRelayStarted
    declaredRelay = newRelay
    const current = await getEventMarketPrivateMessageList(ORGANIZER)
    releaseOldRelay()

    await expect(superseded).rejects.toThrow(
      "Event-market inbox relay plan changed during synchronization"
    )
    expect(current.messages.map((message) => message.id)).toEqual([newRumor.id])
    expect(current.inbox?.coverage).toBe("complete")
  })

  it("discovers paginated receipt evidence without certifying a multi-request scan", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildFutureMarketPrivateRumor(readyPayload())
    const revocationRumor = buildFutureMarketPrivateRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const relayEvents = Array.from({ length: 400 }, (_, index) =>
      signedWrap(ORGANIZER, index, ISSUED_AT + 100)
    )
    const readyWrap = signedWrap(ORGANIZER, 400, ISSUED_AT)
    const revocationWrap = signedWrap(ORGANIZER, 401, ISSUED_AT)
    relayEvents.push(readyWrap, revocationWrap)
    const requestedFilters: Array<{
      limit?: number
      since?: number
      until?: number
    }> = []

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) => {
        requestedFilters.push({
          limit: filter.limit,
          since: filter.since,
          until: filter.until,
        })
        return relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length)
      },
      giftUnwrap: async (event) =>
        event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor,
    })

    const read = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })

    expect(requestedFilters).toEqual([
      { limit: 400, since: undefined, until: undefined },
      { limit: 512, since: ISSUED_AT + 100, until: ISSUED_AT + 100 },
      { limit: 400, since: undefined, until: ISSUED_AT + 99 },
    ])
    expect(read.data).toHaveLength(1)
    expect(read.data[0]?.state).toBe("revoked")
    expect(read.inbox?.coverage).toBe("partial")
  })

  it("keeps coverage partial when a backdated revocation arrives after the first page", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildFutureMarketPrivateRumor(readyPayload())
    const revocationRumor = buildFutureMarketPrivateRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const relayEvents = Array.from({ length: 399 }, (_, index) => {
      const event = new NDKEvent()
      event.id = (30_000 + index).toString(16).padStart(64, "0")
      event.kind = EVENT_KINDS.GIFT_WRAP
      event.created_at = ISSUED_AT + 1_000 - index
      event.pubkey = MERCHANT
      event.tags = [["p", ORGANIZER]]
      event.content = "ciphertext"
      return event
    })
    const readyWrap = signedWrap(ORGANIZER, 30_500, ISSUED_AT + 900)
    const revocationWrap = signedWrap(ORGANIZER, 30_501, ISSUED_AT + 800)
    relayEvents.push(readyWrap)
    let firstPrimary = true
    const unwrappedIds: string[] = []

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) => {
        const page = relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length)
        if (filter.limit === 400 && firstPrimary) {
          firstPrimary = false
          relayEvents.push(revocationWrap)
        }
        return page
      },
      giftUnwrap: async (event) => {
        unwrappedIds.push(event.id)
        return event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor
      },
    })

    const read = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(unwrappedIds).toContain(readyWrap.id)
    expect(unwrappedIds).not.toContain(revocationWrap.id)
    expect(read.data[0]?.state).toBe("ready_for_pickup")
    expect(read.inbox?.coverage).toBe("partial")
  })

  it("discovers evidence past 3,200 wraps but keeps stitched coverage partial", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildFutureMarketPrivateRumor(readyPayload())
    const revocationRumor = buildFutureMarketPrivateRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const unrelatedWraps = Array.from({ length: 3_200 }, (_, index) => {
      const event = new NDKEvent()
      event.id = (index + 1).toString(16).padStart(64, "0")
      event.kind = EVENT_KINDS.GIFT_WRAP
      event.created_at = ISSUED_AT + 4_000 - index
      event.pubkey = MERCHANT
      event.tags = [["p", ORGANIZER]]
      event.content = "ciphertext"
      return event
    })
    const readyWrap = signedWrap(ORGANIZER, 3_201, ISSUED_AT)
    const revocationWrap = signedWrap(ORGANIZER, 3_202, ISSUED_AT)
    const relayEvents = [...unrelatedWraps, readyWrap, revocationWrap]
    const unwrapCounts = new Map<string, number>()
    let primaryPageCount = 0

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) => {
        if (filter.limit === 400) primaryPageCount += 1
        return relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length)
      },
      giftUnwrap: async (event) => {
        unwrapCounts.set(event.id, (unwrapCounts.get(event.id) ?? 0) + 1)
        return event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor
      },
    })

    const partial = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(primaryPageCount).toBe(8)
    expect(unwrapCounts.size).toBe(3_200)
    expect(partial.data).toEqual([])
    expect(partial.inbox?.coverage).toBe("partial")

    const continued = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(primaryPageCount).toBe(9)
    expect(unwrapCounts.size).toBe(3_202)
    expect(Math.max(...unwrapCounts.values())).toBe(1)
    expect(continued.data).toHaveLength(1)
    expect(continued.data[0]?.state).toBe("revoked")
    expect(continued.inbox?.coverage).toBe("partial")
  })

  it("restarts fresh to discover a late backdated revocation without certifying the stitched gap", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildFutureMarketPrivateRumor(readyPayload())
    const revocationRumor = buildFutureMarketPrivateRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const relayEvents = Array.from({ length: 3_200 }, (_, index) => {
      const event = new NDKEvent()
      event.id = (10_000 + index).toString(16).padStart(64, "0")
      event.kind = EVENT_KINDS.GIFT_WRAP
      event.created_at = ISSUED_AT + 4_000 - index
      event.pubkey = MERCHANT
      event.tags = [["p", ORGANIZER]]
      event.content = "ciphertext"
      return event
    })
    const readyWrap = signedWrap(ORGANIZER, 7_201, ISSUED_AT + 3_900)
    const revocationWrap = signedWrap(ORGANIZER, 7_202, ISSUED_AT + 2_000)
    relayEvents.push(readyWrap)
    const unwrapCounts = new Map<string, number>()

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) =>
        relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length),
      giftUnwrap: async (event) => {
        unwrapCounts.set(event.id, (unwrapCounts.get(event.id) ?? 0) + 1)
        return event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor
      },
    })

    const initial = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(initial.data[0]?.state).toBe("ready_for_pickup")
    expect(initial.inbox?.coverage).toBe("partial")

    relayEvents.push(revocationWrap)
    const stitched = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(unwrapCounts.get(revocationWrap.id)).toBeUndefined()
    expect(stitched.data[0]?.state).toBe("ready_for_pickup")
    expect(stitched.inbox?.coverage).toBe("partial")

    const revalidated = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(unwrapCounts.get(revocationWrap.id)).toBe(1)
    expect(revalidated.data[0]?.state).toBe("revoked")
    expect(revalidated.inbox?.coverage).toBe("partial")
  })

  it("revalidates a relay that reached EOSE while another relay continues", async () => {
    const shortRelay = "wss://organizer.short-inbox.relay.dev"
    const longRelay = "wss://organizer.long-inbox.relay.dev"
    const readyRumor = buildFutureMarketPrivateRumor(readyPayload())
    const revocationRumor = buildFutureMarketPrivateRumor(
      revocationPayload(readyRumor.id)
    )
    const unrelatedRumor = new NDKEvent()
    unrelatedRumor.kind = 1
    unrelatedRumor.pubkey = MERCHANT
    unrelatedRumor.created_at = ISSUED_AT
    unrelatedRumor.tags = [["p", ORGANIZER]]
    unrelatedRumor.content = ""
    const readyWrap = signedWrap(ORGANIZER, 8_001, ISSUED_AT + 1)
    const revocationWrap = signedWrap(ORGANIZER, 8_002, ISSUED_AT)
    const shortRelayEvents = [readyWrap]
    const longRelayEvents = Array.from({ length: 3_200 }, (_, index) => {
      const event = new NDKEvent()
      event.id = (20_000 + index).toString(16).padStart(64, "0")
      event.kind = EVENT_KINDS.GIFT_WRAP
      event.created_at = ISSUED_AT + 4_000 - index
      event.pubkey = MERCHANT
      event.tags = [["p", ORGANIZER]]
      event.content = "ciphertext"
      return event
    })
    let shortRelayPrimaryReads = 0

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [shortRelay, longRelay],
      fetchEventsFanout: async (filter, options) => {
        const relayUrl = options?.relayUrls?.[0]
        if (relayUrl === shortRelay && filter.limit === 400) {
          shortRelayPrimaryReads += 1
        }
        const source =
          relayUrl === shortRelay ? shortRelayEvents : longRelayEvents
        return source
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? source.length)
      },
      giftUnwrap: async (event) =>
        event.id === readyWrap.id
          ? readyRumor
          : event.id === revocationWrap.id
            ? revocationRumor
            : unrelatedRumor,
    })

    const initial = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(initial.data[0]?.state).toBe("ready_for_pickup")
    expect(initial.inbox?.coverage).toBe("partial")

    shortRelayEvents.push(revocationWrap)
    const continued = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(shortRelayPrimaryReads).toBe(2)
    expect(continued.data[0]?.state).toBe("revoked")
    expect(continued.inbox?.coverage).toBe("partial")
  })

  it("retains a late matching revocation after bounded evidence reaches 1,024 messages", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumors = Array.from({ length: 1_024 }, (_, index) =>
      buildFutureMarketPrivateRumor(
        index === 0
          ? readyPayload()
          : readyPayload({
              issuedAt: ISSUED_AT + index,
              claimRef: (40_000 + index).toString(16).padStart(64, "0"),
            })
      )
    )
    const targetReady = readyRumors[0]!
    const revocationRumor = buildFutureMarketPrivateRumor(
      revocationPayload(targetReady.id)
    )
    const rumorByWrapId = new Map<string, NDKEvent>()
    const relayEvents = readyRumors.map((rumor, index) => {
      const wrap = new NDKEvent()
      wrap.id = (50_000 + index).toString(16).padStart(64, "0")
      wrap.kind = EVENT_KINDS.GIFT_WRAP
      wrap.created_at = ISSUED_AT + 2_000 - index
      wrap.pubkey = MERCHANT
      wrap.tags = [["p", ORGANIZER]]
      wrap.content = "ciphertext"
      rumorByWrapId.set(wrap.id, rumor)
      return wrap
    })
    const revocationWrap = new NDKEvent()
    revocationWrap.id = "f".repeat(64)
    revocationWrap.kind = EVENT_KINDS.GIFT_WRAP
    revocationWrap.created_at = ISSUED_AT
    revocationWrap.pubkey = MERCHANT
    revocationWrap.tags = [["p", ORGANIZER]]
    revocationWrap.content = "ciphertext"
    rumorByWrapId.set(revocationWrap.id, revocationRumor)

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanout: async (filter) =>
        relayEvents
          .filter(
            (event) =>
              (filter.since === undefined ||
                event.created_at! >= filter.since) &&
              (filter.until === undefined || event.created_at! <= filter.until)
          )
          .sort(
            (left, right) =>
              right.created_at! - left.created_at! ||
              left.id.localeCompare(right.id)
          )
          .slice(0, filter.limit ?? relayEvents.length),
      giftUnwrap: async (event) => rumorByWrapId.get(event.id)!,
    })

    const initial = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(initial.messages).toHaveLength(1_024)
    expect(initial.inbox?.coverage).toBe("partial")

    relayEvents.push(revocationWrap)
    const continued = await getEventMarketPrivateMessageList(ORGANIZER)
    expect(continued.messages).toHaveLength(1_024)
    expect(
      continued.messages.some((message) => message.id === targetReady.id)
    ).toBe(true)
    expect(
      continued.messages.some((message) => message.id === revocationRumor.id)
    ).toBe(true)
    expect(continued.inbox?.coverage).toBe("partial")
  })

  it("authorizes a found receipt when an exact timestamp boundary stays capped", async () => {
    const declaredRelay = "wss://organizer.inbox.relay.dev"
    const readyRumor = buildFutureMarketPrivateRumor(readyPayload())
    const readyWrap = signedWrap(ORGANIZER)

    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: organizerSigner }) as never,
      resolveInboxRelayUrls: async () => [declaredRelay],
      fetchEventsFanoutWithDiagnostics: async () => ({
        events: [readyWrap],
        attemptedRelayUrls: [declaredRelay],
        successfulRelayUrls: [declaredRelay],
        failedRelayUrls: [],
        cappedRelayUrls: [declaredRelay],
      }),
      giftUnwrap: async () => readyRumor,
    })

    const read = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })

    expect(read.data).toHaveLength(1)
    expect(read.data[0]?.state).toBe("ready_for_pickup")
    expect(read.inbox?.coverage).toBe("partial")
  })
})
