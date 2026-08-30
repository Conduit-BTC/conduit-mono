import { describe, expect, it, mock } from "bun:test"

import {
  createMerchantInvoiceModule,
  DexieMerchantPendingInvoiceStore,
  getAuthoritativeMerchantProfileLud16,
  type MerchantInvoiceDependencies,
  type MerchantPendingInvoice,
  type MerchantPendingInvoiceStore,
} from "../apps/merchant/src/lib/merchant-invoice"
import {
  bolt11PaymentHashField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const MERCHANT_PUBKEY = "a".repeat(64)
const BUYER_PUBKEY = "b".repeat(64)
const OTHER_BUYER_PUBKEY = "c".repeat(64)
const ORDER_ID = "order-239"
const NOW_MS = 1_799_999_000_000
const INVOICE = makeBolt11Fixture({
  fields: [bolt11PaymentHashField()],
  createdAt: 1_800_000_000,
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

class MemoryPendingInvoiceStore implements MerchantPendingInvoiceStore {
  readonly rows = new Map<string, MerchantPendingInvoice>()
  readonly operations: string[] = []
  failWrites = false
  failOnPutNumber: number | null = null
  putCount = 0

  async get(
    merchantPubkey: string,
    orderId: string
  ): Promise<MerchantPendingInvoice | null> {
    return this.rows.get(`${merchantPubkey}:${orderId}`) ?? null
  }

  async put(invoice: MerchantPendingInvoice): Promise<void> {
    this.operations.push("put")
    this.putCount += 1
    if (this.failWrites || this.putCount === this.failOnPutNumber) {
      throw new Error("private storage failure")
    }
    this.rows.set(invoice.id, structuredClone(invoice))
  }

  async delete(merchantPubkey: string, orderId: string): Promise<void> {
    this.operations.push("delete")
    this.rows.delete(`${merchantPubkey}:${orderId}`)
  }
}

function createDependencies(
  store: MemoryPendingInvoiceStore,
  overrides: Partial<MerchantInvoiceDependencies> = {}
): MerchantInvoiceDependencies {
  return {
    store,
    getProfileLud16: mock(async () => "merchant@pay.example"),
    fetchLnurlPayMetadata: mock(async () => ({
      payRequestUrl: "https://pay.example/.well-known/lnurlp/merchant",
      lnurl: "lnurl1example",
      callback: "https://pay.example/callback",
      minSendable: 1_000,
      maxSendable: 100_000,
      tag: "payRequest" as const,
      allowsNostr: true,
      metadata: "[]",
    })),
    fetchLnurlInvoice: mock(async () => ({ invoice: INVOICE })),
    makeWeblnInvoice: mock(async () => ({ invoice: INVOICE })),
    getNwcInfo: mock(async () => ({
      methods: ["make_invoice"],
      lud16: "merchant@pay.example",
    })),
    makeNwcInvoice: mock(async () => ({
      invoice: INVOICE,
      paymentHash: "07".repeat(32),
      amount: 50_000,
      createdAt: 1_800_000_000,
      expiresAt: 1_800_003_600,
    })),
    makeMockInvoice: mock(() => ({ invoice: "mock-invoice" })),
    isMockPayments: () => false,
    publish: mock(async () => undefined),
    now: () => NOW_MS,
    ...overrides,
  }
}

function createInput() {
  return {
    merchantPubkey: MERCHANT_PUBKEY,
    buyerPubkey: BUYER_PUBKEY,
    orderId: ORDER_ID,
    amountSats: 50,
    note: "Thanks",
    delivery: "buyer_and_self" as const,
  }
}

describe("merchant invoice source routing", () => {
  it("fails closed for legacy or malformed profile rows without signed content", () => {
    expect(
      getAuthoritativeMerchantProfileLud16({
        lud16: "stale@pay.example",
      })
    ).toBeNull()
    expect(
      getAuthoritativeMerchantProfileLud16({
        rawContent: "not-json",
        lud16: "stale@pay.example",
      })
    ).toBeNull()
    expect(
      getAuthoritativeMerchantProfileLud16({
        rawContent: JSON.stringify({ lud16: "current@pay.example" }),
        lud16: "stale@pay.example",
      })
    ).toBe("current@pay.example")
  })

  it("uses the signed profile destination for a plain LNURL invoice", async () => {
    const store = new MemoryPendingInvoiceStore()
    const dependencies = createDependencies(store)
    const module = createMerchantInvoiceModule(dependencies)

    const result = await module.createAndDeliver({
      ...createInput(),
      source: { type: "profile_lud16" },
    })

    expect(dependencies.fetchLnurlPayMetadata).toHaveBeenCalledWith(
      "merchant@pay.example"
    )
    expect(dependencies.getProfileLud16).toHaveBeenCalledWith(MERCHANT_PUBKEY)
    expect(dependencies.fetchLnurlInvoice).toHaveBeenCalledWith(
      "https://pay.example/callback",
      50_000
    )
    expect(dependencies.makeWeblnInvoice).toHaveBeenCalledTimes(0)
    expect(result).toBeUndefined()
  })

  it("rejects profile amounts outside the LNURL provider range", async () => {
    const store = new MemoryPendingInvoiceStore()
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const module = createMerchantInvoiceModule(
      createDependencies(store, {
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
      })
    )

    await expect(
      module.createAndDeliver({
        ...createInput(),
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow(/does not accept this invoice amount/i)
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(0)
    expect(store.rows.size).toBe(0)
  })

  it("fails closed when the current signed profile has no destination", async () => {
    const store = new MemoryPendingInvoiceStore()
    const dependencies = createDependencies(store, {
      getProfileLud16: mock(async () => null),
    })

    await expect(
      createMerchantInvoiceModule(dependencies).createAndDeliver({
        ...createInput(),
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow(/valid profile Lightning address/i)
    expect(dependencies.fetchLnurlPayMetadata).toHaveBeenCalledTimes(0)
    expect(dependencies.publish).toHaveBeenCalledTimes(0)
  })

  it("uses WebLN only when explicitly selected", async () => {
    const store = new MemoryPendingInvoiceStore()
    const makeWeblnInvoice = mock(async () => ({ invoice: INVOICE }))
    const dependencies = createDependencies(store, { makeWeblnInvoice })
    const module = createMerchantInvoiceModule(dependencies)

    await expect(
      module.createAndDeliver({
        ...createInput(),
        source: { type: "webln" },
      })
    ).resolves.toBeUndefined()
    expect(makeWeblnInvoice).toHaveBeenCalledWith({
      amountSats: 50,
      memo: `Conduit order ${ORDER_ID}`,
    })
    expect(dependencies.fetchLnurlPayMetadata).toHaveBeenCalledTimes(0)
  })

  it("keeps a late WebLN success exclusive until it is checkpointed", async () => {
    const store = new MemoryPendingInvoiceStore()
    const response = deferred<{ invoice: string }>()
    const started = deferred<void>()
    const makeWeblnInvoice = mock(() => {
      started.resolve()
      return response.promise
    })
    const dependencies = createDependencies(store, {
      makeWeblnInvoice,
      lockManager: null,
    })
    const firstModule = createMerchantInvoiceModule(dependencies)
    const secondModule = createMerchantInvoiceModule(dependencies)
    const firstAttempt = firstModule.createAndDeliver({
      ...createInput(),
      source: { type: "webln" },
    })

    await started.promise
    await expect(
      secondModule.createAndDeliver({
        ...createInput(),
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow(/already in progress/i)
    expect(makeWeblnInvoice).toHaveBeenCalledTimes(1)

    response.resolve({ invoice: INVOICE })
    await expect(firstAttempt).resolves.toBeUndefined()
    await expect(
      secondModule.createAndDeliver({
        ...createInput(),
        source: { type: "webln" },
      })
    ).rejects.toThrow(/already sent/i)
    expect(makeWeblnInvoice).toHaveBeenCalledTimes(1)
  })

  it("keeps a late NWC success exclusive until it is checkpointed", async () => {
    const connection = {
      walletPubkey: "d".repeat(64),
      secret: "test-secret",
      relays: ["wss://relay.example"],
      lud16: "merchant@pay.example",
    }
    const store = new MemoryPendingInvoiceStore()
    const response = deferred<{ invoice: string }>()
    const started = deferred<void>()
    const makeNwcInvoice = mock(() => {
      started.resolve()
      return response.promise
    })
    const dependencies = createDependencies(store, {
      makeNwcInvoice,
      lockManager: null,
    })
    const firstModule = createMerchantInvoiceModule(dependencies)
    const secondModule = createMerchantInvoiceModule(dependencies)
    const firstAttempt = firstModule.createAndDeliver({
      ...createInput(),
      source: { type: "nwc", connection },
    })

    await started.promise
    await expect(
      secondModule.createAndDeliver({
        ...createInput(),
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow(/already in progress/i)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(1)

    response.resolve({ invoice: INVOICE })
    await expect(firstAttempt).resolves.toBeUndefined()
    await expect(
      secondModule.createAndDeliver({
        ...createInput(),
        source: { type: "nwc", connection },
      })
    ).rejects.toThrow(/already sent/i)
    expect(makeNwcInvoice).toHaveBeenCalledTimes(1)
  })

  it("requires an explicitly selected NWC destination to match the profile", async () => {
    const connection = {
      walletPubkey: "d".repeat(64),
      secret: "test-secret",
      relays: ["wss://relay.example"],
      lud16: "merchant@pay.example",
    }
    const store = new MemoryPendingInvoiceStore()
    const dependencies = createDependencies(store)
    const module = createMerchantInvoiceModule(dependencies)

    await expect(
      module.createAndDeliver({
        ...createInput(),
        source: {
          type: "nwc",
          connection,
        },
      })
    ).resolves.toBeUndefined()
    expect(dependencies.getNwcInfo).toHaveBeenCalledTimes(1)
    expect(dependencies.makeNwcInvoice).toHaveBeenCalledTimes(1)
    expect(
      JSON.stringify(store.rows.get(`${MERCHANT_PUBKEY}:${ORDER_ID}`))
    ).not.toContain(connection.secret)
    expect(
      JSON.stringify(store.rows.get(`${MERCHANT_PUBKEY}:${ORDER_ID}`))
    ).not.toContain(connection.relays[0]!)

    const mismatchDependencies = createDependencies(
      new MemoryPendingInvoiceStore(),
      {
        getNwcInfo: mock(async () => ({
          methods: ["make_invoice"],
          lud16: "other@pay.example",
        })),
      }
    )
    await expect(
      createMerchantInvoiceModule(mismatchDependencies).createAndDeliver({
        ...createInput(),
        source: {
          type: "nwc",
          connection,
        },
      })
    ).rejects.toThrow(/does not match/i)
    expect(mismatchDependencies.makeNwcInvoice).toHaveBeenCalledTimes(0)

    const unsupportedDependencies = createDependencies(
      new MemoryPendingInvoiceStore(),
      {
        getNwcInfo: mock(async () => ({
          methods: ["get_balance"],
          lud16: "merchant@pay.example",
        })),
      }
    )
    await expect(
      createMerchantInvoiceModule(unsupportedDependencies).createAndDeliver({
        ...createInput(),
        source: {
          type: "nwc",
          connection,
        },
      })
    ).rejects.toThrow(/cannot create invoices/i)
    expect(unsupportedDependencies.makeNwcInvoice).toHaveBeenCalledTimes(0)
  })
})

describe("merchant invoice validation and durability", () => {
  it("fails closed when a durable checkpoint is malformed", async () => {
    const store = new DexieMerchantPendingInvoiceStore({
      get: async () =>
        ({
          id: `${MERCHANT_PUBKEY}:${ORDER_ID}`,
          merchantPubkey: MERCHANT_PUBKEY,
          buyerPubkey: BUYER_PUBKEY,
          orderId: ORDER_ID,
          invoice: "",
        }) as MerchantPendingInvoice,
      put: async () => undefined,
      delete: async () => undefined,
    })

    await expect(store.get(MERCHANT_PUBKEY, ORDER_ID)).rejects.toThrow(
      /invalid saved invoice state/i
    )
  })

  it("rejects the wrong amount, network, expiry, or structure before storage", async () => {
    const cases = [
      makeBolt11Fixture({
        fields: [bolt11PaymentHashField()],
        hrp: "lnbc600n",
        createdAt: 1_800_000_000,
      }),
      makeBolt11Fixture({
        fields: [bolt11PaymentHashField()],
        hrp: "lntb500n",
        createdAt: 1_800_000_000,
      }),
      makeBolt11Fixture({
        fields: [bolt11PaymentHashField()],
        createdAt: 1_700_000_000,
      }),
      "not-a-bolt11-invoice",
    ]

    for (const invoice of cases) {
      const store = new MemoryPendingInvoiceStore()
      const dependencies = createDependencies(store)
      await expect(
        createMerchantInvoiceModule(dependencies).createAndDeliver({
          ...createInput(),
          source: { type: "manual", invoice },
        })
      ).rejects.toBeInstanceOf(Error)
      expect(store.rows.size).toBe(0)
      expect(dependencies.publish).toHaveBeenCalledTimes(0)
    }
  })

  it("persists the exact invoice before the first delivery attempt", async () => {
    const store = new MemoryPendingInvoiceStore()
    const publish = mock(async () => {
      store.operations.push("publish")
    })
    const module = createMerchantInvoiceModule(
      createDependencies(store, { publish })
    )

    await module.createAndDeliver({
      ...createInput(),
      source: { type: "manual", invoice: INVOICE },
    })

    expect(store.operations.slice(0, 2)).toEqual(["put", "publish"])
    expect(store.rows.get(`${MERCHANT_PUBKEY}:${ORDER_ID}`)).toMatchObject({
      invoice: INVOICE,
      deliveryState: "sent",
    })
    expect(publish).toHaveBeenCalledWith({
      merchantPubkey: MERCHANT_PUBKEY,
      buyerPubkey: BUYER_PUBKEY,
      orderId: ORDER_ID,
      type: "payment_request",
      tags: [
        ["amount", "50"],
        ["currency", "SATS"],
        ["payment_method", "lightning"],
      ],
      payload: {
        invoice: INVOICE,
        amount: 50,
        currency: "SATS",
        note: "Thanks",
      },
      delivery: "buyer_and_self",
    })
    expect(JSON.stringify(publish.mock.calls[0])).not.toContain("zap")

    await expect(module.retryDelivery(createInput())).resolves.toBeUndefined()
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls.map(([input]) => input.payload.invoice)).toEqual([
      INVOICE,
      INVOICE,
    ])
  })

  it("does not publish when the durable checkpoint cannot be written", async () => {
    const store = new MemoryPendingInvoiceStore()
    store.failWrites = true
    const dependencies = createDependencies(store)

    await expect(
      createMerchantInvoiceModule(dependencies).createAndDeliver({
        ...createInput(),
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow(/storage failure/i)
    expect(dependencies.publish).toHaveBeenCalledTimes(0)
  })

  it("retains and retries the same invoice without asking the issuer again", async () => {
    const store = new MemoryPendingInvoiceStore()
    let failDelivery = true
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const publishedInvoices: string[] = []
    const publish = mock(async (input: { payload: { invoice?: string } }) => {
      publishedInvoices.push(input.payload.invoice ?? "")
      if (failDelivery) throw new Error("relay delivery failed")
    })
    const dependencies = createDependencies(store, {
      fetchLnurlInvoice,
      publish,
    })
    const module = createMerchantInvoiceModule(dependencies)

    await expect(
      module.createAndDeliver({
        ...createInput(),
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow("relay delivery failed")
    expect(await module.getStatus(createInput())).toEqual({
      state: "pending",
    })

    failDelivery = false
    const reloaded = createMerchantInvoiceModule(dependencies)
    await expect(reloaded.retryDelivery(createInput())).resolves.toBeUndefined()
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(1)
    expect(publishedInvoices).toEqual([INVOICE, INVOICE])
  })

  it("keeps saved invoices scoped to the original buyer", async () => {
    const store = new MemoryPendingInvoiceStore()
    const dependencies = createDependencies(store, {
      publish: mock(async () => {
        throw new Error("relay delivery failed")
      }),
    })
    const module = createMerchantInvoiceModule(dependencies)
    await expect(
      module.createAndDeliver({
        ...createInput(),
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow()

    await expect(
      module.retryDelivery({
        ...createInput(),
        buyerPubkey: OTHER_BUYER_PUBKEY,
      })
    ).rejects.toThrow(/different buyer/i)

    await expect(
      module.retryDelivery({ ...createInput(), orderId: "different-order" })
    ).rejects.toThrow(/no saved invoice/i)
  })

  it("rejects order ids that would be rebound by normalization", async () => {
    const store = new MemoryPendingInvoiceStore()
    const exactOrderId = ` ${ORDER_ID} `
    const publish = mock(async () => undefined)
    const module = createMerchantInvoiceModule(
      createDependencies(store, { publish })
    )

    await expect(
      module.createAndDeliver({
        ...createInput(),
        orderId: exactOrderId,
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow(/valid order/i)

    expect(store.rows.size).toBe(0)
    expect(publish).toHaveBeenCalledTimes(0)
  })

  it("blocks replacement until expiry, then permits a new invoice", async () => {
    const store = new MemoryPendingInvoiceStore()
    const dependencies = createDependencies(store, {
      publish: mock(async () => {
        throw new Error("relay delivery failed")
      }),
    })
    const module = createMerchantInvoiceModule(dependencies)
    await expect(
      module.createAndDeliver({
        ...createInput(),
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow()

    await expect(
      module.createAndDeliver({
        ...createInput(),
        source: { type: "manual", invoice: INVOICE },
      })
    ).rejects.toThrow(/saved invoice/i)

    const expiredDependencies = createDependencies(store, {
      now: () => 1_800_003_601_000,
    })
    const expiredModule = createMerchantInvoiceModule(expiredDependencies)
    expect(await expiredModule.getStatus(createInput())).toEqual({
      state: "none",
    })
    const replacementInvoice = makeBolt11Fixture({
      fields: [bolt11PaymentHashField()],
      createdAt: 1_800_003_600,
    })
    await expect(
      expiredModule.createAndDeliver({
        ...createInput(),
        source: { type: "manual", invoice: replacementInvoice },
      })
    ).resolves.toBeUndefined()
    expect(store.rows.get(`${MERCHANT_PUBKEY}:${ORDER_ID}`)).toMatchObject({
      invoice: replacementInvoice,
      deliveryState: "sent",
    })
  })

  it("retries the same invoice after delivery succeeds but final persistence fails", async () => {
    const store = new MemoryPendingInvoiceStore()
    store.failOnPutNumber = 2
    const fetchLnurlInvoice = mock(async () => ({ invoice: INVOICE }))
    const publishedInvoices: string[] = []
    const dependencies = createDependencies(store, {
      fetchLnurlInvoice,
      publish: mock(async (input: { payload: { invoice?: string } }) => {
        publishedInvoices.push(input.payload.invoice ?? "")
      }),
    })

    await expect(
      createMerchantInvoiceModule(dependencies).createAndDeliver({
        ...createInput(),
        source: { type: "profile_lud16" },
      })
    ).rejects.toThrow(/storage failure/i)
    expect(
      await createMerchantInvoiceModule(dependencies).getStatus(createInput())
    ).toEqual({
      state: "pending",
    })

    await expect(
      createMerchantInvoiceModule(dependencies).retryDelivery(createInput())
    ).resolves.toBeUndefined()
    expect(fetchLnurlInvoice).toHaveBeenCalledTimes(1)
    expect(publishedInvoices).toEqual([INVOICE, INVOICE])
  })
})
