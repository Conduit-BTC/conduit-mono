import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk"
import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  buildCheckoutSparkRecoveryRumor,
  createCheckoutSparkRecoveryPayload,
  freezeCheckoutSparkPlan,
  getMerchantCheckoutSparkRecoveryList,
  withMerchantCheckoutSparkRecovery,
} from "@conduit/core"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import {
  readProtectedInbox,
  type ProtectedInboxReadResult,
} from "../packages/core/src/protocol/protected-inbox-read"
import type { CommerceRelayExecutor } from "../packages/core/src/protocol/relay-executor"

const MERCHANT_SECRET = new Uint8Array(32).fill(31)
const BUYER_SECRET = new Uint8Array(32).fill(32)
const WRAP_SECRET = new Uint8Array(32).fill(33)
const OTHER_SECRET = new Uint8Array(32).fill(34)
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const BUYER = getPublicKey(BUYER_SECRET)
const OTHER = getPublicKey(OTHER_SECRET)
const INBOX = "wss://merchant-recovery.example"
const CREATED_AT = 1_800_000_000_000

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

function recoveryRumor(mnemonic = "synthetic test-only wallet material") {
  return buildCheckoutSparkRecoveryRumor(
    createCheckoutSparkRecoveryPayload({
      plan: plan(),
      senderPubkey: BUYER,
      mnemonic,
      accountNumber: 0,
      preparedAt: CREATED_AT + 1_000,
    })
  )
}

function signedWrap(recipient = MERCHANT, createdAt = CREATED_AT) {
  return finalizeEvent(
    {
      kind: 1_059,
      created_at: Math.floor(createdAt / 1_000),
      tags: [["p", recipient]],
      content: `opaque ciphertext ${createdAt}`,
    },
    WRAP_SECRET
  )
}

function protectedRead(
  events: ReturnType<typeof signedWrap>[],
  input: {
    coverage?: "complete" | "partial" | "unavailable"
    eventCount?: number
    malformedCount?: number
  } = {}
): ProtectedInboxReadResult {
  const coverage = input.coverage ?? "complete"
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
      observations: [],
      relays: [
        {
          relayIndex: 0,
          status: success ? "success" : "partial",
          auth: "not_challenged",
          eventCount: input.eventCount ?? events.length,
          duplicateCount: 0,
          malformedCount: input.malformedCount ?? 0,
          unusableCount: 0,
        },
      ],
      attemptedCount: 1,
      completedCount: success ? 1 : 0,
      failedCount: success ? 0 : 1,
      authoritativeEmpty: success && events.length === 0,
    },
  }
}

function installMerchantSession() {
  installProtectedReadSigner(
    {
      authMethod: "nip07",
      getPublicKey: async () => MERCHANT,
      signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
    },
    MERCHANT,
    () => true
  )
}

function setMerchantSigner(pubkey = MERCHANT) {
  __setCommerceTestOverrides({
    getNdk: async () =>
      ({
        signer: { user: async () => new NDKUser({ pubkey }) } as NDKSigner,
      }) as never,
  })
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
  installMerchantSession()
  setMerchantSigner()
})

afterEach(() => {
  __resetCommerceTestOverrides()
  __resetProtectedReadSigner()
})

describe("Merchant checkout Spark recovery discovery", () => {
  it("narrows the protected relay query to one full signed wrap ID", async () => {
    const wrap = signedWrap()
    let observedFilter: unknown
    const executor = {
      query: async (request: { filters: unknown[] }) => {
        observedFilter = request.filters[0]
        const read = protectedRead([wrap])
        return { ...read.relayResult, events: read.events }
      },
    } as unknown as CommerceRelayExecutor
    const authorization = getProtectedReadAuthorization(MERCHANT)
    expect(authorization).not.toBeNull()

    const result = await readProtectedInbox({
      principalPubkey: MERCHANT,
      relayUrls: [INBOX],
      ownerSelectedRelayUrls: [INBOX],
      appRelayUrls: [],
      eventId: wrap.id,
      limit: 2,
      authorization,
      accountNetworkLocalStateRepository: { get: async () => undefined },
      executor,
    })

    expect(observedFilter).toEqual({
      kinds: [1_059],
      "#p": [MERCHANT],
      ids: [wrap.id],
      limit: 2,
    })
    expect(result.events.map((event) => event.id)).toEqual([wrap.id])
  })

  it("discovers an exact signed wrap after fresh login without using order cache", async () => {
    const wrap = signedWrap()
    const rumor = recoveryRumor()
    let orderCacheReads = 0
    let observedRelays: string[] = []
    let observedAppRelays: readonly string[] | undefined
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) => {
        observedRelays = options.relayUrls
        observedAppRelays = options.appRelayUrls
        expect(options.principalPubkey).toBe(MERCHANT)
        expect(options.ownerSelectedRelayUrls).toEqual([INBOX])
        expect(options.limit).toBe(400)
        return protectedRead([wrap])
      },
      giftUnwrap: async () => rumor,
      getCachedOrderMessages: async () => {
        orderCacheReads += 1
        return []
      },
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(result).toEqual({
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
    expect(observedRelays).toEqual([INBOX])
    expect(observedAppRelays).toEqual([])
    expect(orderCacheReads).toBe(0)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("synthetic test-only wallet material")
    expect(serialized).not.toContain("lnbc-private")
  })

  it("does not fall back to compatibility relays without a declared inbox", async () => {
    let readCalled = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [],
      readProtectedInbox: async () => {
        readCalled = true
        return protectedRead([])
      },
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(result.candidates).toEqual([])
    expect(result.coverage).toBe("unavailable")
    expect(result.declarationState).toBe("not_observed")
    expect(readCalled).toBe(false)
  })

  it("marks a capped or degraded page partial even when a recovery was found", async () => {
    const wrap = signedWrap()
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () =>
        protectedRead([wrap], { eventCount: 400 }),
      giftUnwrap: async () => recoveryRumor(),
    })

    const capped = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(capped.candidates).toHaveLength(1)
    expect(capped.coverage).toBe("partial")

    __setCommerceTestOverrides({
      readProtectedInbox: async () =>
        protectedRead([wrap], { eventCount: 399 }),
    })
    const belowCap = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(belowCap.candidates).toHaveLength(1)
    expect(belowCap.coverage).toBe("complete")

    __setCommerceTestOverrides({
      readProtectedInbox: async () =>
        protectedRead([wrap], { coverage: "partial" }),
    })
    const degraded = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(degraded.candidates).toHaveLength(1)
    expect(degraded.coverage).toBe("partial")

    __setCommerceTestOverrides({
      readProtectedInbox: async () =>
        protectedRead([], { coverage: "unavailable" }),
    })
    const unavailable = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(unavailable.candidates).toEqual([])
    expect(unavailable.coverage).toBe("unavailable")

    __setCommerceTestOverrides({
      readProtectedInbox: async () => protectedRead([], { malformedCount: 1 }),
    })
    const malformedRelay = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    expect(malformedRelay.candidates).toEqual([])
    expect(malformedRelay.coverage).toBe("partial")
  })

  it("limits foreground inspection and reports partial coverage when more wraps are present", async () => {
    const wraps = Array.from({ length: 51 }, (_, index) =>
      signedWrap(MERCHANT, CREATED_AT + index * 1_000)
    )
    let unwrapCount = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead(wraps),
      giftUnwrap: async () => {
        unwrapCount += 1
        return recoveryRumor()
      },
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(unwrapCount).toBe(50)
    expect(result.candidates).toHaveLength(1)
    expect(result.coverage).toBe("partial")
  })

  it("returns partial coverage when one signer unwrap stalls instead of hanging the foreground", async () => {
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([signedWrap()]),
      giftUnwrap: async () => new Promise<never>(() => {}),
    })

    const startedAt = Date.now()
    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(Date.now() - startedAt).toBeLessThan(6_000)
    expect(result.candidates).toEqual([])
    expect(result.coverage).toBe("partial")
  }, 8_000)

  it("rejects a mismatched signer before reading a relay", async () => {
    setMerchantSigner(OTHER)
    let readCalled = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => {
        readCalled = true
        return protectedRead([])
      },
    })

    await expect(
      getMerchantCheckoutSparkRecoveryList(MERCHANT)
    ).rejects.toThrow("authority changed")
    expect(readCalled).toBe(false)
  })

  it("discards results when protected account authority changes during the read", async () => {
    let current = true
    installProtectedReadSigner(
      {
        authMethod: "nip07",
        getPublicKey: async () => MERCHANT,
        signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
      },
      MERCHANT,
      () => current
    )
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => {
        current = false
        return protectedRead([signedWrap()])
      },
      giftUnwrap: async () => recoveryRumor(),
    })

    await expect(
      getMerchantCheckoutSparkRecoveryList(MERCHANT)
    ).rejects.toThrow("authority changed")
  })

  it("discards decrypted recovery material when the account changes after unwrap", async () => {
    let current = true
    installProtectedReadSigner(
      {
        authMethod: "nip07",
        getPublicKey: async () => MERCHANT,
        signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
      },
      MERCHANT,
      () => current
    )
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([signedWrap()]),
      giftUnwrap: async () => {
        current = false
        return recoveryRumor()
      },
    })

    await expect(
      getMerchantCheckoutSparkRecoveryList(MERCHANT)
    ).rejects.toThrow("authority changed")
  })

  it("does not turn an unexpected strict-inspection error into a clean empty result", async () => {
    let signerReads = 0
    __setCommerceTestOverrides({
      getNdk: async () =>
        ({
          signer: {
            user: async () => {
              signerReads += 1
              if (signerReads > 1) throw new Error("signer unavailable")
              return new NDKUser({ pubkey: MERCHANT })
            },
          } as NDKSigner,
        }) as never,
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([signedWrap()]),
      giftUnwrap: async () => recoveryRumor(),
    })

    await expect(
      getMerchantCheckoutSparkRecoveryList(MERCHANT)
    ).rejects.toThrow("signer unavailable")
  })

  it("quarantines invalid outer wraps and decrypt failures without leaking payloads", async () => {
    const wrongRecipient = signedWrap(OTHER)
    const tampered = { ...signedWrap(), content: "changed after signature" }
    const undecipherable = signedWrap(MERCHANT, CREATED_AT + 1_000)
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () =>
        protectedRead([wrongRecipient, tampered, undecipherable]),
      giftUnwrap: async () => null,
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(result.candidates).toEqual([])
    expect(result.coverage).toBe("partial")
    expect(result.malformedCount).toBe(2)
    expect(result.decryptFailureCount).toBe(1)
  })

  it("quarantines conflicting wallet authority for the same checkout", async () => {
    const firstWrap = signedWrap(MERCHANT, CREATED_AT)
    const secondWrap = signedWrap(MERCHANT, CREATED_AT + 1_000)
    const rumors = new Map([
      [firstWrap.id, recoveryRumor("synthetic wallet phrase one")],
      [secondWrap.id, recoveryRumor("synthetic wallet phrase two")],
    ])
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([firstWrap, secondWrap]),
      giftUnwrap: async (event) => rumors.get(event.id) ?? null,
    })

    const result = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    expect(result.candidates).toEqual([])
    expect(result.conflictCount).toBe(1)
    expect(result.coverage).toBe("partial")
    expect(JSON.stringify(result)).not.toContain("phrase")
  })

  it("re-fetches the selected exact signed wrap and gives secrets only to a private adapter", async () => {
    const wrap = signedWrap()
    const observedReads: Array<{
      eventId?: string
      limit: number
      appRelays?: readonly string[]
    }> = []
    let consumed = 0
    let ordinaryCacheReads = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) => {
        observedReads.push({
          eventId: options.eventId,
          limit: options.limit,
          appRelays: options.appRelayUrls,
        })
        return protectedRead([wrap])
      },
      giftUnwrap: async () => recoveryRumor(),
      getCachedOrderMessages: async () => {
        ordinaryCacheReads += 1
        return []
      },
    })
    const discovery = await getMerchantCheckoutSparkRecoveryList(MERCHANT)

    const result = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      discovery.candidates[0]!,
      {
        async consume(payload, assertCurrent) {
          assertCurrent()
          expect(payload.wallet.mnemonic).toBe(
            "synthetic test-only wallet material"
          )
          expect(payload.plan.planDigest).toBe(plan().planDigest)
          consumed += 1
        },
      }
    )

    expect(consumed).toBe(1)
    expect(ordinaryCacheReads).toBe(0)
    expect(observedReads).toEqual([
      { eventId: undefined, limit: 400, appRelays: [] },
      { eventId: undefined, limit: 400, appRelays: [] },
      { eventId: wrap.id, limit: 2, appRelays: [] },
    ])
    expect(result.status).toBe("consumed")
    expect(result.coverage).toBe("complete")
    expect(result.candidate?.wrapId).toBe(wrap.id)
    expect(JSON.stringify(result)).not.toContain("synthetic test-only")
    expect(JSON.stringify(result)).not.toContain("lnbc-private")
  })

  it("does not consume a stale, wrong, or missing exact wrap", async () => {
    const wrap = signedWrap()
    let readCount = 0
    let consumed = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) => {
        readCount += 1
        return options.eventId ? protectedRead([]) : protectedRead([wrap])
      },
      giftUnwrap: async () => recoveryRumor(),
    })
    const discovered = await getMerchantCheckoutSparkRecoveryList(MERCHANT)
    const adapter = {
      async consume() {
        consumed = true
      },
    }
    const wrong = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      { ...discovered.candidates[0]!, wrapId: "a".repeat(64) },
      adapter
    )
    expect(wrong.status).toBe("missing")
    expect(readCount).toBe(2)

    const missing = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      discovered.candidates[0]!,
      adapter
    )
    expect(missing.status).toBe("missing")
    expect(missing.coverage).toBe("complete")
    expect(consumed).toBe(false)
  })

  it("keeps forged, conflicting, and degraded exact reads out of the private adapter", async () => {
    const wrap = signedWrap()
    const altered = { ...wrap, content: "forged ciphertext" }
    let exact = protectedRead([altered])
    let consumed = 0
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async (options) => {
        return options.eventId ? exact : protectedRead([wrap])
      },
      giftUnwrap: async () => recoveryRumor(),
    })
    const adapter = {
      async consume() {
        consumed += 1
      },
    }
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!

    const forged = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(forged.status).toBe("incomplete")
    expect(forged.coverage).toBe("partial")

    exact = protectedRead([wrap, altered], { eventCount: 1 })
    const conflicting = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(conflicting.status).toBe("incomplete")
    expect(conflicting.coverage).toBe("partial")

    exact = protectedRead([signedWrap(MERCHANT, CREATED_AT + 1_000)])
    const wrongId = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(wrongId.status).toBe("incomplete")
    expect(wrongId.coverage).toBe("partial")

    exact = protectedRead([wrap], { coverage: "partial" })
    const degraded = await withMerchantCheckoutSparkRecovery(
      MERCHANT,
      selected,
      adapter
    )
    expect(degraded.status).toBe("incomplete")
    expect(degraded.coverage).toBe("partial")
    expect(consumed).toBe(0)
  })

  it("rejects account changes during exact re-fetch and sanitizes adapter errors", async () => {
    const wrap = signedWrap()
    let current = true
    let readCount = 0
    installProtectedReadSigner(
      {
        authMethod: "nip07",
        getPublicKey: async () => MERCHANT,
        signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
      },
      MERCHANT,
      () => current
    )
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => {
        readCount += 1
        if (readCount === 3) current = false
        return protectedRead([wrap])
      },
      giftUnwrap: async () => recoveryRumor(),
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        async consume() {
          throw new Error("should not run")
        },
      })
    ).rejects.toThrow("authority changed")

    current = true
    readCount = 0
    installMerchantSession()
    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        async consume() {
          throw new Error("synthetic test-only wallet material")
        },
      })
    ).rejects.toThrow("Merchant checkout recovery adapter failed")
  })

  it("discards exact unwrapped material when the Merchant account changes", async () => {
    const wrap = signedWrap()
    let current = true
    let unwrapCount = 0
    let consumed = false
    installProtectedReadSigner(
      {
        authMethod: "nip07",
        getPublicKey: async () => MERCHANT,
        signEvent: async (event) => finalizeEvent(event, MERCHANT_SECRET),
      },
      MERCHANT,
      () => current
    )
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([wrap]),
      giftUnwrap: async () => {
        unwrapCount += 1
        if (unwrapCount === 3) current = false
        return recoveryRumor()
      },
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!

    await expect(
      withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
        async consume() {
          consumed = true
        },
      })
    ).rejects.toThrow("authority changed")
    expect(consumed).toBe(false)
  })

  it("leaves exact recovery partial if a signer unwrap stalls", async () => {
    const wrap = signedWrap()
    let unwrapCount = 0
    let consumed = false
    __setCommerceTestOverrides({
      resolveInboxRelayUrls: async () => [INBOX],
      readProtectedInbox: async () => protectedRead([wrap]),
      giftUnwrap: async () => {
        unwrapCount += 1
        return unwrapCount === 3
          ? new Promise<never>(() => {})
          : recoveryRumor()
      },
    })
    const selected = (await getMerchantCheckoutSparkRecoveryList(MERCHANT))
      .candidates[0]!
    const result = await withMerchantCheckoutSparkRecovery(MERCHANT, selected, {
      async consume() {
        consumed = true
      },
    })
    expect(result.status).toBe("incomplete")
    expect(result.coverage).toBe("partial")
    expect(consumed).toBe(false)
  }, 8_000)
})
