import { afterEach, describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
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
import {
  __resetProtectedReadSigner,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type {
  NostrKeySigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import { getEventHash } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "../packages/core/src/db"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import { getProtectedReadAuthorization } from "../packages/core/src/protocol/protected-read-authorization"
import type {
  ReadProtectedInboxOptions,
  ProtectedInboxReadResult,
} from "../packages/core/src/protocol/protected-inbox-read"
const ORGANIZER_SECRET = generateSecretKey()
const MERCHANT_SECRET = generateSecretKey()
const WRAP_SECRET = generateSecretKey()
const ORGANIZER = getPublicKey(ORGANIZER_SECRET)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const MARKET = `30409:${ORGANIZER}:market`
const CALENDAR = `31923:${ORGANIZER}:market-day`
const ISSUED_AT = 1_700_000_100
const originalConfig = structuredClone(config)
const recoveryOwners: CommerceInbox[] = []
const recoveryDatabases: ConduitDB[] = []
afterEach(async () => {
  for (const owner of recoveryOwners.splice(0)) owner.stop()
  for (const db of recoveryDatabases.splice(0)) await db.delete()
  Object.assign(config, structuredClone(originalConfig))
  __resetInboxRelayCache()
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
})
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

  function recoveryOwner(database?: ConduitDB): CommerceInbox {
    const signer: NostrKeySigner = {
      pubkey: ORGANIZER,
      authMethod: "nip07",
      getPublicKey: async () => ORGANIZER,
      signEvent: async (event) => finalizeEvent(event, ORGANIZER_SECRET),
      encryptNip44: async (peer, value) =>
        v2.encrypt(value, v2.utils.getConversationKey(ORGANIZER_SECRET, peer)),
      decryptNip44: async (peer, value) =>
        v2.decrypt(value, v2.utils.getConversationKey(ORGANIZER_SECRET, peer)),
      decryptLegacy: async () => "",
    }
    installProtectedReadSigner(signer, ORGANIZER, () => true)
    const authorization = getProtectedReadAuthorization(ORGANIZER)
    if (!authorization) throw new Error("Expected organizer authorization")
    const resolvedDatabase =
      database ??
      new ConduitDB(`organizer-inbox-${crypto.randomUUID()}`, {
        indexedDB: new IDBFactory(),
        IDBKeyRange,
      })
    if (!database) recoveryDatabases.push(resolvedDatabase)
    const owner = new CommerceInbox(
      authorization,
      signer,
      new CommerceInboxStore(authorization, resolvedDatabase)
    )
    recoveryOwners.push(owner)
    return owner
  }

  function encryptedRecoveryWrap(
    rumor: {
      kind: number
      pubkey: string
      created_at: number
      tags: string[][]
      content: string
      id?: string
    },
    createdAt = ISSUED_AT + 1_000
  ): SignedNostrEvent {
    const inner = { ...rumor, id: rumor.id ?? "" }
    const seal = finalizeEvent(
      {
        kind: 13,
        created_at: createdAt,
        tags: [],
        content: v2.encrypt(
          JSON.stringify(inner),
          v2.utils.getConversationKey(MERCHANT_SECRET, ORGANIZER)
        ),
      },
      MERCHANT_SECRET
    )
    return finalizeEvent(
      {
        kind: 1_059,
        created_at: createdAt,
        tags: [["p", ORGANIZER]],
        content: v2.encrypt(
          JSON.stringify(seal),
          v2.utils.getConversationKey(WRAP_SECRET, ORGANIZER)
        ),
      },
      WRAP_SECRET
    )
  }

  function recoveryRead(relayEvents: Map<string, SignedNostrEvent[]>) {
    const calls: ReadProtectedInboxOptions[] = []
    const read = async (
      options: ReadProtectedInboxOptions
    ): Promise<ProtectedInboxReadResult> => {
      calls.push(options)
      const relayUrl = options.relayUrls[0]!
      const events = (relayEvents.get(relayUrl) ?? [])
        .filter(
          (event) =>
            (options.since === undefined ||
              event.created_at >= options.since) &&
            (options.until === undefined || event.created_at <= options.until)
        )
        .sort(
          (left, right) =>
            right.created_at - left.created_at ||
            left.id.localeCompare(right.id)
        )
        .slice(0, options.limit)
      return {
        events,
        coverage: "complete",
        auth: {
          state: "not_challenged",
          challengedCount: 0,
          succeededCount: 0,
          failedCount: 0,
        },
        relayResult: {
          status: "success",
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
        },
      }
    }
    return { read, calls }
  }

  function directWrap(index: number, createdAt: number): SignedNostrEvent {
    const rumor = {
      kind: 14,
      pubkey: MERCHANT,
      created_at: createdAt,
      tags: [["p", ORGANIZER]],
      content: `synthetic direct ${index}`,
    }
    return encryptedRecoveryWrap(
      { ...rumor, id: getEventHash(rumor) },
      createdAt
    )
  }

  it("reads current handoff authority only from the declared relay and excludes it from general search", async () => {
    const relay = "wss://organizer.inbox.relay.dev"
    const owner = recoveryOwner()
    const ready = buildFutureMarketPrivateRumor(readyPayload())
    const sources = new Map([[relay, [encryptedRecoveryWrap(ready)]]])
    const { read, calls } = recoveryRead(sources)
    __setCommerceTestOverrides({
      getCommerceInbox: () => owner,
      resolveInboxRelayUrls: async () => [relay],
      readProtectedInbox: read,
    })
    const result = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(result.data[0]?.state).toBe("ready_for_pickup")
    expect(result.inbox?.coverage).toBe("complete")
    expect(
      calls.every(
        (call) => call.relayUrls.length === 1 && call.relayUrls[0] === relay
      )
    ).toBe(true)
    expect(owner.getSnapshot().externalRecords).toEqual([])
    expect(owner.getSnapshot().orderMessages).toEqual([])
  })

  it("retains a late revocation past a bounded page without certifying the stitched history", async () => {
    const relay = "wss://organizer.inbox.relay.dev"
    const owner = recoveryOwner()
    const ready = buildFutureMarketPrivateRumor(readyPayload())
    const revocation = buildFutureMarketPrivateRumor(
      revocationPayload(ready.id)
    )
    const high = ISSUED_AT + 1000
    const sources = new Map([
      [
        relay,
        [
          ...Array.from({ length: 55 }, (_, i) => directWrap(i, high - i)),
          encryptedRecoveryWrap(ready, high - 55),
          encryptedRecoveryWrap(revocation, high - 56),
        ],
      ],
    ])
    const { read } = recoveryRead(sources)
    __setCommerceTestOverrides({
      getCommerceInbox: () => owner,
      resolveInboxRelayUrls: async () => [relay],
      readProtectedInbox: read,
    })
    const first = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(first.data).toEqual([])
    expect(first.inbox?.coverage).toBe("partial")
    const second = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(second.data[0]?.state).toBe("revoked")
    expect(second.inbox?.coverage).toBe("partial")
    expect((await owner.store.wrappers()).length).toBe(57)
  }, 60_000)

  it("restarts an observed EOSE source and finds a newly backdated revocation", async () => {
    const relay = "wss://organizer.inbox.relay.dev"
    const owner = recoveryOwner()
    const ready = buildFutureMarketPrivateRumor(readyPayload())
    const revocation = buildFutureMarketPrivateRumor(
      revocationPayload(ready.id)
    )
    const sources = new Map([
      [relay, [encryptedRecoveryWrap(ready, ISSUED_AT + 200)]],
    ])
    const { read, calls } = recoveryRead(sources)
    __setCommerceTestOverrides({
      getCommerceInbox: () => owner,
      resolveInboxRelayUrls: async () => [relay],
      readProtectedInbox: read,
    })
    expect(
      (
        await readCurrentClaims({
          organizerPubkey: ORGANIZER,
          marketCoordinate: MARKET,
        })
      ).data[0]?.state
    ).toBe("ready_for_pickup")
    sources.get(relay)!.push(encryptedRecoveryWrap(revocation, ISSUED_AT + 100))
    const result = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(result.data[0]?.state).toBe("revoked")
    expect(calls.every((call) => call.until === undefined)).toBe(true)
  })

  it("rejects an in-flight handoff read when its declared plan changes", async () => {
    const relay = "wss://organizer.inbox.relay.dev"
    const owner = recoveryOwner()
    let relays = [relay]
    const { read } = recoveryRead(
      new Map([
        [
          relay,
          [
            encryptedRecoveryWrap(
              buildFutureMarketPrivateRumor(readyPayload())
            ),
          ],
        ],
      ])
    )
    __setCommerceTestOverrides({
      getCommerceInbox: () => owner,
      resolveInboxRelayUrls: async () => relays,
      readProtectedInbox: async (options) => {
        const result = await read(options)
        relays = ["wss://replacement.inbox.relay.dev"]
        return result
      },
    })
    await expect(getEventMarketPrivateMessageList(ORGANIZER)).rejects.toThrow(
      "relay plan changed"
    )
  })

  it("keeps found authenticated receipts under incomplete source coverage", async () => {
    const relay = "wss://organizer.inbox.relay.dev"
    const owner = recoveryOwner()
    await owner.ingest(
      encryptedRecoveryWrap(buildFutureMarketPrivateRumor(readyPayload())),
      [relay]
    )
    await owner.waitForDecode()
    const { read } = recoveryRead(new Map())
    __setCommerceTestOverrides({
      getCommerceInbox: () => owner,
      resolveInboxRelayUrls: async () => [relay],
      readProtectedInbox: async (options) => ({
        ...(await read(options)),
        coverage: "partial",
      }),
    })
    const result = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(result.data[0]?.state).toBe("ready_for_pickup")
    expect(result.inbox?.coverage).toBe("partial")
  })
})
