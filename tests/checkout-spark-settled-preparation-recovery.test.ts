import {
  calculateCheckoutSparkInboundNetworkAllowanceSats,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeeRecipient,
  DexieCheckoutSparkSettledRepository,
  fetchLnurlPayMetadata,
} from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"
import { CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY } from "@conduit/core/protocol/checkout-spark-commerce-pricing"
import { parseCheckoutSparkSignedProductFields } from "@conduit/core/protocol/checkout-spark-product-fields"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { describe, expect, it, spyOn } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  listCheckoutSparkRecoveryDeliveries,
  publishCheckoutSparkSettledRecoveryHandoff,
  retryStoredCheckoutSparkRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import { findBlockingCheckoutSparkPreparation } from "../apps/market/src/lib/checkout-spark-router-purchase-claim"
import { listCheckoutSparkSettledContinuations } from "../apps/market/src/lib/checkout-spark-settled-continuation"
import {
  prepareCheckoutSparkSettledOrder,
  resumeCheckoutSparkSettledOrder,
} from "../apps/market/src/lib/checkout-spark-settled-entry"
import {
  listCheckoutSparkSettledPreparations,
  prepareCheckoutSparkSettledFunding,
  resumeCheckoutSparkSettledFunding,
  type PrepareCheckoutSparkSettledFundingInput,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import { createInboxDeclarationFixtureEvidence } from "./helpers/inbox-declaration"
import { plainTestSigner } from "./helpers/plain-signer"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import { qualifiedReceiverMetadataFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import { checkoutSparkQuoteFixture } from "./support/checkout-spark-quote-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const PROFILE = finalizeEvent(
  {
    kind: 0,
    created_at: NOW / 1_000,
    tags: [],
    content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
  },
  MERCHANT_SECRET
)
const CLAIM = "12".repeat(32)
const GROSS =
  1_000 +
  calculateConduitCheckoutFeeSats(1_000) +
  calculateCheckoutSparkInboundNetworkAllowanceSats(1_000)
const fundingInvoice = (grossSats: number, createdAt = NOW) =>
  makeSignedBolt11Fixture({
    hrp: `lnbc${grossSats * 10}n`,
    createdAt: createdAt / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(0x44)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      { tag: "x", words: [28, 4] },
    ],
  })
const INVOICE = fundingInvoice(GROSS)

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function fixture(storage: MemoryStorage, now = () => NOW) {
  const signer = plainTestSigner(NDKPrivateKeySigner.generate())
  const quoteAuthority = checkoutSparkQuoteFixture(MERCHANT_SECRET)
  const conduit = checkoutSparkConduitFeeRecipient("production")
  const input: PrepareCheckoutSparkSettledFundingInput = {
    checkoutId: "preparation-recovery-checkout",
    orderId: "preparation-recovery-order",
    purchaseClaimDigest: CLAIM,
    merchantPubkey: MERCHANT,
    network: "mainnet",
    takeoverAt: NOW + 120_000,
    grossFundingSats: GROSS,
    fundingExpirySecs: 900,
    identity: { kind: "signed_in", pubkey: signer.pubkey, signer },
    quoteAuthority,
    sourceEvents: [
      quoteAuthority.products[0]!.supplierAllocation!.revisionEvent!,
      PROFILE,
    ],
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@wallet.conduit.market",
          source: {
            type: "signed_profile",
            profileEventId: PROFILE.id,
            profileEventCreatedAt: PROFILE.created_at,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: conduit,
        destination: {
          type: "lightning_address",
          value: conduit,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: calculateConduitCheckoutFeeSats(1_000),
      },
    ],
    storage,
    recoveryStorage: storage,
  }
  const calls = { open: 0, close: 0, invoice: 0, transport: 0 }
  const controls = { ack: true }
  const inboxEvidence = createInboxDeclarationFixtureEvidence(
    finalizeEvent(
      {
        kind: 10_050,
        created_at: NOW / 1_000,
        tags: [["relay", "wss://merchant.inbox.relay.dev"]],
        content: "",
      },
      MERCHANT_SECRET
    )
  )
  return {
    input,
    signer,
    calls,
    controls,
    inboxEvidence,
    options: {
      now,
      receiverContracts: qualifiedReceiverMetadataFixture(
        "merchant@wallet.conduit.market"
      ).contracts,
      fetchPayoutMetadata: (address: string) =>
        fetchLnurlPayMetadata(address, {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                tag: "payRequest",
                callback: "https://wallet.conduit.market/callback",
                minSendable: 1_000,
                maxSendable: 10_000_000,
                allowsNostr: false,
                metadata:
                  qualifiedReceiverMetadataFixture(address).metadata.metadata,
              }),
              { status: 200 }
            ),
        }),
      createWalletMaterial: () => ({
        walletId: "preparation-recovery-wallet",
        network: "mainnet" as const,
        mnemonic: createRuntimeMnemonic(),
        accountNumber: 1,
      }),
      openWallet: async () => {
        calls.open += 1
      },
      closeWallet: async () => {
        calls.close += 1
      },
      createFundingReceive: async (
        _wallet?: unknown,
        request?: { grossFundingSats: number }
      ) => {
        calls.invoice += 1
        const grossFundingSats = request?.grossFundingSats ?? GROSS
        return {
          walletId: "preparation-recovery-wallet",
          network: "mainnet" as const,
          id: "preparation-recovery-receive",
          paymentRequest:
            grossFundingSats === GROSS
              ? INVOICE
              : fundingInvoice(grossFundingSats),
          paymentHash: "44".repeat(32),
          providerStatus: "INVOICE_CREATED",
          requiredNetSats: grossFundingSats,
          grossFundingSats,
          expirySecs: 900,
          createdAt: NOW,
          expiresAt: NOW + 900_000,
          receiveSettledPolicy: "ordinary-exact-credit-v3" as const,
          receiverIdentityPublicKey: `02${"a".repeat(64)}`,
        }
      },
      publishRecoveryHandoff: async (
        request: Parameters<
          typeof publishCheckoutSparkSettledRecoveryHandoff
        >[0]
      ) =>
        publishCheckoutSparkSettledRecoveryHandoff({
          ...request,
          now,
          transport: {
            ...request.transport,
            recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
            inboxDeclarationEvidenceRepository: await inboxEvidence,
            publishFn: async (_event, plan) => {
              calls.transport += 1
              return {
                attemptedRelayUrls: plan.exclusiveRelayUrls ?? [],
                successfulRelayUrls: controls.ack
                  ? (plan.exclusiveRelayUrls ?? [])
                  : [],
                failedRelayUrls: controls.ack
                  ? []
                  : (plan.exclusiveRelayUrls ?? []),
                relayFailureMessages: {},
              }
            },
          },
        }),
    },
  }
}

function fiatFixture(storage: MemoryStorage, now: () => number) {
  const result = fixture(storage, now)
  const original = result.input.quoteAuthority
  const product = finalizeEvent(
    {
      kind: 30_402,
      created_at: NOW / 1_000,
      tags: [
        ["d", "router-fixture"],
        ["title", "Fiat clock fixture"],
        ["price", "1", "EUR"],
        ["type", "simple", "digital"],
      ],
      content: "Synthetic fiat clock product",
    },
    MERCHANT_SECRET
  )
  // One EUR converts to the existing 1,000-sat fixture allocation.
  result.input.quoteAuthority = {
    ...original,
    pricingPolicy: CHECKOUT_SPARK_HISTORICAL_PRICING_POLICY,
    pricing: {
      ...original.pricing,
      quote: {
        rate: 110_000,
        fetchedAt: NOW,
        source: "coinbase",
        fiatUsdRates: { EUR: 1.1 },
        fiatSource: "ecb",
        fiatSources: { EUR: "ecb" },
      },
      items: original.pricing.items.map((item) => ({
        ...item,
        sourcePrice: { amount: 1, currency: "EUR", normalizedCurrency: "EUR" },
      })),
    },
    products: [
      {
        ...parseCheckoutSparkSignedProductFields(product),
        sourceEventId: product.id,
      },
    ],
    lines: original.lines.map((line) => ({
      ...line,
      productEventId: product.id,
    })),
  }
  result.input.sourceEvents = [product, PROFILE]
  return result
}

function historicalProviderFixture(now: () => number, onRead?: () => void) {
  const reads: { url: URL; at: number }[] = []
  const mock = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    reads.push({ url, at: now() })
    onRead?.()
    if (url.hostname === "api.exchange.coinbase.com") {
      const minute = Date.parse(url.searchParams.get("start")!) / 1_000
      return Response.json([[minute, 109_000, 111_000, 110_000, 110_000, 1]])
    }
    if (url.hostname === "api.frankfurter.dev")
      return Response.json([
        {
          date: url.searchParams.get("date"),
          base: "EUR",
          quote: "USD",
          rate: 1.1,
        },
      ])
    throw new Error("Unexpected synthetic historical provider request")
  })
  return { reads, restore: () => mock.mockRestore() }
}

describe("settled preparation phase recovery", () => {
  it.each([2_000, 2_500])(
    "waits for the full provider precision of a fiat invoice %i ms ahead before verifying or exposing funding",
    async (lead) => {
      const database = new ConduitDB(`fiat-clock-${crypto.randomUUID()}`, {
        indexedDB,
        IDBKeyRange,
      })
      const timers: ReturnType<typeof setTimeout>[] = []
      let clock = NOW
      const provider = historicalProviderFixture(() => clock)
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        const storage = new MemoryStorage()
        const { input, options, calls } = fiatFixture(storage, () => clock)
        const providerCreatedAtMs = NOW + lead
        const invoiceCreatedAt = Math.floor(providerCreatedAtMs / 1_000) * 1_000
        let preparedAt = 0
        let checkedAtInvoiceSecond = false
        const result = await prepareCheckoutSparkSettledFunding(input, {
          ...options,
          repository,
          createFundingReceive: async (...args) => {
            const receive = await options.createFundingReceive(...args)
            timers.push(
              setTimeout(() => {
                clock = invoiceCreatedAt
                checkedAtInvoiceSecond =
                  provider.reads.length === 0 &&
                  calls.transport === 0 &&
                  listCheckoutSparkSettledPreparations(storage).length === 0
              }, 25)
            )
            timers.push(
              setTimeout(() => {
                clock = providerCreatedAtMs
              }, 175)
            )
            return {
              ...receive,
              createdAt: invoiceCreatedAt,
              expiresAt: invoiceCreatedAt + 900_000,
              providerCreatedAtMs,
              providerExpiresAtMs: providerCreatedAtMs + 900_000,
              paymentRequest: fundingInvoice(
                receive.grossFundingSats,
                invoiceCreatedAt
              ),
            }
          },
          publishRecoveryHandoff: async (request) => {
            preparedAt = request.preparedAt
            return options.publishRecoveryHandoff(request)
          },
        })
        expect(checkedAtInvoiceSecond).toBe(true)
        expect(provider.reads.map(({ url }) => url.hostname).sort()).toEqual([
          "api.exchange.coinbase.com",
          "api.frankfurter.dev",
        ])
        expect(
          provider.reads.every(({ at }) => at >= providerCreatedAtMs)
        ).toBe(true)
        expect(preparedAt).toBeGreaterThanOrEqual(providerCreatedAtMs)
        expect(result.plan.commerceQuote.pricing?.version).toBe(2)
        expect(result.plan.createdAt).toBe(invoiceCreatedAt)
        expect(result.fundingReceive.providerCreatedAtMs).toBe(
          providerCreatedAtMs
        )
        expect(result.fundingInvoice).toBe(result.fundingReceive.paymentRequest)
        expect(calls).toEqual({ open: 1, close: 0, invoice: 1, transport: 1 })
      } finally {
        timers.forEach(clearTimeout)
        provider.restore()
        database.close()
        await database.delete()
      }
    }
  )

  it.each(["excessive_skew", "takeover", "revoked", "frozen_clock"] as const)(
    "refuses a fiat invoice with %s without a handoff or funding exposure",
    async (mode) => {
      const database = new ConduitDB(`fiat-clock-${crypto.randomUUID()}`, {
        indexedDB,
        IDBKeyRange,
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      let clock = NOW
      let active = true
      const provider = historicalProviderFixture(() => clock)
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        const storage = new MemoryStorage()
        const { input, options, calls } = fiatFixture(storage, () => clock)
        // The raw excessive lead exceeds the bound even though its invoice
        // timestamp is rounded down to exactly five seconds ahead.
        const providerCreatedAtMs =
          NOW + (mode === "excessive_skew" ? 5_500 : 3_500)
        const invoiceCreatedAt = Math.floor(providerCreatedAtMs / 1_000) * 1_000
        const preparing = prepareCheckoutSparkSettledFunding(
          { ...input, shouldContinue: () => active },
          {
            ...options,
            repository,
            createFundingReceive: async (...args) => {
              const receive = await options.createFundingReceive(...args)
              if (mode === "revoked")
                timer = setTimeout(() => {
                  active = false
                }, 25)
              if (mode === "takeover")
                timer = setTimeout(() => {
                  clock = input.takeoverAt
                }, 25)
              return {
                ...receive,
                createdAt: invoiceCreatedAt,
                expiresAt: invoiceCreatedAt + 900_000,
                providerCreatedAtMs,
                providerExpiresAtMs: providerCreatedAtMs + 900_000,
                paymentRequest: fundingInvoice(
                  receive.grossFundingSats,
                  invoiceCreatedAt
                ),
              }
            },
          }
        )
        await expect(
          preparing.catch((error) => {
            throw error.cause ?? error
          })
        ).rejects.toThrow(
          mode === "revoked"
            ? "session changed"
            : mode === "takeover"
              ? "routing window"
              : "clock cannot admit"
        )
        if (mode !== "takeover") expect(provider.reads).toHaveLength(0)
        expect(calls.transport).toBe(0)
        expect(listCheckoutSparkSettledPreparations(storage)).toHaveLength(0)
        expect(
          (await repository.load(input.checkoutId, "a".repeat(64))).status
        ).toBe("absent")
      } finally {
        clearTimeout(timer)
        provider.restore()
        database.close()
        await database.delete()
      }
    },
    10_000
  )

  it.each(["missing", "non_integer", "mismatched_bucket"] as const)(
    "refuses %s fiat provider precision before provider reads or funding exposure",
    async (mode) => {
      const database = new ConduitDB(`fiat-clock-${crypto.randomUUID()}`, {
        indexedDB,
        IDBKeyRange,
      })
      const provider = historicalProviderFixture(() => NOW)
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        const storage = new MemoryStorage()
        const { input, options, calls } = fiatFixture(storage, () => NOW)
        await expect(
          prepareCheckoutSparkSettledFunding(input, {
            ...options,
            repository,
            createFundingReceive: async (...args) => ({
              ...(await options.createFundingReceive(...args)),
              ...(mode === "missing"
                ? {}
                : {
                    providerCreatedAtMs:
                      mode === "non_integer" ? NOW + 0.5 : NOW - 1_000,
                    providerExpiresAtMs: NOW + 900_000,
                  }),
            }),
          })
        ).rejects.toThrow()
        expect(provider.reads).toHaveLength(0)
        expect(calls).toEqual({ open: 1, close: 1, invoice: 1, transport: 0 })
        expect(listCheckoutSparkSettledPreparations(storage)).toHaveLength(0)
        expect(
          (await repository.load(input.checkoutId, "a".repeat(64))).status
        ).toBe("absent")
      } finally {
        provider.restore()
        database.close()
        await database.delete()
      }
    }
  )

  it("refuses a fiat invoice when the caller clock moves backward during historical verification", async () => {
    const database = new ConduitDB(`fiat-clock-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    const providerCreatedAtMs = NOW + 10_000
    let clock = providerCreatedAtMs
    const provider = historicalProviderFixture(
      () => clock,
      () => {
        clock = providerCreatedAtMs - 1
      }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const storage = new MemoryStorage()
      const { input, options, calls } = fiatFixture(storage, () => clock)
      await expect(
        prepareCheckoutSparkSettledFunding(input, {
          ...options,
          repository,
          createFundingReceive: async (...args) => {
            const receive = await options.createFundingReceive(...args)
            return {
              ...receive,
              createdAt: providerCreatedAtMs,
              expiresAt: providerCreatedAtMs + 900_000,
              providerCreatedAtMs,
              providerExpiresAtMs: providerCreatedAtMs + 900_000,
              paymentRequest: fundingInvoice(
                receive.grossFundingSats,
                providerCreatedAtMs
              ),
            }
          },
        }).catch((error) => {
          throw error.cause ?? error
        })
      ).rejects.toThrow("clock cannot admit")
      expect(provider.reads).toHaveLength(2)
      expect(calls).toEqual({ open: 1, close: 1, invoice: 1, transport: 0 })
      expect(listCheckoutSparkSettledPreparations(storage)).toHaveLength(0)
      expect(
        (await repository.load(input.checkoutId, "a".repeat(64))).status
      ).toBe("absent")
    } finally {
      provider.restore()
      database.close()
      await database.delete()
    }
  })

  it("waits for a slightly ahead provider invoice clock before exposing funding", async () => {
    const database = new ConduitDB(`preparation-clock-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const storage = new MemoryStorage()
      let clock = NOW
      const { input, options, calls } = fixture(storage, () => clock)
      let preparedAt = 0
      let issuedInvoice = ""
      const result = await prepareCheckoutSparkSettledFunding(input, {
        ...options,
        repository,
        now: () => clock,
        createFundingReceive: async (...args) => {
          const receive = await options.createFundingReceive(...args)
          timer = setTimeout(() => {
            clock = NOW + 2_000
          }, 1_000)
          issuedInvoice = fundingInvoice(receive.grossFundingSats, NOW + 2_000)
          return {
            ...receive,
            createdAt: NOW + 2_000,
            expiresAt: NOW + 902_000,
            paymentRequest: issuedInvoice,
          }
        },
        publishRecoveryHandoff: async (request) => {
          preparedAt = request.preparedAt
          return options.publishRecoveryHandoff(request)
        },
      })
      expect(preparedAt).toBeGreaterThanOrEqual(NOW + 2_000)
      expect(result.fundingInvoice === issuedInvoice).toBe(true)
      expect(result.plan.createdAt).toBe(NOW + 2_000)
      expect(result.plan.takeoverAt).toBe(input.takeoverAt)
      expect(calls).toEqual({ open: 1, close: 0, invoice: 1, transport: 1 })
    } finally {
      clearTimeout(timer)
      database.close()
      await database.delete()
    }
  })

  it.each([
    "excessive_skew",
    "takeover",
    "revoked",
    "frozen_clock",
    "delayed_wake",
  ] as const)(
    "refuses %s without a handoff or funding exposure",
    async (mode) => {
      const database = new ConduitDB(
        `preparation-clock-${crypto.randomUUID()}`,
        { indexedDB, IDBKeyRange }
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      let elapsed = 0
      const monotonic =
        mode === "delayed_wake"
          ? spyOn(performance, "now").mockImplementation(() => elapsed)
          : undefined
      try {
        const repository = new DexieCheckoutSparkSettledRepository(database)
        const storage = new MemoryStorage()
        let clock = NOW
        let active = true
        const { input, options, calls } = fixture(storage, () => clock)
        const lead = mode === "excessive_skew" ? 6_000 : 2_000
        const preparing = prepareCheckoutSparkSettledFunding(
          { ...input, shouldContinue: () => active },
          {
            ...options,
            repository,
            createFundingReceive: async (...args) => {
              const receive = await options.createFundingReceive(...args)
              if (mode === "delayed_wake")
                timer = setTimeout(() => {
                  clock = NOW + lead
                  elapsed = 6_000
                }, 25)
              if (mode === "revoked")
                timer = setTimeout(() => {
                  active = false
                }, 25)
              if (mode === "takeover")
                timer = setTimeout(() => {
                  clock = input.takeoverAt
                }, 25)
              return {
                ...receive,
                createdAt: NOW + lead,
                expiresAt: NOW + 900_000 + lead,
                paymentRequest: fundingInvoice(
                  receive.grossFundingSats,
                  NOW + lead
                ),
              }
            },
          }
        )
        await expect(
          preparing.catch((error) => {
            throw error.cause ?? error
          })
        ).rejects.toThrow(
          mode === "revoked"
            ? "session changed"
            : mode === "takeover"
              ? "routing window"
              : "clock cannot admit"
        )
        expect(calls.transport).toBe(0)
        expect(listCheckoutSparkSettledPreparations(storage)).toHaveLength(0)
        expect(
          (await repository.load(input.checkoutId, "a".repeat(64))).status
        ).toBe("absent")
      } finally {
        clearTimeout(timer)
        monotonic?.mockRestore()
        database.close()
        await database.delete()
      }
    },
    10_000
  )

  it("retains the original draft through lost recovery ACK and seedless reload; a changed cart cannot replace it", async () => {
    const database = new ConduitDB(
      `preparation-recovery-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      const storage = new MemoryStorage()
      const draftStorage = new MemoryStorage()
      const { input, calls, controls, options, inboxEvidence } =
        fixture(storage)
      controls.ack = false
      const quote = input.quoteAuthority
      const entryInput = {
        checkoutId: input.checkoutId,
        orderId: input.orderId,
        purchaseClaimDigest: CLAIM,
        buyer: input.identity,
        network: input.network,
        nowMs: NOW,
        shouldContinue: () => true,
        note: "Original synthetic draft",
        quoteAuthority: {
          ...quote,
          pricing: {
            ...quote.pricing,
            itemSubtotalSats: 1_000,
            totalMsats: 1_000_000,
            paymentRequired: true,
            approximate: false,
            shippingCost: {
              status: "not_required" as const,
              totalSats: 0,
              missingProductIds: [],
            },
            items: quote.pricing.items.map((item) => ({
              ...item,
              format: "digital" as const,
              currency: "SATS" as const,
              shippingCostSats: undefined,
            })),
          },
        },
      }
      let orderPublications = 0
      await expect(
        prepareCheckoutSparkSettledOrder(entryInput, {
          now: () => NOW,
          continuationStorage: draftStorage,
          readRecipientPayout: async () => ({
            state: "ready",
            lud16: "merchant@wallet.conduit.market",
            profileEventId: PROFILE.id,
            profileEventCreatedAt: PROFILE.created_at,
            signedEvent: PROFILE,
          }),
          prepareFunding: (request) =>
            prepareCheckoutSparkSettledFunding(
              { ...request, storage, recoveryStorage: storage },
              { ...options, repository }
            ),
          publishOrder: async () => {
            orderPublications += 1
            throw new Error("No publication before recovery ACK")
          },
        })
      ).rejects.toThrow("without a relay ACK")
      expect(orderPublications).toBe(0)
      const saved = listCheckoutSparkSettledContinuations(
        input.identity.pubkey,
        NOW + 180_000,
        draftStorage
      )[0]!
      expect(saved.order.note === "Original synthetic draft").toBe(true)
      const original = (await listCheckoutSparkRecoveryDeliveries(storage))[0]!
      controls.ack = true
      // A new render/cart is deliberately different; no new cart enters the
      // continuation interface. The saved payload remains the only source.
      entryInput.note = "Changed synthetic draft"
      entryInput.quoteAuthority.pricing.items[0]!.quantity = 9
      let sameDraft = false
      const result = await resumeCheckoutSparkSettledOrder(
        {
          checkoutId: input.checkoutId,
          buyer: input.identity,
          shouldContinue: () => true,
        },
        {
          now: () => NOW + 180_000,
          continuationStorage: draftStorage,
          isWalletOpen: () => false,
          readOrder: async () => undefined,
          resumeFunding: (request) =>
            resumeCheckoutSparkSettledFunding(
              { ...request, storage, recoveryStorage: storage },
              {
                repository,
                now: () => NOW + 180_000,
                retryRecovery: async (retry) =>
                  retryStoredCheckoutSparkRecoveryHandoff({
                    ...retry,
                    recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
                    inboxDeclarationEvidenceRepository: await inboxEvidence,
                    publishFn: async (event, plan) => {
                      expect(
                        JSON.stringify(event) ===
                          JSON.stringify(original.record.signedRecipientWrap)
                      ).toBe(true)
                      calls.transport += 1
                      return {
                        attemptedRelayUrls: plan.exclusiveRelayUrls ?? [],
                        successfulRelayUrls: plan.exclusiveRelayUrls ?? [],
                        failedRelayUrls: [],
                        relayFailureMessages: {},
                      }
                    },
                  }),
              }
            ),
          publishOrder: async (request) => {
            sameDraft =
              request.order.note === "Original synthetic draft" &&
              request.order.items[0]!.quantity === 1
            orderPublications += 1
            return {
              orderId: request.order.id,
              delivery: {
                buyerSelfCopyError: null,
                localCacheError: null,
                deliveryRoute: "declared_inbox",
                companionNotification: Promise.resolve("sent"),
              },
            }
          },
        }
      )
      expect(sameDraft).toBe(true)
      expect(orderPublications).toBe(1)
      expect(result.nextStep).toBe("merchant_recovery")
      expect(result.buyerWalletAvailable).toBe(false)
      expect(calls).toEqual({ open: 1, close: 0, invoice: 1, transport: 2 })
      expect(
        listCheckoutSparkSettledContinuations(
          input.identity.pubkey,
          NOW + 180_000,
          draftStorage
        )
      ).toHaveLength(0)
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("preserves an exact wrap after outbox readback failure and resumes it after handoff without a second wallet or receive", async () => {
    const database = new ConduitDB(
      `preparation-recovery-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      class ReadbackFailureStorage extends MemoryStorage {
        failReadback = false
        override setItem(key: string, value: string): void {
          super.setItem(key, value)
          if (key.includes("recovery-outbox")) this.failReadback = true
        }
        override getItem(key: string): string | null {
          if (key.includes("recovery-outbox") && this.failReadback) {
            this.failReadback = false
            throw new Error("Synthetic outbox readback failure")
          }
          return super.getItem(key)
        }
      }
      const storage = new ReadbackFailureStorage()
      const { input, calls, options, inboxEvidence } = fixture(storage)
      await expect(
        prepareCheckoutSparkSettledFunding(input, { ...options, repository })
      ).rejects.toThrow("Synthetic outbox readback failure")
      expect(calls.close).toBe(0)
      expect(calls.transport).toBe(0)
      const original = (await listCheckoutSparkRecoveryDeliveries(storage))[0]!
      expect(original !== undefined).toBe(true)
      expect(original.deliveryProgress.acknowledgedRelayRefs).toHaveLength(0)
      const originalSet = storage.setItem.bind(storage)
      storage.setItem = (key, value) => {
        originalSet(key, value)
        storage.failReadback = false
      }
      let publishedExact = false
      const resumed = await resumeCheckoutSparkSettledFunding(
        {
          checkoutId: input.checkoutId,
          orderId: input.orderId,
          planDigest: original.record.planDigest,
          merchantPubkey: input.merchantPubkey,
          buyerPubkey: input.identity.pubkey,
          shouldContinue: () => true,
          storage,
          recoveryStorage: storage,
        },
        {
          repository,
          now: () => NOW + 180_000,
          retryRecovery: async (request) =>
            retryStoredCheckoutSparkRecoveryHandoff({
              ...request,
              recipientInboxRelays: ["wss://merchant.inbox.relay.dev"],
              inboxDeclarationEvidenceRepository: await inboxEvidence,
              publishFn: async (event, plan) => {
                publishedExact =
                  JSON.stringify(event) ===
                  JSON.stringify(original.record.signedRecipientWrap)
                calls.transport += 1
                return {
                  attemptedRelayUrls: plan.exclusiveRelayUrls ?? [],
                  successfulRelayUrls: plan.exclusiveRelayUrls ?? [],
                  failedRelayUrls: [],
                  relayFailureMessages: {},
                }
              },
            }),
        }
      )
      expect(publishedExact).toBe(true)
      expect(resumed.plan.planDigest === original.record.planDigest).toBe(true)
      expect(resumed.fundingInvoice === INVOICE).toBe(true)
      expect(calls).toEqual({ open: 1, close: 0, invoice: 1, transport: 1 })
      expect(await listCheckoutSparkRecoveryDeliveries(storage)).toHaveLength(1)
      expect(
        findBlockingCheckoutSparkPreparation(
          listCheckoutSparkSettledPreparations(storage),
          CLAIM,
          NOW + 180_000
        )
      ).toBe(true)
    } finally {
      database.close()
      await database.delete()
    }
  })
})
