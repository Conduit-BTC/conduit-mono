import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { wrapEvent } from "nostr-tools/nip59"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkRecoveryPayload,
  EVENT_KINDS,
  freezeCheckoutSparkPlan,
  getDirectMessageConversationList,
  getMerchantCheckoutSparkRecoveryList,
  getMerchantConversationList,
  withMerchantCheckoutSparkRecovery,
  type MerchantCheckoutSparkRecoveryCandidate,
} from "@conduit/core"
import { ConduitDB } from "../packages/core/src/db"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import type {
  NostrKeySigner,
  SignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import {
  readProtectedInbox,
  type ProtectedInboxReadResult,
  type ReadProtectedInboxOptions,
} from "../packages/core/src/protocol/protected-inbox-read"
import type { CommerceRelayExecutor } from "../packages/core/src/protocol/relay-executor"
import {
  activateAccountSigner,
  retireAccountSigner,
  SessionSigner,
} from "../packages/core/src/protocol/session-signer"
import { relayTargetsFromUrls } from "../packages/core/src/protocol/relay-authority"
import {
  createInMemoryInboxDeclarationEvidenceRepository,
  mergeInboxDeclarationEvidence,
} from "../packages/core/src/protocol/inbox-declaration-evidence"
import {
  __resetInboxDeclarationCache,
  getCachedInboxDeclarationEvidence,
  primeInboxDeclarationEvidence,
  sharedInboxDiscoveryRelayUrls,
} from "../packages/core/src/protocol/private-message-routing"
import { admitFixture } from "./helpers/public-event"

const MERCHANT_SECRET = generateSecretKey()
const BUYER_SECRET = generateSecretKey()
const OTHER_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = getPublicKey(BUYER_SECRET)
const OTHER = getPublicKey(OTHER_SECRET)
const INBOX = "wss://merchant-recovery.example"
const CREATED_AT = 1_800_000_000_000
const WALLET_MATERIAL = "synthetic test-only wallet material"

function plan() {
  return freezeCheckoutSparkPlan({
    checkoutId: "checkout-merchant-discovery",
    orderId: "order-merchant-discovery",
    merchantPubkey: MERCHANT,
    walletId: "checkout-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    funding: {
      requestId: "receive-merchant-discovery",
      paymentRequest: "lnbc-private-funding-invoice",
      paymentHash: "b".repeat(64),
      requiredNetSats: 1_235,
      grossFundingSats: 1_240,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 60_000,
    },
    obligations: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        paymentRequest: "lnbc-private-merchant-invoice",
        amountSats: 1_000,
        maxFeeSats: 100,
      },
      {
        kind: "conduit",
        recipientId: "conduithodlings@strike.me",
        paymentRequest: "lnbc-private-conduit-invoice",
        amountSats: 111,
        maxFeeSats: 24,
      },
    ],
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:merchant-discovery-fixture`,
          productEventId: "d".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
  })
}

function recoveryWrap(mnemonic = WALLET_MATERIAL): SignedNostrEvent {
  const rumor = buildCheckoutSparkRecoveryRumor(
    createCheckoutSparkRecoveryPayload({
      plan: plan(),
      senderPubkey: BUYER,
      mnemonic,
      accountNumber: 0,
      preparedAt: CREATED_AT + 1_000,
    })
  )
  return wrapEvent(rumor, BUYER_SECRET, MERCHANT)
}

function ordinaryWrap(index: number): SignedNostrEvent {
  return wrapEvent(
    {
      kind: 14,
      pubkey: BUYER,
      created_at: Math.floor(CREATED_AT / 1_000) + index,
      tags: [["p", MERCHANT]],
      content: "synthetic ordinary message",
    },
    BUYER_SECRET,
    MERCHANT
  )
}

function protectedRead(
  events: SignedNostrEvent[],
  coverage: "complete" | "partial" | "unavailable" = "complete",
  counts: { malformed?: number; unusable?: number } = {}
): ProtectedInboxReadResult {
  const success = coverage === "complete"
  return {
    events,
    coverage,
    auth: {
      state: "not_challenged",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: 0,
    },
    relayResult: {
      status: success ? "success" : coverage,
      observations: success ? [{ type: "eose", relayIndex: 0 }] : [],
      relays: [
        {
          relayIndex: 0,
          status: success ? "success" : "partial",
          auth: "not_challenged",
          eventCount: events.length,
          duplicateCount: 0,
          malformedCount: counts.malformed ?? 0,
          unusableCount: counts.unusable ?? 0,
        },
      ],
      attemptedCount: 1,
      completedCount: success ? 1 : 0,
      failedCount: success ? 0 : 1,
      authoritativeEmpty: success && events.length === 0,
    },
  }
}

function boundedRead(events: SignedNostrEvent[]) {
  const calls: ReadProtectedInboxOptions[] = []
  const read = async (options: ReadProtectedInboxOptions) => {
    calls.push(options)
    const matching = events
      .filter(
        (event) =>
          (!options.eventId || event.id === options.eventId) &&
          (options.until === undefined || event.created_at <= options.until) &&
          (options.since === undefined || event.created_at >= options.since)
      )
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(0, options.limit)
    return protectedRead(matching)
  }
  return { read, calls }
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

let current = true
let decryptCalls = 0
let signer: SessionSigner
let owner: CommerceInbox
let database: ConduitDB
let activeRead: (
  options: ReadProtectedInboxOptions
) => Promise<ProtectedInboxReadResult>

function installMerchantSession(
  options: {
    operationTimeoutMs?: number
    beforeDecrypt?: () => Promise<void>
  } = {}
) {
  const provider: NostrKeySigner = {
    pubkey: MERCHANT,
    getPublicKey: async () => MERCHANT,
    signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
    encryptNip44: async (peer, text) =>
      v2.encrypt(text, v2.utils.getConversationKey(MERCHANT_SECRET, peer)),
    decryptNip44: async (peer, text) => {
      decryptCalls += 1
      await options.beforeDecrypt?.()
      return v2.decrypt(
        text,
        v2.utils.getConversationKey(MERCHANT_SECRET, peer)
      )
    },
    decryptLegacy: async () => {
      throw new Error("Legacy decryption is outside this fixture")
    },
  }
  signer = new SessionSigner(provider, {
    expectedPubkey: MERCHANT,
    revision: "synthetic-merchant-session",
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: false,
    }),
    hasAuthority: () => current,
    operationTimeoutMs: options.operationTimeoutMs,
  })
  activateAccountSigner(signer)
  installProtectedReadSigner(signer, MERCHANT, () => current)
  const authorization = getProtectedReadAuthorization(MERCHANT)!
  database = new ConduitDB(`merchant-recovery-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  owner = new CommerceInbox(
    authorization,
    signer,
    new CommerceInboxStore(authorization, database)
  )
  __setCommerceTestOverrides({
    getAccountSigner: () => signer,
    getCommerceInbox: () => owner,
  })
}

beforeEach(() => {
  current = true
  decryptCalls = 0
  __resetCommerceTestOverrides()
  __resetInboxDeclarationCache()
  __resetProtectedReadSigner()
  activeRead = async () => protectedRead([])
  __setCommerceTestOverrides({
    resolveInboxRelayUrls: async () => [INBOX],
    readProtectedInbox: (options) => activeRead(options),
  })
  installMerchantSession()
})

afterEach(async () => {
  owner.stop()
  retireAccountSigner(signer)
  __resetCommerceTestOverrides()
  __resetInboxDeclarationCache()
  __resetProtectedReadSigner()
  await database.delete()
})

describe("Merchant checkout Spark recovery discovery", () => {
  async function retainSignedInboxWithPartialLookup(): Promise<void> {
    const declaration = await admitFixture(
      finalizeEvent(
        {
          kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
          created_at: Math.floor(CREATED_AT / 1_000),
          tags: [["relay", INBOX]],
          content: "",
        },
        MERCHANT_SECRET
      )
    )
    const source = sharedInboxDiscoveryRelayUrls()[0]!
    const evidence = await mergeInboxDeclarationEvidence(
      {
        pubkey: MERCHANT,
        signedEvent: declaration,
        sourceRelayUrls: [source],
        sharedSourceRelayUrls: [source],
      },
      createInMemoryInboxDeclarationEvidenceRepository()
    )
    primeInboxDeclarationEvidence(evidence)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: undefined,
      fetchPublicEventsWithDiagnostics: async (_filter, options) => {
        const relayUrls = options?.relayUrls ?? []
        return {
          events: [],
          attemptedRelayUrls: relayUrls,
          successfulRelayUrls: relayUrls.slice(0, 1),
          failedRelayUrls: relayUrls.slice(1),
        }
      },
    })
  }

  it("keeps signed current recovery usable across partial declaration lookup and complete history", async () => {
    await retainSignedInboxWithPartialLookup()
    const wrap = recoveryWrap()
    activeRead = boundedRead([wrap]).read

    const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(
      getCachedInboxDeclarationEvidence(MERCHANT)?.latestLookup?.coverage
    ).toBe("partial")
    expect(discovered).toMatchObject({
      coverage: "complete",
      declarationState: "declared",
      candidates: [{ wrapId: wrap.id }],
    })

    let consumed = 0
    const result = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      discovered.candidates[0]!,
      {
        async consume(payload, assertCurrent) {
          assertCurrent()
          expect(payload.wallet.mnemonic).toBe(WALLET_MATERIAL)
          consumed += 1
        },
      }
    )
    expect(result).toMatchObject({
      status: "consumed",
      coverage: "complete",
      discoveryCoverage: "complete",
      candidate: { wrapId: wrap.id },
    })
    expect(consumed).toBe(1)
  })

  it("keeps partial protected history incomplete despite a surviving signed inbox", async () => {
    await retainSignedInboxWithPartialLookup()
    const wrap = recoveryWrap()
    activeRead = boundedRead([wrap]).read
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    expect(
      getCachedInboxDeclarationEvidence(MERCHANT)?.latestLookup?.coverage
    ).toBe("partial")
    activeRead = async (options) =>
      options.eventId
        ? protectedRead([wrap], "partial")
        : protectedRead([], "partial")

    const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(discovered.coverage).toBe("partial")
    let consumed = false
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      async consume() {
        consumed = true
      },
    })
    expect(result).toMatchObject({
      status: "incomplete",
      coverage: "partial",
      discoveryCoverage: "partial",
    })
    activeRead = async (options) =>
      options.eventId
        ? protectedRead([], "unavailable")
        : protectedRead([], "partial")
    const unavailable = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      {
        async consume() {
          consumed = true
        },
      }
    )
    expect(unavailable).toMatchObject({
      status: "incomplete",
      coverage: "unavailable",
      discoveryCoverage: "partial",
    })
    expect(consumed).toBe(false)
  })

  it("narrows the protected reader to one full signed wrap ID", async () => {
    const wrap = recoveryWrap()
    let observedFilter: unknown
    const executor = {
      query: async (request: { filters: unknown[] }) => {
        observedFilter = request.filters[0]
        const read = protectedRead([wrap])
        return { ...read.relayResult, events: read.events }
      },
    } as unknown as CommerceRelayExecutor
    const result = await readProtectedInbox({
      principalPubkey: MERCHANT,
      relayUrls: [INBOX],
      relayTargets: relayTargetsFromUrls([INBOX], {
        kind: "owner_nip17",
        operation: "read",
        ownerPubkey: MERCHANT,
      }),
      inboxDeclarationEvidenceRepository: await (async () => {
        const repository = createInMemoryInboxDeclarationEvidenceRepository()
        const signedEvent = await admitFixture(
          finalizeEvent(
            {
              kind: 10050,
              created_at: 1,
              tags: [["relay", INBOX]],
              content: "",
            },
            MERCHANT_SECRET
          )
        )
        await mergeInboxDeclarationEvidence(
          {
            pubkey: MERCHANT,
            signedEvent,
            sourceRelayUrls: sharedInboxDiscoveryRelayUrls(),
            sharedSourceRelayUrls: sharedInboxDiscoveryRelayUrls(),
          },
          repository
        )
        return repository
      })(),
      eventId: wrap.id,
      limit: 2,
      authorization: getProtectedReadAuthorization(MERCHANT),
      accountNetworkLocalStateRepository: { get: async () => undefined },
      executor,
    })
    expect(observedFilter).toEqual({
      kinds: [1059],
      "#p": [MERCHANT],
      ids: [wrap.id],
      limit: 2,
    })
    expect(result.events.map((event) => event.id)).toEqual([wrap.id])
  })

  it("discovers a machine wrap through the durable owner without persisting wallet material", async () => {
    const wrap = recoveryWrap()
    const source = boundedRead([wrap])
    activeRead = source.read
    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(result).toMatchObject({
      candidates: [
        {
          wrapId: wrap.id,
          checkoutId: plan().checkoutId,
          orderId: plan().orderId,
          planDigest: plan().planDigest,
          takeoverAt: plan().takeoverAt,
          preparedAt: CREATED_AT + 1_000,
        },
      ],
      coverage: "complete",
      declarationState: "declared",
      malformedCount: 0,
      decryptFailureCount: 0,
      conflictCount: 0,
    })
    expect(source.calls[0]).toMatchObject({
      relayUrls: [INBOX],
      relayTargets: relayTargetsFromUrls([INBOX], {
        kind: "owner_nip17",
        operation: "read",
        ownerPubkey: MERCHANT,
      }),
      limit: 50,
    })
    expect(
      (await database.commerceInboxWrappers.toArray())[0]?.event
    ).toMatchObject({
      id: wrap.id,
      content: wrap.content,
      sig: wrap.sig,
      tags: wrap.tags,
    })
    expect(await database.commerceInboxRecords.count()).toBe(1)
    expect(
      JSON.stringify(await database.commerceInboxRecords.toArray())
    ).not.toContain(WALLET_MATERIAL)
    expect(JSON.stringify(await owner.store.projections())).not.toContain(
      WALLET_MATERIAL
    )
    expect(JSON.stringify(result)).not.toContain("lnbc-private")
    expect(owner.getSnapshot().orderMessages).toEqual([])
    expect(owner.getSnapshot().directMessages).toEqual([])
    expect(
      (await getMerchantConversationList({ principalPubkey: MERCHANT })).data
    ).toEqual([])
    expect(
      (await getDirectMessageConversationList({ principalPubkey: MERCHANT }))
        .data
    ).toEqual([])
  })

  it("does not read compatibility relays without a declared inbox", async () => {
    let readCalled = false
    __setCommerceTestOverrides({ resolveInboxRelayUrls: async () => [] })
    activeRead = async () => {
      readCalled = true
      return protectedRead([])
    }
    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(result).toMatchObject({
      candidates: [],
      coverage: "unavailable",
      declarationState: "not_observed",
    })
    expect(readCalled).toBe(false)
  })

  it("preserves a discovered descriptor when a later history page is partial", async () => {
    const wrap = recoveryWrap()
    activeRead = boundedRead([wrap]).read
    expect(
      (await getMerchantCheckoutSparkRecoveryList(MERCHANT)).candidates
    ).toHaveLength(1)
    activeRead = async () => protectedRead([], "partial")
    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(result.candidates).toHaveLength(1)
    expect(result.coverage).toBe("partial")
  })

  it("retains positive recovery evidence but holds the cursor until the boundary read is complete", async () => {
    const wrap = recoveryWrap()
    const others = Array.from({ length: 49 }, (_, index) => ordinaryWrap(index))
    const source = boundedRead([wrap, ...others])
    activeRead = async (options) =>
      options.since === undefined
        ? await source.read(options)
        : protectedRead([], "partial")
    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.wrapId).toBe(wrap.id)
    expect(result.coverage).toBe("partial")
    expect(await database.commerceInboxRecords.count()).toBe(50)
    const range = await database.commerceInboxRanges.get(
      owner.store.key(`${INBOX}:nip17`)
    )
    expect(range?.status).toBe("partial")
    expect(range?.until).toBeUndefined()
    expect(source.calls[0]?.limit).toBe(50)
  })

  it("keeps one-page discovery bounded with more than fifty wraps", async () => {
    const wrap = recoveryWrap()
    const ordinary = Array.from({ length: 51 }, (_, index) =>
      ordinaryWrap(index + 1)
    )
    const source = boundedRead([wrap, ...ordinary])
    activeRead = source.read
    const first = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(first.coverage).toBe("partial")
    expect(source.calls[0]?.limit).toBe(50)
    expect(source.calls.some((call) => call.since !== undefined)).toBe(true)
    const second = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(second.candidates).toHaveLength(1)
    expect(second.coverage).toBe("partial")
  }, 30_000)

  it("fences a current-session provider timeout without starting a replacement prompt", async () => {
    owner.stop()
    retireAccountSigner(signer)
    await database.delete()
    const entered = deferred()
    const gate = deferred()
    installMerchantSession({
      operationTimeoutMs: 15,
      beforeDecrypt: async () => {
        entered.release()
        await gate.promise
      },
    })
    activeRead = boundedRead([recoveryWrap()]).read
    const pending = getMerchantCheckoutSparkRecoveryList(MERCHANT)
    await entered.promise
    const result = await pending
    expect(result.candidates).toEqual([])
    expect(result.coverage).toBe("partial")
    await expect(
      signer.signEvent({
        kind: 1,
        pubkey: MERCHANT,
        created_at: Math.floor(CREATED_AT / 1_000),
        tags: [],
        content: "synthetic",
      })
    ).rejects.toMatchObject({ code: "provider_unavailable" })
    expect(decryptCalls).toBe(1)
    gate.release()
    await Bun.sleep(0)
  }, 8_000)

  it("rejects a mismatched account signer before exact consume I/O", async () => {
    const wrap = recoveryWrap()
    activeRead = boundedRead([wrap]).read
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    __setCommerceTestOverrides({
      getAccountSigner: () => ({ ...signer, pubkey: OTHER }) as never,
    })
    let readCalled = false
    activeRead = async () => {
      readCalled = true
      return protectedRead([])
    }
    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        async consume() {
          throw new Error("should not run")
        },
      })
    ).rejects.toBeDefined()
    expect(readCalled).toBe(false)
  })

  it("discards discovery when protected account authority changes during the read", async () => {
    const wrap = recoveryWrap()
    activeRead = async () => {
      current = false
      return protectedRead([wrap])
    }
    await expect(
      getMerchantCheckoutSparkRecoveryList(MERCHANT)
    ).rejects.toBeDefined()
    expect(await database.commerceInboxRecords.count()).toBe(0)
  })

  it("discards decrypted recovery metadata after account revocation", async () => {
    const entered = deferred()
    const gate = deferred()
    owner.stop()
    retireAccountSigner(signer)
    await database.delete()
    installMerchantSession({
      beforeDecrypt: async () => {
        entered.release()
        await gate.promise
      },
    })
    activeRead = boundedRead([recoveryWrap()]).read
    const pending = getMerchantCheckoutSparkRecoveryList(MERCHANT)
    await entered.promise
    current = false
    gate.release()
    await expect(pending).rejects.toBeDefined()
    expect(await database.commerceInboxRecords.count()).toBe(0)
  })

  it("quarantines conflicting wallet authority for the same checkout", async () => {
    const wraps = [
      recoveryWrap("synthetic wallet phrase one"),
      recoveryWrap("synthetic wallet phrase two"),
    ]
    activeRead = boundedRead(wraps).read
    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(result.candidates).toEqual([])
    expect(result.conflictCount).toBe(1)
    expect(result.coverage).toBe("partial")
    expect(JSON.stringify(result)).not.toContain("phrase")
  })

  it("re-fetches one exact signed wrap and exposes plaintext only inside the private adapter", async () => {
    const wrap = recoveryWrap()
    const source = boundedRead([wrap])
    activeRead = source.read
    const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    let consumed = 0
    const result = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      discovered.candidates[0]!,
      {
        async consume(payload, assertCurrent) {
          assertCurrent()
          expect(payload.wallet.mnemonic).toBe(WALLET_MATERIAL)
          expect(payload.plan.planDigest).toBe(plan().planDigest)
          consumed += 1
        },
      }
    )
    expect(consumed).toBe(1)
    expect(result).toMatchObject({
      status: "consumed",
      coverage: "complete",
      candidate: { wrapId: wrap.id },
    })
    expect(source.calls.at(-1)).toMatchObject({
      eventId: wrap.id,
      limit: 2,
      relayUrls: [INBOX],
      relayTargets: relayTargetsFromUrls([INBOX], {
        kind: "owner_nip17",
        operation: "read",
        ownerPubkey: MERCHANT,
      }),
    })
    expect(JSON.stringify(result)).not.toContain(WALLET_MATERIAL)
    expect(
      JSON.stringify(await database.commerceInboxRecords.toArray())
    ).not.toContain(WALLET_MATERIAL)
  })

  it("rejects a stale or missing exact wrap without consuming", async () => {
    const wrap = recoveryWrap()
    let exactAvailable = true
    activeRead = async (options) =>
      protectedRead(
        options.eventId && (!exactAvailable || options.eventId !== wrap.id)
          ? []
          : [wrap]
      )
    const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    const selected = discovered.candidates[0]!
    let consumed = false
    const adapter = {
      async consume() {
        consumed = true
      },
    }
    const wrong: MerchantCheckoutSparkRecoveryCandidate = {
      ...selected,
      wrapId: "a".repeat(64),
    }
    const wrongResult = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      wrong,
      adapter
    )
    expect(wrongResult.status).toBe("missing")
    exactAvailable = false
    const missing = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(missing).toMatchObject({ status: "missing", coverage: "complete" })
    expect(consumed).toBe(false)
  })

  it("keeps forged and degraded exact evidence out of the private adapter", async () => {
    const wrap = recoveryWrap()
    let exact = protectedRead([{ ...wrap, content: "forged ciphertext" }])
    activeRead = async (options) =>
      options.eventId ? exact : protectedRead([wrap])
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    let consumed = 0
    const adapter = {
      async consume() {
        consumed += 1
      },
    }
    const forged = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(forged).toMatchObject({ status: "incomplete", coverage: "partial" })
    exact = protectedRead([wrap], "partial")
    const degraded = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(degraded).toMatchObject({
      status: "incomplete",
      coverage: "partial",
    })
    expect(consumed).toBe(0)
  })

  it("rejects account replacement during exact re-fetch and sanitizes adapter failures", async () => {
    const wrap = recoveryWrap()
    let revokeExact = true
    activeRead = async (options) => {
      if (options.eventId && revokeExact) current = false
      return protectedRead([wrap])
    }
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        async consume() {
          throw new Error("should not run")
        },
      })
    ).rejects.toBeDefined()
    current = true
    revokeExact = false
    owner.stop()
    retireAccountSigner(signer)
    await database.delete()
    installMerchantSession()
    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        async consume() {
          throw new Error(WALLET_MATERIAL)
        },
      })
    ).rejects.toThrow("Merchant checkout recovery adapter failed")
  })
})
