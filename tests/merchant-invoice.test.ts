import { describe, expect, it, mock } from "bun:test"

import { db } from "../packages/core/src/db"
import { getNwcConnectionFingerprint } from "../packages/core/src/protocol/nwc"
import type { PublishMerchantOrderMessageInput } from "../packages/core/src/protocol/merchant-order-publish"
import {
  createMerchantInvoiceDiscardMutationFn,
  createMerchantInvoiceMutationFn,
  createMerchantInvoiceModule as createMerchantInvoiceModuleImpl,
  createMerchantPendingInvoiceQueryFn,
  DexieMerchantPendingInvoiceStore,
  MerchantInvoiceMutationError,
  MerchantPendingInvoiceQueryError,
  sanitizeMerchantInvoiceMutationResult,
  type MerchantInvoiceLockManager,
  type MerchantPendingInvoice,
  type MerchantPendingInvoiceStore,
} from "../apps/merchant/src/lib/merchant-invoice"
import {
  bolt11DescriptionHashField,
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const MERCHANT_PUBKEY = "a".repeat(64)
const BUYER_PUBKEY = "b".repeat(64)
const ORDER_ID = "order-239"
const MOCKED_NWC_CONNECTION_TOKEN = "non-credential test sentinel"
const INVOICE = makeBolt11Fixture({
  fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField()],
})
const NEXT_INVOICE = makeBolt11Fixture({
  fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField("next")],
  createdAt: 1_800_004_000,
})
const SECOND_ACTIVE_INVOICE = makeBolt11Fixture({
  fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField("second")],
  createdAt: 1_800_000_001,
})
const AMOUNTLESS_INVOICE = makeBolt11Fixture({
  fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField()],
  hrp: "lnbc",
})
const TESTNET_INVOICE = makeBolt11Fixture({
  fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField()],
  hrp: "lntb500n",
})
const COMPLETE_EMPTY_INVOICE_HISTORY = {
  readState: "complete",
  paymentRequests: [],
} as const
const PROFILE_FRONTIER_1 = "1".repeat(64)
const PROFILE_FRONTIER_2 = "2".repeat(64)

function conversationInvoiceRequest(
  invoice = INVOICE,
  overrides: Partial<{
    messageId: string
    merchantPubkey: string
    buyerPubkey: string
    orderId: string
    createdAt: number
    amountSats: number
    currency: string
    note: string
  }> = {}
) {
  return {
    messageId: "payment-request-1",
    merchantPubkey: MERCHANT_PUBKEY,
    buyerPubkey: BUYER_PUBKEY,
    orderId: ORDER_ID,
    createdAt: 1_800_000_000,
    invoice,
    amountSats: 50,
    currency: "SATS",
    ...overrides,
  }
}

function completeInvoiceHistory(
  ...paymentRequests: ReturnType<typeof conversationInvoiceRequest>[]
) {
  return { readState: "complete" as const, paymentRequests }
}

type TestMerchantInvoiceDependencies = Omit<
  Parameters<typeof createMerchantInvoiceModuleImpl>[0],
  "refreshConversationEvidence"
> &
  Partial<
    Pick<
      Parameters<typeof createMerchantInvoiceModuleImpl>[0],
      "refreshConversationEvidence"
    >
  >

function createMerchantInvoiceModule(
  dependencies: TestMerchantInvoiceDependencies
) {
  const module = createMerchantInvoiceModuleImpl({
    refreshConversationEvidence: mock(
      async () => COMPLETE_EMPTY_INVOICE_HISTORY
    ),
    ...dependencies,
  })
  return {
    ...module,
    deliver(input: Parameters<typeof module.deliver>[0]) {
      return module.deliver(
        !("conversationEvidence" in input)
          ? {
              ...input,
              conversationEvidence: COMPLETE_EMPTY_INVOICE_HISTORY,
            }
          : input
      )
    },
  }
}

class MemoryPendingInvoiceStore implements MerchantPendingInvoiceStore {
  readonly rows = new Map<string, MerchantPendingInvoice>()

  async get(
    merchantPubkey: string,
    orderId: string
  ): Promise<MerchantPendingInvoice | null> {
    return this.rows.get(`${merchantPubkey}:${orderId}`) ?? null
  }

  async put(invoice: MerchantPendingInvoice): Promise<void> {
    this.rows.set(invoice.id, structuredClone(invoice))
  }

  async delete(merchantPubkey: string, orderId: string): Promise<void> {
    this.rows.delete(`${merchantPubkey}:${orderId}`)
  }
}

class MemoryInvoiceLockManager implements MerchantInvoiceLockManager {
  readonly #held = new Set<string>()

  async request<T>(
    name: string,
    _options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => T | Promise<T>
  ): Promise<T> {
    if (this.#held.has(name)) return callback(null)
    this.#held.add(name)
    try {
      return await callback({ name })
    } finally {
      this.#held.delete(name)
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function savedInvoice(
  overrides: Partial<MerchantPendingInvoice> = {}
): MerchantPendingInvoice {
  return {
    id: `${MERCHANT_PUBKEY}:${ORDER_ID}`,
    merchantPubkey: MERCHANT_PUBKEY,
    buyerPubkey: BUYER_PUBKEY,
    orderId: ORDER_ID,
    invoice: INVOICE,
    paymentHash: "07".repeat(32),
    amountMsats: 50_000,
    delivery: "buyer_and_self",
    source: "profile_lud16",
    paymentAuthority: {
      type: "profile_lud16",
      lud16: "merchant@pay.example",
      profileFrontierEventId: null,
    },
    invoiceCreatedAt: 1_800_000_000,
    invoiceExpiresAt: 1_800_003_600,
    deliveryState: "pending",
    deliveryAttemptCount: 1,
    savedAt: 1_799_999_000_000,
    ...overrides,
  }
}

function createTestModule(
  store: MerchantPendingInvoiceStore,
  overrides: Partial<Parameters<typeof createMerchantInvoiceModule>[0]> = {}
) {
  return createMerchantInvoiceModule({
    store,
    fetchLnurlPayMetadata: mock(async () => ({
      payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
      lnurl: "lnurl1example",
      callback: "https://pay.example/callback",
      minSendable: 1_000,
      maxSendable: 100_000,
      tag: "payRequest",
      allowsNostr: false,
      metadata: "[]",
    })),
    fetchLnurlInvoice: mock(async () => ({ invoice: INVOICE })),
    makeWeblnInvoice: mock(async () => ({ invoice: INVOICE })),
    getNwcInfo: mock(async () => ({
      methods: ["make_invoice"],
      lud16: "merchant@pay.example",
    })),
    makeNwcInvoice: mock(async () => ({ invoice: INVOICE })),
    makeMockInvoice: mock(() => ({ invoice: INVOICE })),
    isMockPayments: () => false,
    resolveProfileLud16: mock(async () => "merchant@pay.example"),
    publish: mock(async () => undefined),
    now: () => 1_799_999_000_000,
    ...overrides,
  })
}

describe("merchant invoice delivery", () => {
  it("registers an account and order scoped durable pending-invoice store", () => {
    expect(db.verno).toBe(15)
    expect(db.merchantPendingInvoices.schema.primKey.name).toBe("id")
    expect(
      db.merchantPendingInvoices.schema.indexes.map((index) => index.name)
    ).toEqual(
      expect.arrayContaining([
        "merchantPubkey",
        "orderId",
        "deliveryState",
        "invoiceExpiresAt",
      ])
    )
  })

  it("hydrates the exact pending invoice through a recreated durable store adapter", async () => {
    const rows = new Map<string, MerchantPendingInvoice>()
    const table = {
      async get(id: string) {
        return rows.get(id)
      },
      async put(record: MerchantPendingInvoice) {
        rows.set(record.id, structuredClone(record))
      },
      async delete(id: string) {
        rows.delete(id)
      },
    }
    const beforeReload = new DexieMerchantPendingInvoiceStore(table)
    const recovered = savedInvoice({
      source: "conversation_recovery",
      paymentAuthority: undefined,
    })
    await beforeReload.put(recovered)

    const afterReload = new DexieMerchantPendingInvoiceStore(table)
    await expect(
      afterReload.get(MERCHANT_PUBKEY.toUpperCase(), ` ${ORDER_ID} `)
    ).resolves.toEqual(recovered)
  })

  it("rejects impossible pending and relay-accepted checkpoint states", async () => {
    const relayAcceptedWithoutAttempt = savedInvoice({
      deliveryState: "relay_accepted",
      deliveryAttemptCount: 0,
      relayAcceptedAt: 1_799_999_000_100,
    })
    const relayAcceptedWithoutTimestamp = savedInvoice({
      deliveryState: "relay_accepted",
      deliveryAttemptCount: 1,
    })
    delete relayAcceptedWithoutTimestamp.relayAcceptedAt
    const pendingWithAcceptanceTimestamp = savedInvoice({
      deliveryState: "pending",
      relayAcceptedAt: 1_799_999_000_100,
    })

    for (const record of [
      relayAcceptedWithoutAttempt,
      relayAcceptedWithoutTimestamp,
      pendingWithAcceptanceTimestamp,
    ]) {
      const store = new DexieMerchantPendingInvoiceStore({
        async get() {
          return record
        },
        async put() {},
        async delete() {},
      })
      await expect(store.get(MERCHANT_PUBKEY, ORDER_ID)).resolves.toBeNull()
    }
  })

  it("recovers a signed live invoice after storage reset and retries it byte-for-byte", async () => {
    const store = new MemoryPendingInvoiceStore()
    const fetchLnurlInvoice = mock(async () => ({ invoice: NEXT_INVOICE }))
    const makeWeblnInvoice = mock(async () => ({ invoice: NEXT_INVOICE }))
    const makeNwcInvoice = mock(async () => ({ invoice: NEXT_INVOICE }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      fetchLnurlInvoice,
      makeWeblnInvoice,
      makeNwcInvoice,
      publish,
    })
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await expect(
      module.getPending({
        ...scope,
        conversationEvidence: completeInvoiceHistory(
          conversationInvoiceRequest()
        ),
      })
    ).resolves.toMatchObject({
      invoice: INVOICE,
      source: "conversation_recovery",
      deliveryState: "pending",
      deliveryAttemptCount: 0,
    })
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(0)
    expect(makeWeblnInvoice).toHaveBeenCalledTimes(0)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(0)

    await expect(
      module.deliver({ mode: "retry", ...scope })
    ).resolves.toMatchObject({
      invoice: INVOICE,
      source: "conversation_recovery",
      reused: true,
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      payload: { invoice: INVOICE },
    })
  })

  it("blocks a saved invoice when another client signed a distinct live invoice", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(savedInvoice())
    const publish = mock(async () => undefined)
    const module = createTestModule(store, { publish })
    const conflictingEvidence = completeInvoiceHistory(
      conversationInvoiceRequest(SECOND_ACTIVE_INVOICE, {
        messageId: "other-client-payment-request",
      })
    )
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await expect(
      module.getPending({
        ...scope,
        conversationEvidence: conflictingEvidence,
      })
    ).rejects.toThrow(/different payable invoice/i)
    await expect(
      module.deliver({
        mode: "retry",
        ...scope,
        conversationEvidence: conflictingEvidence,
      })
    ).rejects.toThrow(/different payable invoice/i)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("keeps an exact saved invoice retryable with matching positive partial history", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(savedInvoice())
    const publish = mock(async () => undefined)
    const module = createTestModule(store, { publish })
    const matchingPartialEvidence = {
      readState: "incomplete" as const,
      paymentRequests: [
        conversationInvoiceRequest(INVOICE.toUpperCase(), {
          messageId: "matching-payment-request",
        }),
      ],
    }
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await expect(
      module.getPending({
        ...scope,
        conversationEvidence: matchingPartialEvidence,
      })
    ).resolves.toMatchObject({ invoice: INVOICE })
    await expect(
      module.deliver({
        mode: "retry",
        ...scope,
        conversationEvidence: matchingPartialEvidence,
      })
    ).resolves.toMatchObject({ invoice: INVOICE, reused: true })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("blocks a pending saved invoice when partial history has no signed match", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(savedInvoice())
    const publish = mock(async () => undefined)
    const partialEvidence = {
      readState: "incomplete" as const,
      paymentRequests: [],
    }
    const module = createTestModule(store, {
      publish,
      refreshConversationEvidence: mock(async () => partialEvidence),
    })

    await expect(
      module.getPending({
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: partialEvidence,
      })
    ).resolves.toMatchObject({
      deliveryState: "pending",
      invoice: INVOICE,
    })

    await expect(
      module.deliver({
        mode: "retry",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: partialEvidence,
      })
    ).rejects.toThrow(/history is incomplete/i)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("rechecks current signed history inside the retry lock", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(savedInvoice())
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      publish,
      refreshConversationEvidence: mock(async () =>
        completeInvoiceHistory(
          conversationInvoiceRequest(SECOND_ACTIVE_INVOICE, {
            messageId: "newer-other-client-request",
          })
        )
      ),
    })

    await expect(
      module.deliver({
        mode: "retry",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        // This render-time snapshot is deliberately stale.
        conversationEvidence: COMPLETE_EMPTY_INVOICE_HISTORY,
      })
    ).rejects.toThrow(/different payable invoice/i)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("allows an accepted checkpoint retry when partial history is empty", async () => {
    const store = new MemoryPendingInvoiceStore()
    const partialEvidence = {
      readState: "incomplete" as const,
      paymentRequests: [],
    }
    await store.put(
      savedInvoice({
        deliveryState: "relay_accepted",
        relayAcceptedAt: 1_799_999_000_100,
      })
    )
    const publish = mock(async (input: PublishMerchantOrderMessageInput) => {
      await input.revalidateBeforeDelivery?.("sender_self_copy")
      await input.revalidateBeforeDelivery?.("recipient")
    })
    const refreshConversationEvidence = mock(async () => partialEvidence)
    const module = createTestModule(store, {
      publish,
      refreshConversationEvidence,
    })

    await expect(
      module.deliver({
        mode: "retry",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: partialEvidence,
      })
    ).resolves.toMatchObject({ reused: true, relayAcceptance: "accepted" })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(refreshConversationEvidence).toHaveBeenCalledTimes(1)
  })

  it("fails closed when exact signed history beside a saved invoice is invalid", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(savedInvoice())
    const module = createTestModule(store)

    await expect(
      module.getPending({
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: completeInvoiceHistory(
          conversationInvoiceRequest("not-an-invoice")
        ),
      })
    ).rejects.toThrow(/signed invoice history/i)
  })

  it("rechecks newly observed signed history inside the create lock before provider issuance", async () => {
    const store = new MemoryPendingInvoiceStore()
    const fetchLnurlInvoice = mock(async () => ({ invoice: NEXT_INVOICE }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, { fetchLnurlInvoice, publish })
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await expect(
      module.getPending({
        ...scope,
        conversationEvidence: COMPLETE_EMPTY_INVOICE_HISTORY,
      })
    ).resolves.toBeNull()
    await expect(
      module.deliver({
        mode: "create",
        ...scope,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
        conversationEvidence: completeInvoiceHistory(
          conversationInvoiceRequest()
        ),
      })
    ).rejects.toThrow(/recovered from this order/i)
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(0)
    expect(publish).toHaveBeenCalledTimes(0)
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      invoice: INVOICE,
      source: "conversation_recovery",
    })
  })

  it("rechecks signed history after provider issuance before saving", async () => {
    const store = new MemoryPendingInvoiceStore()
    let currentEvidence = COMPLETE_EMPTY_INVOICE_HISTORY
    const fetchLnurlInvoice = mock(async () => {
      currentEvidence = completeInvoiceHistory(
        conversationInvoiceRequest(SECOND_ACTIVE_INVOICE, {
          messageId: "other-client-payment-request",
        })
      )
      return { invoice: INVOICE }
    })
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      fetchLnurlInvoice,
      publish,
      refreshConversationEvidence: mock(async () => currentEvidence),
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
        conversationEvidence: COMPLETE_EMPTY_INVOICE_HISTORY,
      })
    ).rejects.toThrow(/payable invoice appeared/i)
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(1)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("allows one replacement only after every exact signed invoice is proven expired", async () => {
    const store = new MemoryPendingInvoiceStore()
    const fetchLnurlInvoice = mock(async () => ({ invoice: NEXT_INVOICE }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      fetchLnurlInvoice,
      publish,
      now: () => 1_800_004_001_000,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
        conversationEvidence: completeInvoiceHistory(
          conversationInvoiceRequest()
        ),
      })
    ).resolves.toMatchObject({
      invoice: NEXT_INVOICE,
      source: "profile_lud16",
      reused: false,
    })
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("fails closed on malformed, amountless, wrong-network, or amount-mismatched history", async () => {
    const unsafeRequests = [
      conversationInvoiceRequest("not-an-invoice"),
      conversationInvoiceRequest(AMOUNTLESS_INVOICE),
      conversationInvoiceRequest(TESTNET_INVOICE),
      conversationInvoiceRequest(INVOICE, { amountSats: 49 }),
    ]

    for (const request of unsafeRequests) {
      const store = new MemoryPendingInvoiceStore()
      const fetchLnurlInvoice = mock(async () => ({ invoice: NEXT_INVOICE }))
      const publish = mock(async () => undefined)
      const module = createTestModule(store, { fetchLnurlInvoice, publish })
      await expect(
        module.deliver({
          mode: "create",
          merchantPubkey: MERCHANT_PUBKEY,
          buyerPubkey: BUYER_PUBKEY,
          orderId: ORDER_ID,
          amountSats: 50,
          delivery: "buyer_and_self",
          source: { type: "profile_lud16" },
          conversationEvidence: completeInvoiceHistory(request),
        })
      ).rejects.toThrow(/signed invoice history/i)
      expect(fetchLnurlInvoice).toHaveBeenCalledTimes(0)
      expect(publish).toHaveBeenCalledTimes(0)
      expect(store.rows.size).toBe(0)
    }
  })

  it("deduplicates identical history but blocks multiple distinct live invoices", async () => {
    const duplicateStore = new MemoryPendingInvoiceStore()
    const duplicateModule = createTestModule(duplicateStore)
    await expect(
      duplicateModule.getPending({
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: completeInvoiceHistory(
          conversationInvoiceRequest(),
          conversationInvoiceRequest(INVOICE, {
            messageId: "payment-request-duplicate",
            createdAt: 1_800_000_001,
          })
        ),
      })
    ).resolves.toMatchObject({ invoice: INVOICE })

    const conflictingStore = new MemoryPendingInvoiceStore()
    const fetchLnurlInvoice = mock(async () => ({ invoice: NEXT_INVOICE }))
    const conflictingModule = createTestModule(conflictingStore, {
      fetchLnurlInvoice,
    })
    await expect(
      conflictingModule.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
        conversationEvidence: completeInvoiceHistory(
          conversationInvoiceRequest(),
          conversationInvoiceRequest(SECOND_ACTIVE_INVOICE, {
            messageId: "payment-request-2",
            createdAt: 1_800_000_001,
          })
        ),
      })
    ).rejects.toThrow(/multiple payable invoices/i)
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(0)
  })

  it("deduplicates the same signed invoice across valid BOLT11 letter casing", async () => {
    const module = createTestModule(new MemoryPendingInvoiceStore())

    await expect(
      module.getPending({
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: completeInvoiceHistory(
          conversationInvoiceRequest(INVOICE),
          conversationInvoiceRequest(INVOICE.toUpperCase(), {
            messageId: "uppercase-payment-request",
          })
        ),
      })
    ).resolves.toMatchObject({ invoice: INVOICE.toUpperCase() })
  })

  it("surfaces content-free query states for signed-history conflicts", async () => {
    const module = createTestModule(new MemoryPendingInvoiceStore())
    const query = createMerchantPendingInvoiceQueryFn(() =>
      module.getPending({
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: completeInvoiceHistory(
          conversationInvoiceRequest(),
          conversationInvoiceRequest(SECOND_ACTIVE_INVOICE, {
            messageId: "payment-request-2",
          })
        ),
      })
    )

    try {
      await query()
      throw new Error("Expected signed-history conflict")
    } catch (error) {
      expect(error).toBeInstanceOf(MerchantPendingInvoiceQueryError)
      expect((error as MerchantPendingInvoiceQueryError).code).toBe(
        "history_conflict"
      )
      expect((error as Error).message).toMatch(/resolve the order/i)
      const visible = JSON.stringify(error)
      expect(visible).not.toContain(INVOICE)
      expect(visible).not.toContain(SECOND_ACTIVE_INVOICE)
      expect(visible).not.toContain(ORDER_ID)
      expect(visible).not.toContain(MERCHANT_PUBKEY)
      expect(visible).not.toContain(BUYER_PUBKEY)
    }
  })

  it("ignores wrong-scope requests but requires a complete read before fresh issuance", async () => {
    const wrongScope = conversationInvoiceRequest(INVOICE, {
      merchantPubkey: "c".repeat(64),
    })
    const incompleteStore = new MemoryPendingInvoiceStore()
    const incompleteFetch = mock(async () => ({ invoice: NEXT_INVOICE }))
    const incompleteModule = createTestModule(incompleteStore, {
      fetchLnurlInvoice: incompleteFetch,
    })
    await expect(
      incompleteModule.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
        conversationEvidence: {
          readState: "incomplete",
          paymentRequests: [wrongScope],
        },
      })
    ).rejects.toThrow(/history is incomplete/i)
    expect(incompleteFetch).toHaveBeenCalledTimes(0)

    const completeStore = new MemoryPendingInvoiceStore()
    const completeFetch = mock(async () => ({ invoice: INVOICE }))
    const completeModule = createTestModule(completeStore, {
      fetchLnurlInvoice: completeFetch,
    })
    await expect(
      completeModule.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
        conversationEvidence: completeInvoiceHistory(wrongScope),
      })
    ).resolves.toMatchObject({ source: "profile_lud16" })
    expect(completeFetch).toHaveBeenCalledTimes(1)
  })

  it("uses the configured profile address and saves the validated invoice before delivery", async () => {
    const store = new MemoryPendingInvoiceStore()
    const operations: string[] = []
    const fetchLnurlPayMetadata = mock(async () => ({
      payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
      lnurl: "lnurl1example",
      callback: "https://pay.example/callback",
      minSendable: 1_000,
      maxSendable: 100_000,
      tag: "payRequest",
      allowsNostr: true,
      metadata: "[]",
    }))
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const resolveProfileLud16 = mock(async () => "merchant@pay.example")
    const module = createMerchantInvoiceModule({
      store,
      fetchLnurlPayMetadata,
      fetchLnurlInvoice,
      makeWeblnInvoice: mock(async () => ({ invoice: INVOICE })),
      makeNwcInvoice: mock(async () => ({ invoice: INVOICE })),
      makeMockInvoice: mock(() => ({ invoice: INVOICE })),
      isMockPayments: () => false,
      resolveProfileLud16,
      publish: mock(async () => {
        operations.push("publish")
        expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
          invoice: INVOICE,
          source: "profile_lud16",
          amountMsats: 50_000,
        })
      }),
      now: () => 1_799_999_000_000,
    })

    const result = await module.deliver({
      mode: "create",
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
      amountSats: 50,
      note: "Thanks",
      delivery: "buyer_and_self",
      source: { type: "profile_lud16" },
    })

    expect(resolveProfileLud16).toHaveBeenCalledWith(MERCHANT_PUBKEY)
    expect(fetchLnurlPayMetadata).toHaveBeenCalledWith("merchant@pay.example")
    expect(fetchLnurlInvoice).toHaveBeenCalledWith(
      "https://pay.example/callback",
      50_000
    )
    expect(operations).toEqual(["publish"])
    expect(result).toMatchObject({
      invoice: INVOICE,
      source: "profile_lud16",
      reused: false,
    })
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      invoice: INVOICE,
      deliveryState: "relay_accepted",
    })
  })

  it("rejects a profile invoice request outside the provider range", async () => {
    const store = new MemoryPendingInvoiceStore()
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const publish = mock(async () => undefined)
    const module = createMerchantInvoiceModule({
      store,
      fetchLnurlPayMetadata: mock(async () => ({
        payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
        lnurl: "lnurl1example",
        callback: "https://pay.example/callback",
        minSendable: 60_000,
        maxSendable: 100_000,
        tag: "payRequest",
        allowsNostr: false,
        metadata: "[]",
      })),
      fetchLnurlInvoice,
      makeWeblnInvoice: mock(async () => ({ invoice: INVOICE })),
      makeNwcInvoice: mock(async () => ({ invoice: INVOICE })),
      makeMockInvoice: mock(() => ({ invoice: INVOICE })),
      isMockPayments: () => false,
      resolveProfileLud16: mock(async () => "merchant@pay.example"),
      publish,
      now: () => 1_799_999_000_000,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow(/does not accept this invoice amount/)
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(0)
    expect(publish).toHaveBeenCalledTimes(0)
    expect(store.rows.size).toBe(0)
  })

  it("fails closed before LNURL issuance when current profile authority is unavailable", async () => {
    const store = new MemoryPendingInvoiceStore()
    const resolveProfileLud16 = mock(async () => {
      throw new Error("Current signed payment destination is unavailable.")
    })
    const fetchLnurlPayMetadata = mock(async () => {
      throw new Error("LNURL must not run without current profile authority.")
    })
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      resolveProfileLud16,
      fetchLnurlPayMetadata,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow(/current signed payment destination is unavailable/i)
    expect(resolveProfileLud16).toHaveBeenCalledWith(MERCHANT_PUBKEY)
    expect(fetchLnurlPayMetadata).toHaveBeenCalledTimes(0)
    expect(publish).toHaveBeenCalledTimes(0)
    expect(store.rows.size).toBe(0)
  })

  it("revalidates the exact profile frontier after LNURL issuance before saving", async () => {
    const store = new MemoryPendingInvoiceStore()
    let frontierEventId = PROFILE_FRONTIER_1
    const resolveProfileLud16 = mock(async () => ({
      lud16: "merchant@pay.example",
      frontierEventId,
    }))
    const fetchLnurlInvoice = mock(async () => {
      // Simulate a same-address signed profile replacement while the remote
      // callback is issuing the invoice. Exact event authority must still move.
      frontierEventId = PROFILE_FRONTIER_2
      return { invoice: INVOICE }
    })
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      resolveProfileLud16,
      fetchLnurlInvoice,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow(/profile payment destination changed/i)
    expect(resolveProfileLud16).toHaveBeenCalledTimes(2)
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(1)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("revalidates profile authority after the final signed-history refresh", async () => {
    const store = new MemoryPendingInvoiceStore()
    let frontierEventId = PROFILE_FRONTIER_1
    const resolveProfileLud16 = mock(async () => ({
      lud16: "merchant@pay.example",
      frontierEventId,
    }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      resolveProfileLud16,
      refreshConversationEvidence: mock(async () => {
        frontierEventId = PROFILE_FRONTIER_2
        return COMPLETE_EMPTY_INVOICE_HISTORY
      }),
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow(/profile payment destination changed/i)
    expect(resolveProfileLud16).toHaveBeenCalledTimes(2)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("rejects an invoice that expires during the final signed-history refresh", async () => {
    const store = new MemoryPendingInvoiceStore()
    let now = 1_800_003_599_000
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      now: () => now,
      refreshConversationEvidence: mock(async () => {
        now = 1_800_003_601_000
        return COMPLETE_EMPTY_INVOICE_HISTORY
      }),
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow(/already expired/i)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("rechecks expiry at the critical relay boundary", async () => {
    const store = new MemoryPendingInvoiceStore()
    let now = 1_800_003_599_000
    const publish = mock(async (input: PublishMerchantOrderMessageInput) => {
      now = 1_800_003_601_000
      await input.revalidateBeforeDelivery?.("sender_self_copy")
    })
    const module = createTestModule(store, { now: () => now, publish })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow(/already expired/i)
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      deliveryState: "pending",
      lastFailureCode: "relay_delivery_failed",
    })
  })

  it("retains the exact validated invoice when delivery fails", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => {
      throw new Error("relay delivery failed")
    })
    const module = createMerchantInvoiceModule({
      store,
      fetchLnurlPayMetadata: mock(async () => ({
        payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
        lnurl: "lnurl1example",
        callback: "https://pay.example/callback",
        minSendable: 1_000,
        maxSendable: 100_000,
        tag: "payRequest",
        allowsNostr: false,
        metadata: "[]",
      })),
      fetchLnurlInvoice: mock(async () => ({ invoice: INVOICE })),
      makeWeblnInvoice: mock(async () => ({ invoice: INVOICE })),
      makeNwcInvoice: mock(async () => ({ invoice: INVOICE })),
      makeMockInvoice: mock(() => ({ invoice: INVOICE })),
      isMockPayments: () => false,
      resolveProfileLud16: mock(async () => "merchant@pay.example"),
      publish,
      now: () => 1_799_999_000_000,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow("relay delivery failed")

    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      invoice: INVOICE,
      deliveryState: "pending",
      deliveryAttemptCount: 1,
      lastFailureCode: "relay_delivery_failed",
    })
  })

  it("retries the saved invoice without asking an issuer for another one", async () => {
    const store = new MemoryPendingInvoiceStore()
    let shouldFail = true
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const publish = mock(async () => {
      if (shouldFail) throw new Error("relay delivery failed")
    })
    const dependencies = {
      store,
      fetchLnurlPayMetadata: mock(async () => ({
        payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
        lnurl: "lnurl1example",
        callback: "https://pay.example/callback",
        minSendable: 1_000,
        maxSendable: 100_000,
        tag: "payRequest",
        allowsNostr: false,
        metadata: "[]",
      })),
      fetchLnurlInvoice,
      makeWeblnInvoice: mock(async () => ({ invoice: INVOICE })),
      makeNwcInvoice: mock(async () => ({ invoice: INVOICE })),
      makeMockInvoice: mock(() => ({ invoice: INVOICE })),
      isMockPayments: () => false,
      resolveProfileLud16: mock(async () => "merchant@pay.example"),
      publish,
      now: () => 1_799_999_000_000,
    }
    const module = createMerchantInvoiceModule(dependencies)
    const createInput = {
      mode: "create" as const,
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
      amountSats: 50,
      delivery: "buyer_and_self" as const,
      source: {
        type: "profile_lud16" as const,
      },
    }

    await expect(module.deliver(createInput)).rejects.toThrow(
      "relay delivery failed"
    )
    shouldFail = false
    const reloadedModule = createMerchantInvoiceModule(dependencies)
    const result = await reloadedModule.deliver({
      mode: "retry",
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    })

    expect(result).toEqual({
      invoice: INVOICE,
      source: "profile_lud16",
      reused: true,
      relayAcceptance: "accepted",
    })
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      invoice: INVOICE,
      deliveryState: "relay_accepted",
    })
  })

  it("refuses to retry an order-scoped invoice for a different buyer", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(savedInvoice())
    const publish = mock(async () => undefined)
    const module = createTestModule(store, { publish })

    await expect(
      module.deliver({
        mode: "retry",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: "c".repeat(64),
        orderId: ORDER_ID,
      })
    ).rejects.toThrow(/different buyer/)
    expect(publish).toHaveBeenCalledTimes(0)
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toEqual(savedInvoice())
  })

  it("keeps an expired invoice blocked until the merchant explicitly discards it", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(savedInvoice())
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      publish,
      now: () => 1_800_003_601_000,
    })
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await expect(module.deliver({ mode: "retry", ...scope })).rejects.toThrow(
      /already expired/
    )
    expect(await module.getPending(scope)).toMatchObject({ invoice: INVOICE })
    expect(publish).toHaveBeenCalledTimes(0)

    await module.discardExpired(scope)
    expect(await module.getPending(scope)).toBeNull()
  })

  it("rejects a saved invoice that expires during its fresh history read", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(
      savedInvoice({ source: "manual", paymentAuthority: undefined })
    )
    let now = 1_800_003_599_000
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      now: () => now,
      refreshConversationEvidence: mock(async () => {
        now = 1_800_003_601_000
        return COMPLETE_EMPTY_INVOICE_HISTORY
      }),
      publish,
    })

    await expect(
      module.deliver({
        mode: "retry",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: COMPLETE_EMPTY_INVOICE_HISTORY,
      })
    ).rejects.toThrow(/already expired/i)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("retains acknowledged delivery as a durable idempotency tombstone", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => undefined)
    const module = createTestModule(store, { publish })
    const input = {
      mode: "create" as const,
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
      amountSats: 50,
      delivery: "buyer_and_self" as const,
      source: { type: "manual" as const, invoice: INVOICE },
    }

    await expect(module.deliver(input)).resolves.toMatchObject({
      invoice: INVOICE,
      source: "manual",
    })
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      deliveryState: "relay_accepted",
      deliveryAttemptCount: 1,
    })
    expect(
      await module.getPending({
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
      })
    ).toMatchObject({
      invoice: INVOICE,
      deliveryState: "relay_accepted",
    })
    await expect(
      module.discardExpired({
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
      })
    ).rejects.toThrow(/not expired/i)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("redelivers an accepted invoice without issuing a replacement", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(
      savedInvoice({
        deliveryState: "relay_accepted",
        relayAcceptedAt: 1_799_999_000_100,
      })
    )
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, { fetchLnurlInvoice, publish })
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await expect(module.deliver({ mode: "retry", ...scope })).resolves.toEqual({
      invoice: INVOICE,
      source: "profile_lud16",
      reused: true,
      relayAcceptance: "accepted",
    })
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(0)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      invoice: INVOICE,
      deliveryState: "relay_accepted",
      deliveryAttemptCount: 2,
    })
  })

  it("preserves the accepted tombstone when redelivery fails", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(
      savedInvoice({
        deliveryState: "relay_accepted",
        relayAcceptedAt: 1_799_999_000_100,
      })
    )
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const publish = mock(async () => {
      throw new Error("relay delivery failed")
    })
    const module = createTestModule(store, { fetchLnurlInvoice, publish })
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await expect(module.deliver({ mode: "retry", ...scope })).rejects.toThrow(
      "relay delivery failed"
    )
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(0)
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      invoice: INVOICE,
      deliveryState: "relay_accepted",
      deliveryAttemptCount: 2,
      lastFailureCode: "relay_delivery_failed",
    })
  })

  it("allows an expired accepted tombstone to be discarded", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(
      savedInvoice({
        deliveryState: "relay_accepted",
        relayAcceptedAt: 1_799_999_000_100,
      })
    )
    const module = createTestModule(store, {
      now: () => 1_800_003_601_000,
    })
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await module.discardExpired(scope)
    await expect(module.getPending(scope)).resolves.toBeNull()
  })

  it("blocks a stale tab after another tab durably accepts the invoice", async () => {
    const store = new MemoryPendingInvoiceStore()
    const locks = new MemoryInvoiceLockManager()
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const publish = mock(async () => undefined)
    const overrides = {
      fetchLnurlInvoice,
      publish,
      lockManager: locks,
      requireCrossContextLock: true,
    }
    const firstTab = createTestModule(store, overrides)
    const staleTab = createTestModule(store, overrides)
    const input = {
      mode: "create" as const,
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
      amountSats: 50,
      delivery: "buyer_and_self" as const,
      source: { type: "profile_lud16" as const },
    }

    await expect(firstTab.deliver(input)).resolves.toMatchObject({
      reused: false,
      relayAcceptance: "accepted",
    })
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      deliveryState: "relay_accepted",
    })

    await expect(staleTab.deliver(input)).rejects.toThrow(
      /already reached a recipient relay/i
    )
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      deliveryState: "relay_accepted",
    })
  })

  it("still validates a manually pasted invoice in mock configuration", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      isMockPayments: () => true,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: "not-a-bolt11-invoice" },
      })
    ).rejects.toThrow(/invoice format|structurally valid/i)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("rejects a manually pasted invoice for the wrong amount", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => undefined)
    const wrongAmountInvoice = makeBolt11Fixture({
      hrp: "lnbc600n",
      fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField()],
    })
    const module = createTestModule(store, { publish })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: wrongAmountInvoice },
      })
    ).rejects.toThrow(/amount does not match/i)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("rejects a manually pasted invoice for the wrong network", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => undefined)
    const wrongNetworkInvoice = makeBolt11Fixture({
      hrp: "lntb500n",
      fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField()],
    })
    const module = createTestModule(store, { publish })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: wrongNetworkInvoice },
      })
    ).rejects.toThrow(/different Lightning network|invoice is for testnet/i)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("rejects an already-expired manually pasted invoice", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => undefined)
    const expiredInvoice = makeBolt11Fixture({
      createdAt: 1_799_990_000,
      fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField()],
    })
    const module = createTestModule(store, { publish })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: expiredInvoice },
      })
    ).rejects.toThrow(/already expired/i)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("rejects a checksummed invoice that lacks required BOLT11 structure", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => undefined)
    const structurallyIncomplete = makeBolt11Fixture({
      fields: [bolt11PlainDescriptionField()],
    })
    const module = createTestModule(store, { publish })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: structurallyIncomplete },
      })
    ).rejects.toThrow(/payment hash|structurally valid BOLT11/i)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("rejects missing and ambiguous invoice descriptions at the module boundary", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => undefined)
    const missingDescription = makeBolt11Fixture({
      fields: [bolt11PaymentHashField()],
    })
    const ambiguousDescription = makeBolt11Fixture({
      fields: [
        bolt11PaymentHashField(),
        bolt11PlainDescriptionField(),
        bolt11DescriptionHashField("ambiguous description"),
      ],
    })
    const module = createTestModule(store, { publish })

    for (const candidate of [missingDescription, ambiguousDescription]) {
      await expect(
        module.deliver({
          mode: "create",
          merchantPubkey: MERCHANT_PUBKEY,
          buyerPubkey: BUYER_PUBKEY,
          orderId: ORDER_ID,
          amountSats: 50,
          delivery: "buyer_and_self",
          source: { type: "manual", invoice: candidate },
        })
      ).rejects.toThrow(/description/i)
    }
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("uses WebLN only when the merchant explicitly selects it", async () => {
    const store = new MemoryPendingInvoiceStore()
    const fetchLnurlPayMetadata = mock(async () => {
      throw new Error("profile source should not run")
    })
    const makeWeblnInvoice = mock(async () => ({ invoice: INVOICE }))
    const makeNwcInvoice = mock(async () => ({ invoice: INVOICE }))
    const resolveProfileLud16 = mock(async () => {
      throw new Error("profile authority unavailable")
    })
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      fetchLnurlPayMetadata,
      makeWeblnInvoice,
      makeNwcInvoice,
      resolveProfileLud16,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "webln" },
      })
    ).resolves.toMatchObject({ source: "webln" })
    expect(makeWeblnInvoice).toHaveBeenCalledWith({
      amountSats: 50,
      memo: "Conduit order order-239",
    })
    expect(fetchLnurlPayMetadata).toHaveBeenCalledTimes(0)
    expect(resolveProfileLud16).toHaveBeenCalledTimes(0)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(0)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("bounds an explicitly selected WebLN invoice request", async () => {
    const store = new MemoryPendingInvoiceStore()
    const makeWeblnInvoice = mock(
      () => new Promise<{ invoice: string }>(() => undefined)
    )
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      makeWeblnInvoice,
      publish,
      webLnTimeoutMs: 5,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "webln" },
      })
    ).rejects.toThrow(/timed out/)
    expect(makeWeblnInvoice).toHaveBeenCalledTimes(1)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("blocks explicit NWC invoicing when no wallet destination is reported", async () => {
    const store = new MemoryPendingInvoiceStore()
    const getNwcInfo = mock(async () => ({ methods: ["make_invoice"] }))
    const makeNwcInvoice = mock(async () => ({ invoice: INVOICE }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      getNwcInfo,
      makeNwcInvoice,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection: {
            walletPubkey: "c".repeat(64),
            secret: MOCKED_NWC_CONNECTION_TOKEN,
            relays: ["wss://relay.example"],
          },
        },
      })
    ).rejects.toThrow(/exactly match the current signed profile/i)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(0)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("blocks NWC issuance when the wallet destination rotates away from the fresh profile", async () => {
    const store = new MemoryPendingInvoiceStore()
    const getNwcInfo = mock(async () => ({
      methods: ["make_invoice"],
      lud16: "rotated@pay.example",
    }))
    const makeNwcInvoice = mock(async () => ({ invoice: INVOICE }))
    const resolveProfileLud16 = mock(async () => "current@pay.example")
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      getNwcInfo,
      makeNwcInvoice,
      resolveProfileLud16,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection: {
            walletPubkey: "c".repeat(64),
            secret: MOCKED_NWC_CONNECTION_TOKEN,
            relays: ["wss://relay.example"],
            lud16: "current@pay.example",
          },
          walletLud16: "current@pay.example",
        },
      })
    ).rejects.toThrow(/exactly match the current signed profile/i)
    expect(resolveProfileLud16).toHaveBeenCalledWith(MERCHANT_PUBKEY)
    expect(getNwcInfo).toHaveBeenCalledTimes(1)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(0)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("blocks NWC issuance when the fresh get_info read fails", async () => {
    const store = new MemoryPendingInvoiceStore()
    const getNwcInfo = mock(async () => {
      throw new Error("relay unavailable")
    })
    const makeNwcInvoice = mock(async () => ({ invoice: INVOICE }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      getNwcInfo,
      makeNwcInvoice,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection: {
            walletPubkey: "c".repeat(64),
            secret: MOCKED_NWC_CONNECTION_TOKEN,
            relays: ["wss://relay.example"],
            lud16: "merchant@pay.example",
          },
          walletLud16: "merchant@pay.example",
        },
      })
    ).rejects.toThrow(
      /current invoice capability and destination are unavailable/i
    )
    expect(getNwcInfo).toHaveBeenCalledTimes(1)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(0)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("blocks NWC issuance when fresh get_info no longer authorizes make_invoice", async () => {
    const store = new MemoryPendingInvoiceStore()
    const getNwcInfo = mock(async () => ({
      methods: ["lookup_invoice"],
      lud16: "merchant@pay.example",
    }))
    const makeNwcInvoice = mock(async () => ({ invoice: INVOICE }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      getNwcInfo,
      makeNwcInvoice,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection: {
            walletPubkey: "c".repeat(64),
            secret: MOCKED_NWC_CONNECTION_TOKEN,
            relays: ["wss://relay.example"],
          },
          walletLud16: "merchant@pay.example",
        },
      })
    ).rejects.toThrow(/does not currently authorize invoice creation/i)
    expect(getNwcInfo).toHaveBeenCalledTimes(1)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(0)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("blocks NWC issuance when current profile authority cannot be confirmed", async () => {
    const store = new MemoryPendingInvoiceStore()
    const makeNwcInvoice = mock(async () => ({ invoice: INVOICE }))
    const resolveProfileLud16 = mock(async () => {
      throw new Error("Current signed payment destination is unavailable.")
    })
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      makeNwcInvoice,
      resolveProfileLud16,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection: {
            walletPubkey: "c".repeat(64),
            secret: MOCKED_NWC_CONNECTION_TOKEN,
            relays: ["wss://relay.example"],
            lud16: "current@pay.example",
          },
        },
      })
    ).rejects.toThrow(/current signed payment destination is unavailable/i)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(0)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("does not query a stale NWC session after the profile authority read", async () => {
    const store = new MemoryPendingInvoiceStore()
    const firstConnection = {
      walletPubkey: "c".repeat(64),
      secret: MOCKED_NWC_CONNECTION_TOKEN,
      relays: ["wss://relay.example"],
      lud16: "merchant@pay.example",
    }
    const replacementConnection = {
      ...firstConnection,
      lud16: "other@pay.example",
    }
    let currentConnection = firstConnection
    const resolveProfileLud16 = mock(async () => {
      currentConnection = replacementConnection
      return "merchant@pay.example"
    })
    const getNwcInfo = mock(async () => ({
      methods: ["make_invoice"],
      lud16: "merchant@pay.example",
    }))
    const makeNwcInvoice = mock(async () => ({ invoice: INVOICE }))
    const module = createTestModule(store, {
      resolveProfileLud16,
      getNwcInfo,
      makeNwcInvoice,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection: firstConnection,
          assertCurrentConnection: () => {
            if (currentConnection !== firstConnection) {
              throw new Error("NWC session replaced")
            }
          },
        },
      })
    ).rejects.toThrow("NWC session replaced")
    expect(getNwcInfo).toHaveBeenCalledTimes(0)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(0)
  })

  it("revalidates NWC capability after issuance before saving", async () => {
    const store = new MemoryPendingInvoiceStore()
    const connection = {
      walletPubkey: "c".repeat(64),
      secret: MOCKED_NWC_CONNECTION_TOKEN,
      relays: ["wss://relay.example"],
      lud16: "merchant@pay.example",
    }
    let infoReadCount = 0
    const getNwcInfo = mock(async () => {
      infoReadCount += 1
      return {
        methods: infoReadCount === 1 ? ["make_invoice"] : ["lookup_invoice"],
        lud16: "merchant@pay.example",
      }
    })
    const makeNwcInvoice = mock(async () => ({ invoice: INVOICE }))
    const resolveProfileLud16 = mock(async () => ({
      lud16: "merchant@pay.example",
      frontierEventId: PROFILE_FRONTIER_1,
    }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      getNwcInfo,
      makeNwcInvoice,
      resolveProfileLud16,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection,
          walletLud16: "merchant@pay.example",
        },
      })
    ).rejects.toThrow(/no longer authorizes invoice creation/i)
    expect(resolveProfileLud16).toHaveBeenCalledTimes(2)
    expect(getNwcInfo).toHaveBeenCalledTimes(2)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(1)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("reads the exact profile frontier after the final NWC capability check", async () => {
    const store = new MemoryPendingInvoiceStore()
    const connection = {
      walletPubkey: "c".repeat(64),
      secret: MOCKED_NWC_CONNECTION_TOKEN,
      relays: ["wss://relay.example"],
      lud16: "merchant@pay.example",
    }
    let infoReadCount = 0
    let frontierEventId = PROFILE_FRONTIER_1
    const getNwcInfo = mock(async () => {
      infoReadCount += 1
      if (infoReadCount === 2) frontierEventId = PROFILE_FRONTIER_2
      return { methods: ["make_invoice"], lud16: "merchant@pay.example" }
    })
    const resolveProfileLud16 = mock(async () => ({
      lud16: "merchant@pay.example",
      frontierEventId,
    }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      getNwcInfo,
      makeNwcInvoice: mock(async () => ({ invoice: INVOICE })),
      resolveProfileLud16,
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "nwc", connection },
      })
    ).rejects.toThrow(/profile payment destination changed/i)
    expect(getNwcInfo).toHaveBeenCalledTimes(2)
    expect(resolveProfileLud16).toHaveBeenCalledTimes(2)
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("blocks an NWC invoice after the active wallet session is replaced", async () => {
    const store = new MemoryPendingInvoiceStore()
    const firstConnection = {
      walletPubkey: "c".repeat(64),
      secret: MOCKED_NWC_CONNECTION_TOKEN,
      relays: ["wss://relay.example"],
      lud16: "merchant@pay.example",
    }
    const replacementConnection = {
      ...firstConnection,
      secret: "replacement non-credential test sentinel",
    }
    let currentConnection = firstConnection
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      refreshConversationEvidence: mock(async () => {
        currentConnection = replacementConnection
        return COMPLETE_EMPTY_INVOICE_HISTORY
      }),
      publish,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection: firstConnection,
          assertCurrentConnection: () => {
            if (currentConnection !== firstConnection) {
              throw new Error("NWC session replaced")
            }
          },
        },
      })
    ).rejects.toThrow("NWC session replaced")
    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("rechecks the NWC session at the first relay boundary", async () => {
    const store = new MemoryPendingInvoiceStore()
    const firstConnection = {
      walletPubkey: "c".repeat(64),
      secret: MOCKED_NWC_CONNECTION_TOKEN,
      relays: ["wss://relay.example"],
      lud16: "merchant@pay.example",
    }
    const replacementConnection = {
      ...firstConnection,
      secret: "replacement non-credential test sentinel",
    }
    let currentConnection = firstConnection
    const publish = mock(async (input: PublishMerchantOrderMessageInput) => {
      currentConnection = replacementConnection
      await input.revalidateBeforeDelivery?.("sender_self_copy")
    })
    const module = createTestModule(store, { publish })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection: firstConnection,
          assertCurrentConnection: () => {
            if (currentConnection !== firstConnection) {
              throw new Error("NWC session replaced")
            }
          },
        },
      })
    ).rejects.toThrow("NWC session replaced")
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      source: "nwc",
      deliveryState: "pending",
      lastFailureCode: "relay_delivery_failed",
    })
  })

  it("blocks an uncommitted NWC retry after its authorization changes", async () => {
    const store = new MemoryPendingInvoiceStore()
    const originalConnection = {
      walletPubkey: "c".repeat(64),
      secret: MOCKED_NWC_CONNECTION_TOKEN,
      relays: ["wss://relay.example"],
      lud16: "merchant@pay.example",
    }
    const replacementConnection = {
      ...originalConnection,
      secret: "replacement non-credential test sentinel",
    }
    await store.put(
      savedInvoice({
        source: "nwc",
        paymentAuthority: {
          type: "nwc",
          lud16: "merchant@pay.example",
          profileFrontierEventId: null,
          connectionFingerprint:
            getNwcConnectionFingerprint(originalConnection),
        },
      })
    )
    const publish = mock(async () => undefined)
    const module = createTestModule(store, { publish })

    await expect(
      module.deliver({
        mode: "retry",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: COMPLETE_EMPTY_INVOICE_HISTORY,
        resolveCurrentNwcConnection: () => replacementConnection,
      })
    ).rejects.toThrow(/NWC wallet changed/i)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("treats an exact signed self-copy as authority to redeliver the same NWC invoice", async () => {
    const store = new MemoryPendingInvoiceStore()
    const originalConnection = {
      walletPubkey: "c".repeat(64),
      secret: MOCKED_NWC_CONNECTION_TOKEN,
      relays: ["wss://relay.example"],
      lud16: "merchant@pay.example",
    }
    await store.put(
      savedInvoice({
        source: "nwc",
        paymentAuthority: {
          type: "nwc",
          lud16: "merchant@pay.example",
          profileFrontierEventId: null,
          connectionFingerprint:
            getNwcConnectionFingerprint(originalConnection),
        },
      })
    )
    const signedMatch = completeInvoiceHistory(
      conversationInvoiceRequest(INVOICE, {
        messageId: "required-self-copy",
      })
    )
    const resolveCurrentNwcConnection = mock(() => {
      throw new Error("committed invoice must not need the old wallet")
    })
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      publish,
      refreshConversationEvidence: mock(async () => signedMatch),
    })

    await expect(
      module.deliver({
        mode: "retry",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        conversationEvidence: signedMatch,
        resolveCurrentNwcConnection,
      })
    ).resolves.toMatchObject({ reused: true, relayAcceptance: "accepted" })
    expect(resolveCurrentNwcConnection).toHaveBeenCalledTimes(0)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("keeps an exact invoice committed after self-copy when profile authority rotates", async () => {
    const store = new MemoryPendingInvoiceStore()
    let frontierEventId = PROFILE_FRONTIER_1
    let refreshCount = 0
    const exactCommitment = completeInvoiceHistory(
      conversationInvoiceRequest(INVOICE, {
        messageId: "profile-rotated-required-self-copy",
      })
    )
    const resolveProfileLud16 = mock(async () => ({
      lud16: "merchant@pay.example",
      frontierEventId,
    }))
    const publish = mock(async (input: PublishMerchantOrderMessageInput) => {
      await input.revalidateBeforeDelivery?.("sender_self_copy")
      frontierEventId = PROFILE_FRONTIER_2
      await input.revalidateBeforeDelivery?.("recipient")
    })
    const module = createTestModule(store, {
      resolveProfileLud16,
      publish,
      refreshConversationEvidence: mock(async () => {
        refreshCount += 1
        return refreshCount === 1
          ? COMPLETE_EMPTY_INVOICE_HISTORY
          : exactCommitment
      }),
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
      })
    ).resolves.toMatchObject({ relayAcceptance: "accepted" })
    expect(resolveProfileLud16).toHaveBeenCalledTimes(3)
    expect(refreshCount).toBe(2)
  })

  it("confirms the signed self-copy from complete history before buyer delivery", async () => {
    const store = new MemoryPendingInvoiceStore()
    let refreshCount = 0
    let recipientReached = false
    const exactCommitment = completeInvoiceHistory(
      conversationInvoiceRequest(INVOICE, {
        messageId: "fresh-required-self-copy",
      })
    )
    const publish = mock(async (input: PublishMerchantOrderMessageInput) => {
      await input.revalidateBeforeDelivery?.("sender_self_copy")
      await input.revalidateBeforeDelivery?.("recipient")
      recipientReached = true
    })
    const module = createTestModule(store, {
      publish,
      refreshConversationEvidence: mock(async () => {
        refreshCount += 1
        return refreshCount === 1
          ? COMPLETE_EMPTY_INVOICE_HISTORY
          : exactCommitment
      }),
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: INVOICE },
      })
    ).resolves.toMatchObject({ relayAcceptance: "accepted" })
    expect(refreshCount).toBe(2)
    expect(recipientReached).toBe(true)
  })

  it("blocks the buyer leg when a competing invoice wins the self-copy race", async () => {
    const store = new MemoryPendingInvoiceStore()
    let refreshCount = 0
    let recipientReached = false
    const conflictingCommitment = completeInvoiceHistory(
      conversationInvoiceRequest(INVOICE, {
        messageId: "local-required-self-copy",
      }),
      conversationInvoiceRequest(SECOND_ACTIVE_INVOICE, {
        messageId: "competing-device-self-copy",
      })
    )
    const publish = mock(async (input: PublishMerchantOrderMessageInput) => {
      await input.revalidateBeforeDelivery?.("sender_self_copy")
      await input.revalidateBeforeDelivery?.("recipient")
      recipientReached = true
    })
    const module = createTestModule(store, {
      publish,
      refreshConversationEvidence: mock(async () => {
        refreshCount += 1
        return refreshCount === 1
          ? COMPLETE_EMPTY_INVOICE_HISTORY
          : conflictingCommitment
      }),
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow(/different payable invoice/i)
    expect(refreshCount).toBe(2)
    expect(recipientReached).toBe(false)
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      deliveryState: "pending",
      lastFailureCode: "relay_delivery_failed",
    })
  })

  it("uses a matching NWC connection only after explicit selection", async () => {
    const store = new MemoryPendingInvoiceStore()
    const connection = {
      walletPubkey: "c".repeat(64),
      secret: MOCKED_NWC_CONNECTION_TOKEN,
      relays: ["wss://relay.example"],
      lud16: "Merchant@Pay.Example",
    }
    const makeNwcInvoice = mock(async () => ({ invoice: INVOICE }))
    const actionOrder: string[] = []
    const resolveProfileLud16 = mock(async () => {
      actionOrder.push("profile")
      return "merchant@pay.example"
    })
    const getNwcInfo = mock(async () => {
      actionOrder.push("get_info")
      return {
        methods: ["make_invoice"],
        lud16: "",
      }
    })
    makeNwcInvoice.mockImplementation(async () => {
      actionOrder.push("make_invoice")
      return { invoice: INVOICE }
    })
    const publish = mock(async () => {
      const pending = await store.get(MERCHANT_PUBKEY, ORDER_ID)
      expect(JSON.stringify(pending)).not.toContain(connection.secret)
    })
    const module = createTestModule(store, {
      getNwcInfo,
      makeNwcInvoice,
      publish,
      resolveProfileLud16,
      nwcTimeoutMs: 8_000,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: {
          type: "nwc",
          connection,
          walletLud16: "merchant@pay.example",
        },
      })
    ).resolves.toMatchObject({ source: "nwc" })
    expect(makeNwcInvoice).toHaveBeenCalledWith(
      connection,
      {
        amountMsats: 50_000,
        description: "Conduit order order-239",
      },
      8_000
    )
    expect(getNwcInfo).toHaveBeenCalledWith(connection, 8_000)
    expect(actionOrder).toEqual([
      "profile",
      "get_info",
      "make_invoice",
      "get_info",
      "profile",
    ])
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("does not discard an unexpired pending invoice", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(savedInvoice())
    const module = createTestModule(store)
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await expect(module.discardExpired(scope)).rejects.toThrow(/not expired/)
    expect(await module.getPending(scope)).toEqual(savedInvoice())
  })

  it("normalizes account pubkeys before keying durable invoice state", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => {
      expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
        id: `${MERCHANT_PUBKEY}:${ORDER_ID}`,
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
      })
    })
    const module = createTestModule(store, { publish })

    await module.deliver({
      mode: "create",
      merchantPubkey: MERCHANT_PUBKEY.toUpperCase(),
      buyerPubkey: BUYER_PUBKEY.toUpperCase(),
      orderId: ` ${ORDER_ID} `,
      amountSats: 50,
      delivery: "buyer_and_self",
      source: { type: "manual", invoice: INVOICE },
    })
    expect(publish).toHaveBeenCalledTimes(1)

    await expect(
      module.getPending({
        merchantPubkey: "not-a-pubkey",
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
      })
    ).rejects.toThrow(/valid merchant and buyer pubkeys/i)
  })

  it("reports relay acceptance truthfully when its local checkpoint write fails", async () => {
    const store = new MemoryPendingInvoiceStore()
    const memoryPut = store.put.bind(store)
    let putCount = 0
    store.put = mock(async (record) => {
      putCount += 1
      if (putCount === 3) throw new Error("checkpoint unavailable")
      await memoryPut(record)
    })
    const publish = mock(async () => undefined)
    const module = createTestModule(store, { publish })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: INVOICE },
      })
    ).resolves.toMatchObject({
      source: "manual",
      relayAcceptance: "accepted",
      localCheckpointWarning: "relay_accepted_local_checkpoint_failed",
    })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      invoice: INVOICE,
      deliveryState: "pending",
      deliveryAttemptCount: 1,
    })
    await expect(
      module.getPending({
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
      })
    ).resolves.toMatchObject({
      invoice: INVOICE,
      deliveryState: "relay_accepted",
      deliveryAttemptCount: 1,
    })
    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow(/already reached a recipient relay/i)
    await expect(
      module.deliver({
        mode: "retry",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
      })
    ).resolves.toMatchObject({
      invoice: INVOICE,
      reused: true,
      relayAcceptance: "accepted",
    })
    expect(publish).toHaveBeenCalledTimes(2)
    await expect(
      module.getPending({
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
      })
    ).resolves.toMatchObject({
      invoice: INVOICE,
      deliveryState: "relay_accepted",
      deliveryAttemptCount: 2,
    })
  })

  it("discards an expired in-memory relay checkpoint after its durable write fails", async () => {
    const store = new MemoryPendingInvoiceStore()
    const memoryPut = store.put.bind(store)
    let putCount = 0
    store.put = mock(async (record) => {
      putCount += 1
      if (putCount === 3) throw new Error("checkpoint unavailable")
      await memoryPut(record)
    })
    let now = 1_799_999_000_000
    const module = createTestModule(store, {
      publish: mock(async () => undefined),
      now: () => now,
    })
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    await expect(
      module.deliver({
        mode: "create",
        ...scope,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "manual", invoice: INVOICE },
      })
    ).resolves.toMatchObject({
      relayAcceptance: "accepted",
      localCheckpointWarning: "relay_accepted_local_checkpoint_failed",
    })

    now = 1_800_004_000_000
    await expect(module.discardExpired(scope)).resolves.toBeUndefined()
    await expect(module.getPending(scope)).resolves.toBeNull()
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toBeNull()
  })

  it("does not replace a durable relay checkpoint in the same session", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => undefined)
    const module = createTestModule(store, { publish })
    const input = {
      mode: "create" as const,
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
      amountSats: 50,
      delivery: "buyer_and_self" as const,
      source: { type: "manual" as const, invoice: INVOICE },
    }

    await expect(module.deliver(input)).resolves.toMatchObject({
      relayAcceptance: "accepted",
    })
    await expect(module.deliver(input)).rejects.toThrow(
      /already reached a recipient relay/i
    )
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("allows only one invoice action per order scope at a time", async () => {
    const store = new MemoryPendingInvoiceStore()
    let releasePublish: (() => void) | undefined
    const publish = mock(
      () =>
        new Promise<void>((resolve) => {
          releasePublish = resolve
        })
    )
    const module = createTestModule(store, { publish })
    const input = {
      mode: "create" as const,
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
      amountSats: 50,
      delivery: "buyer_and_self" as const,
      source: { type: "manual" as const, invoice: INVOICE },
    }

    const first = module.deliver(input)
    await Promise.resolve()
    await expect(module.deliver(input)).rejects.toThrow(/already in progress/i)
    releasePublish?.()
    await expect(first).resolves.toMatchObject({ relayAcceptance: "accepted" })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("allows only one issuer and publish path across module instances", async () => {
    const store = new MemoryPendingInvoiceStore()
    const locks = new MemoryInvoiceLockManager()
    const issuerStarted = deferred<void>()
    const releaseIssuer = deferred<void>()
    const fetchLnurlInvoice = mock(async () => {
      issuerStarted.resolve(undefined)
      await releaseIssuer.promise
      return { invoice: INVOICE }
    })
    const publish = mock(async () => undefined)
    const overrides = {
      fetchLnurlInvoice,
      publish,
      lockManager: locks,
      requireCrossContextLock: true,
    }
    const firstModule = createTestModule(store, overrides)
    const secondModule = createTestModule(store, overrides)
    const input = {
      mode: "create" as const,
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
      amountSats: 50,
      delivery: "buyer_and_self" as const,
      source: { type: "profile_lud16" as const },
    }

    const first = firstModule.deliver(input)
    await issuerStarted.promise
    await expect(secondModule.deliver(input)).rejects.toThrow(
      /already in progress/i
    )
    releaseIssuer.resolve(undefined)
    await expect(first).resolves.toMatchObject({ relayAcceptance: "accepted" })
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it("does not let an expiry cleanup delete a relay-accepted retry checkpoint", async () => {
    const store = new MemoryPendingInvoiceStore()
    await store.put(savedInvoice())
    const locks = new MemoryInvoiceLockManager()
    const publishStarted = deferred<void>()
    const releasePublish = deferred<void>()
    let now = 1_800_003_599_000
    const publish = mock(async () => {
      publishStarted.resolve(undefined)
      await releasePublish.promise
    })
    const overrides = {
      publish,
      lockManager: locks,
      requireCrossContextLock: true,
      now: () => now,
    }
    const retryTab = createTestModule(store, overrides)
    const staleCleanupTab = createTestModule(store, overrides)
    const scope = {
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
    }

    const retry = retryTab.deliver({ mode: "retry", ...scope })
    await publishStarted.promise
    now = 1_800_003_601_000
    await expect(staleCleanupTab.discardExpired(scope)).rejects.toThrow(
      /already in progress/i
    )
    releasePublish.resolve(undefined)
    await expect(retry).resolves.toMatchObject({ relayAcceptance: "accepted" })
    expect(await store.get(MERCHANT_PUBKEY, ORDER_ID)).toMatchObject({
      deliveryState: "relay_accepted",
    })
  })

  it("fails closed in a browser context without cross-tab locking", async () => {
    const store = new MemoryPendingInvoiceStore()
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const publish = mock(async () => undefined)
    const module = createTestModule(store, {
      fetchLnurlInvoice,
      publish,
      lockManager: null,
      requireCrossContextLock: true,
    })

    await expect(
      module.deliver({
        mode: "create",
        merchantPubkey: MERCHANT_PUBKEY,
        buyerPubkey: BUYER_PUBKEY,
        orderId: ORDER_ID,
        amountSats: 50,
        delivery: "buyer_and_self",
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow(/cannot safely coordinate invoice actions across tabs/i)
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("keeps provider credentials and invoices out of the mutation boundary state", async () => {
    const connection = {
      walletPubkey: "c".repeat(64),
      secret: MOCKED_NWC_CONNECTION_TOKEN,
      relays: ["wss://relay.example"],
      uri: "provider-owned test sentinel",
    }
    const selections: unknown[] = []
    const mutationFn = createMerchantInvoiceMutationFn({
      resolveSource: (source) =>
        source === "nwc"
          ? { type: "nwc", connection }
          : source === "manual"
            ? { type: "manual", invoice: INVOICE }
            : { type: source },
      deliver: async (source) => {
        selections.push(source)
        return {
          invoice: INVOICE,
          source: source.type,
          reused: false,
          relayAcceptance: "accepted",
        }
      },
    })
    const mutationState = [
      { variables: "nwc" as const, data: await mutationFn("nwc") },
      { variables: "manual" as const, data: await mutationFn("manual") },
    ]

    expect(selections).toEqual([
      { type: "nwc", connection },
      { type: "manual", invoice: INVOICE },
    ])
    expect(mutationState).toEqual([
      {
        variables: "nwc",
        data: {
          source: "nwc",
          reused: false,
          relayAcceptance: "accepted",
        },
      },
      {
        variables: "manual",
        data: {
          source: "manual",
          reused: false,
          relayAcceptance: "accepted",
        },
      },
    ])
    const diagnosticsVisibleState = JSON.stringify(mutationState)
    expect(diagnosticsVisibleState).not.toContain(connection.secret)
    expect(diagnosticsVisibleState).not.toContain(connection.uri)
    expect(diagnosticsVisibleState).not.toContain(INVOICE)
  })

  it("projects retry results to content-free mutation data", () => {
    expect(
      sanitizeMerchantInvoiceMutationResult({
        invoice: INVOICE,
        source: "profile_lud16",
        reused: true,
        relayAcceptance: "accepted",
      })
    ).toEqual({
      source: "profile_lud16",
      reused: true,
      relayAcceptance: "accepted",
    })
  })

  it("replaces expired-invoice discard failures with a content-free mutation error", async () => {
    const discard = createMerchantInvoiceDiscardMutationFn(async () => {
      throw new Error(`storage key ${MERCHANT_PUBKEY}:${ORDER_ID}:${INVOICE}`)
    })

    try {
      await discard()
      throw new Error("Expected discard to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(MerchantInvoiceMutationError)
      expect((error as MerchantInvoiceMutationError).code).toBe(
        "invoice_discard_failed"
      )
      const visible = JSON.stringify(error)
      expect(visible).not.toContain(INVOICE)
      expect(visible).not.toContain(ORDER_ID)
      expect(visible).not.toContain(MERCHANT_PUBKEY)
    }
  })
})

describe("merchant invoice route contract", () => {
  it("keeps the signed profile address as the primary automatic source", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()
    const profileButton = source.indexOf(
      "Generate from profile Lightning address"
    )
    const webLnButton = source.indexOf("Generate with browser wallet")
    const nwcButton = source.indexOf("Generate with NWC")

    expect(profileButton).toBeGreaterThan(-1)
    expect(webLnButton).toBeGreaterThan(profileButton)
    expect(nwcButton).toBeGreaterThan(profileButton)
    expect(source).not.toContain("else if (weblnAvailable)")
  })

  it("keeps manual paste visible alongside every automatic source", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("Manual paste is always available")
    expect(source).toContain("BOLT11 (paste manually)")
    expect(source).toContain("Generate from profile Lightning address")
    expect(source).toContain("Generate with browser wallet")
    expect(source).toContain("Generate with NWC")
  })

  it("passes only source discriminators to the invoice mutation", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("createMerchantInvoiceMutationFn")
    expect(source).toMatch(/invoiceDeliveryMutation\.mutate\(\s*"manual"\s*\)/)
    expect(source).toMatch(/invoiceDeliveryMutation\.mutate\(\s*"nwc"\s*\)/)
    expect(source).not.toContain("connection: nwc.connection!")
    expect(source).not.toContain("invoiceDeliveryMutation.mutate({")
    expect(source).toContain("createMerchantInvoiceRetryMutationFn(")
    expect(source).toContain("const connectionUri = connection.uri")
    expect(source).toContain("resolveInvoiceConnection().uri !== connectionUri")
    expect(source).toContain(
      "resolveCurrentNwcConnection: resolveInvoiceConnection"
    )
  })

  it("keeps the saved checkpoint visible while gating unsafe retries", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain("const canManageSavedInvoice =")
    expect(source).toContain("!!pendingInvoice &&")
    expect(source).toContain(
      'pendingInvoice.deliveryState === "relay_accepted"'
    )
    expect(source).toContain("invoiceHistoryCanAuthorizeAction")
    expect(source).toContain(
      "const canSendInvoice = canCreateInvoice || canManageSavedInvoice"
    )
    expect(source).toContain("if (!canCreateInvoice)")
  })

  it("surfaces a required-route history cap without treating optional relay caps as a payment pause", async () => {
    const source = await Bun.file("apps/merchant/src/routes/orders.tsx").text()

    expect(source).toContain(
      "ordersMeta?.inbox?.declaredWritePlan.capped === true"
    )
    expect(source).not.toContain("ordersMeta?.capped === true")
    expect(source).toContain(
      "Order history reached the current secure read limit"
    )
    expect(source).toContain(
      "generation and automatic payment confirmation are paused"
    )
    expect(source).toContain("!invoiceHistoryCapped &&")
  })
})
