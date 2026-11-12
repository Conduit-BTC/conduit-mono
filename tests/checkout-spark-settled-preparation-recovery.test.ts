import {
  calculateCheckoutSparkInboundNetworkAllowanceSats,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeeRecipient,
  DexieCheckoutSparkSettledRepository,
  fetchLnurlPayMetadata,
} from "@conduit/core"
import { ConduitDB } from "@conduit/core/db"
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

describe("settled preparation phase recovery", () => {
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
