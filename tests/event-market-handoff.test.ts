import { afterEach, describe, expect, it } from "bun:test"
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
import { attachEventSourceRelayUrl } from "@conduit/core/protocol/relay-reader"
import {
  createInMemoryInboxDeclarationEvidenceRepository,
  mergeInboxDeclarationEvidence,
} from "@conduit/core/protocol/inbox-declaration-evidence"
import {
  getCachedInboxDeclarationEvidence,
  primeInboxDeclarationEvidence,
  sharedInboxDiscoveryRelayUrls,
} from "@conduit/core/protocol/private-message-routing"
import { admitFixture } from "./helpers/public-event"
import {
  __resetProtectedReadSigner,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import type {
  NostrKeySigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import { NostrSignerError } from "../packages/core/src/protocol/nostr-event-signer"
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
    const resolve = async (relayUrl: string, createdAt: number) => {
      const observed = await admitFixture(declaration(relayUrl, createdAt))
      attachEventSourceRelayUrl(observed as never, isolatedRelayUrl)
      return resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: [isolatedRelayUrl],
        now: () => createdAt * 1_000,
        fetchEventsWithDiagnostics: async () => ({
          events: [observed],
          attemptedRelayUrls: [isolatedRelayUrl],
          successfulRelayUrls: [isolatedRelayUrl],
          failedRelayUrls: [],
        }),
      })
    }

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
    const observed = await admitFixture(declaration)
    attachEventSourceRelayUrl(observed as never, "wss://discovery.relay.dev")
    await expect(
      resolveEventMarketOrganizerInbox(ORGANIZER, {
        relayUrls: ["wss://discovery.relay.dev"],
        now: () => ISSUED_AT * 1_000,
        fetchEventsWithDiagnostics: async () => ({
          events: [observed],
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

  function recoveryOwner(
    database?: ConduitDB,
    options: {
      principalSecret?: Uint8Array
      refuseDecrypt?: () => boolean
    } = {}
  ): CommerceInbox {
    const principalSecret = options.principalSecret ?? ORGANIZER_SECRET
    const principal = getPublicKey(principalSecret)
    const signer: NostrKeySigner = {
      pubkey: principal,
      authMethod: "nip07",
      getPublicKey: async () => principal,
      signEvent: async (event) => finalizeEvent(event, principalSecret),
      encryptNip44: async (peer, value) =>
        v2.encrypt(value, v2.utils.getConversationKey(principalSecret, peer)),
      decryptNip44: async (peer, value) => {
        if (options.refuseDecrypt?.()) throw new NostrSignerError("unavailable")
        return v2.decrypt(
          value,
          v2.utils.getConversationKey(principalSecret, peer)
        )
      },
      decryptLegacy: async () => "",
    }
    installProtectedReadSigner(signer, principal, () => true)
    const authorization = getProtectedReadAuthorization(principal)
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
      created_at?: number
      tags: string[][]
      content: string
      id?: string
    },
    createdAt = ISSUED_AT + 1_000,
    recipient = ORGANIZER
  ): SignedNostrEvent {
    const inner = {
      ...rumor,
      created_at: rumor.created_at ?? createdAt,
      id: rumor.id ?? "",
    }
    const seal = finalizeEvent(
      {
        kind: 13,
        created_at: createdAt,
        tags: [],
        content: v2.encrypt(
          JSON.stringify(inner),
          v2.utils.getConversationKey(MERCHANT_SECRET, recipient)
        ),
      },
      MERCHANT_SECRET
    )
    return finalizeEvent(
      {
        kind: 1_059,
        created_at: createdAt,
        tags: [["p", recipient]],
        content: v2.encrypt(
          JSON.stringify(seal),
          v2.utils.getConversationKey(WRAP_SECRET, recipient)
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

  it("keeps complete signed-current handoff history usable during partial declaration discovery", async () => {
    const relay = "wss://organizer.inbox.relay.dev"
    const declaration = await admitFixture(
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
          created_at: ISSUED_AT,
          tags: [["relay", relay]],
          content: "",
        },
        ORGANIZER_SECRET
      )
    )
    const source = sharedInboxDiscoveryRelayUrls()[0]!
    const evidence = await mergeInboxDeclarationEvidence(
      {
        pubkey: ORGANIZER,
        signedEvent: declaration,
        sourceRelayUrls: [source],
        sharedSourceRelayUrls: [source],
      },
      createInMemoryInboxDeclarationEvidenceRepository()
    )
    primeInboxDeclarationEvidence(evidence)
    const owner = recoveryOwner()
    const ready = buildFutureMarketPrivateRumor(readyPayload())
    const { read } = recoveryRead(
      new Map([[relay, [encryptedRecoveryWrap(ready)]]])
    )
    __setCommerceTestOverrides({
      getCommerceInbox: () => owner,
      fetchPublicEventsWithDiagnostics: async (_filter, options) => {
        const relayUrls = options?.relayUrls ?? []
        return {
          events: [],
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: relayUrls.slice(0, 1),
          failedRelayUrls: relayUrls.slice(1),
        }
      },
      readProtectedInbox: read,
    })

    const result = await readCurrentClaims({
      organizerPubkey: ORGANIZER,
      marketCoordinate: MARKET,
    })
    expect(
      getCachedInboxDeclarationEvidence(ORGANIZER)?.latestLookup?.coverage
    ).toBe("partial")
    expect(result.data[0]?.state).toBe("ready_for_pickup")
    expect(result.inbox?.coverage).toBe("complete")
    expect(result.stale).toBe(false)
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

  it("keeps an undecoded merchant self-copy unresolved until signer retry", async () => {
    const relay = "wss://merchant.inbox.relay.dev"
    let refuseDecrypt = true
    const owner = recoveryOwner(undefined, {
      principalSecret: MERCHANT_SECRET,
      refuseDecrypt: () => refuseDecrypt,
    })
    const ready = buildFutureMarketPrivateRumor(readyPayload())
    const wrap = encryptedRecoveryWrap(ready, ISSUED_AT + 1_000, MERCHANT)
    const { read } = recoveryRead(new Map([[relay, [wrap]]]))
    __setCommerceTestOverrides({
      getCommerceInbox: () => owner,
      resolveInboxRelayUrls: async () => [relay],
      readProtectedInbox: read,
    })

    const refused = await getEventMarketPrivateMessageList(MERCHANT)
    expect(refused.messages).toEqual([])
    expect(refused.inbox?.coverage).toBe("partial")
    expect(refused.decryptFailures).toEqual([
      { wrapId: wrap.id, reason: "nip44_failed" },
    ])
    expect(await owner.recoveryEvidence([relay])).toMatchObject({
      unresolved: true,
      decryptFailures: [{ wrapId: wrap.id, reason: "nip44_failed" }],
    })

    refuseDecrypt = false
    await owner.retryDecode()
    const recovered = await getEventMarketPrivateMessageList(MERCHANT)
    expect(recovered.messages.map((message) => message.id)).toContain(ready.id)
    expect(recovered.authenticatedWraps?.[ready.id]?.id).toBe(wrap.id)
    expect(recovered.decryptFailures).toEqual([])
    expect(recovered.inbox?.coverage).toBe("complete")
    expect((await owner.recoveryEvidence([relay])).unresolved).toBe(false)
  })

  it("does not let a different source's failed wrap degrade declared recovery", async () => {
    const declaredRelay = "wss://merchant.inbox.relay.dev"
    const otherRelay = "wss://merchant.other.relay.dev"
    const owner = recoveryOwner(undefined, {
      principalSecret: MERCHANT_SECRET,
      refuseDecrypt: () => true,
    })
    const wrap = encryptedRecoveryWrap(
      buildFutureMarketPrivateRumor(readyPayload()),
      ISSUED_AT + 1_001,
      MERCHANT
    )
    await owner.ingest(wrap, [otherRelay])
    await owner.waitForDecode()
    const { read } = recoveryRead(new Map())
    __setCommerceTestOverrides({
      getCommerceInbox: () => owner,
      resolveInboxRelayUrls: async () => [declaredRelay],
      readProtectedInbox: read,
    })

    const evidence = await owner.recoveryEvidence([declaredRelay])
    expect(evidence.unresolved).toBe(false)
    expect(evidence.decryptFailures).toEqual([])
    const result = await getEventMarketPrivateMessageList(MERCHANT)
    expect(result.inbox?.coverage).toBe("complete")
    expect(result.decryptFailures).toEqual([])
  })

  it("keeps a malformed decoded commerce record adverse while excluding an unsupported one", async () => {
    const declaredRelay = "wss://merchant.inbox.relay.dev"
    const otherRelay = "wss://merchant.other.relay.dev"
    const owner = recoveryOwner(undefined, {
      principalSecret: MERCHANT_SECRET,
    })
    const malformedRumor = {
      kind: 16,
      pubkey: MERCHANT,
      created_at: ISSUED_AT + 3_000,
      tags: [
        ["p", MERCHANT],
        ["type", "message"],
        ["order", "order-malformed"],
      ],
      content: "{}",
    }
    const unsupportedRumor = {
      ...malformedRumor,
      created_at: malformedRumor.created_at + 1,
      tags: [
        ["p", MERCHANT],
        ["type", "unrecognized-commerce-type"],
        ["order", "order-unsupported"],
      ],
    }
    const malformedWrap = encryptedRecoveryWrap(
      { ...malformedRumor, id: getEventHash(malformedRumor) },
      malformedRumor.created_at,
      MERCHANT
    )
    const unsupportedWrap = encryptedRecoveryWrap(
      { ...unsupportedRumor, id: getEventHash(unsupportedRumor) },
      unsupportedRumor.created_at,
      MERCHANT
    )
    await owner.ingest(unsupportedWrap, [otherRelay])
    await owner.waitForDecode()
    const { read } = recoveryRead(new Map([[declaredRelay, [malformedWrap]]]))
    __setCommerceTestOverrides({
      getCommerceInbox: () => owner,
      resolveInboxRelayUrls: async () => [declaredRelay],
      readProtectedInbox: read,
    })

    const strict = await getEventMarketPrivateMessageList(MERCHANT)
    expect(strict.messages).toEqual([])
    expect(strict.inbox?.coverage).toBe("partial")
    expect(strict.decryptFailures).toEqual([
      { wrapId: malformedWrap.id, reason: "malformed" },
    ])
    const rows = await owner.store.wrappers()
    expect(rows.find((row) => row.event.id === malformedWrap.id)?.state).toBe(
      "malformed"
    )
    expect(rows.find((row) => row.event.id === unsupportedWrap.id)?.state).toBe(
      "unsupported"
    )
    expect((await owner.recoveryEvidence([otherRelay])).unresolved).toBe(false)
  })

  it("classifies retained undecoded wraps without treating resolved states as failures", async () => {
    const relay = "wss://merchant.inbox.relay.dev"
    const owner = recoveryOwner(undefined, {
      principalSecret: MERCHANT_SECRET,
    })
    const states = [
      "queued",
      "waiting_for_signer",
      "opening",
      "permission_declined",
      "provider_unavailable",
      "retryable_failure",
      "malformed",
      "invalid_envelope",
      "machine",
      "unrelated",
      "unsupported",
      "deleted",
      "expired",
    ] as const
    const wraps = states.map((state, index) => ({
      state,
      wrap: encryptedRecoveryWrap(
        buildFutureMarketPrivateRumor(readyPayload()),
        ISSUED_AT + 2_000 + index,
        MERCHANT
      ),
    }))
    for (const { state, wrap } of wraps) {
      await owner.store.receive(wrap, [relay])
      await owner.store.database.commerceInboxWrappers.update(
        owner.store.key(wrap.id),
        { state }
      )
    }
    const evidence = await owner.recoveryEvidence([relay])
    expect(evidence.unresolved).toBe(true)
    expect(
      evidence.decryptFailures.map((failure) => failure.wrapId).sort()
    ).toEqual(
      wraps
        .filter(({ state }) =>
          [
            "permission_declined",
            "provider_unavailable",
            "retryable_failure",
            "malformed",
            "invalid_envelope",
          ].includes(state)
        )
        .map(({ wrap }) => wrap.id)
        .sort()
    )
    for (const { wrap } of wraps.slice(0, 8))
      await owner.store.database.commerceInboxWrappers.update(
        owner.store.key(wrap.id),
        { state: "unrelated" }
      )
    expect((await owner.recoveryEvidence([relay])).unresolved).toBe(false)
  })
})
