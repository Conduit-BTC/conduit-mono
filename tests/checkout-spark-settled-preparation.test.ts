import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  calculateCheckoutSparkInboundNetworkAllowanceSats,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeeRecipient,
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkSettledReconciliation,
  fetchLnurlPayMetadata,
  parseProductEvent,
  type LnurlPayMetadata,
  type CheckoutSparkSettledRepositorySnapshot,
} from "@conduit/core"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  CheckoutSparkSettledFundingMetadataPreflightError,
  getCheckoutSparkSettledPreparation,
  loadAuthorizedCheckoutSparkSettledFunding,
  prepareCheckoutSparkSettledFunding,
  saveCheckoutSparkSettledPreparation,
  type PrepareCheckoutSparkSettledFundingInput,
} from "../apps/market/src/lib/checkout-spark-settled-preparation"
import { acquireCheckoutSparkWalletRetentionLock } from "../apps/market/src/lib/checkout-spark-wallet-retention-lock"
import { createCheckoutSparkSettledFundingBridge } from "../apps/market/src/lib/checkout-spark-settled-funding"
import { payCheckoutInvoice } from "../apps/market/src/lib/payment-rails"
import { closeUnusedSparkWallets } from "../apps/market/src/lib/checkout-spark-router-wallet-retention"
import { checkoutSparkQuoteFixture } from "./support/checkout-spark-quote-fixture"
import { createSessionGuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"

const MNEMONIC = createRuntimeMnemonic()

const NOW = 1_800_000_000_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const MERCHANT_PROFILE = finalizeEvent(
  {
    kind: 0,
    created_at: NOW / 1_000,
    tags: [],
    content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
  },
  MERCHANT_SECRET
)
const BUYER = NDKPrivateKeySigner.generate()
const RECEIVER_IDENTITY = `02${"a".repeat(64)}`
const GROSS =
  1_000 +
  calculateConduitCheckoutFeeSats(1_000) +
  calculateCheckoutSparkInboundNetworkAllowanceSats(1_000)
const HASH = "44".repeat(32)
const INVOICE = makeSignedBolt11Fixture({
  hrp: `lnbc${GROSS * 10}n`,
  createdAt: NOW / 1_000,
  fields: [
    bolt11PaymentHashField(new Uint8Array(32).fill(0x44)),
    bolt11PaymentSecretField(),
    bolt11PlainDescriptionField(),
    { tag: "x", words: [9, 12] }, // 300 seconds
  ],
})

class MemoryStorage {
  values = new Map<string, string>()
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

function request(
  storage: MemoryStorage
): PrepareCheckoutSparkSettledFundingInput {
  const conduit = checkoutSparkConduitFeeRecipient("production")
  const quoteAuthority = checkoutSparkQuoteFixture(MERCHANT_SECRET)
  return {
    checkoutId: "checkout-settled-test",
    orderId: "order-settled-test",
    merchantPubkey: MERCHANT,
    network: "mainnet" as const,
    takeoverAt: NOW + 45 * 60_000,
    grossFundingSats: GROSS,
    fundingExpirySecs: 300,
    identity: {
      kind: "signed_in" as const,
      pubkey: BUYER.pubkey,
      signer: BUYER,
    },
    quoteAuthority,
    sourceEvents: [
      quoteAuthority.products[0]!.supplierAllocation!.revisionEvent!,
      MERCHANT_PROFILE,
    ],
    recipients: [
      {
        kind: "merchant" as const,
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address" as const,
          value: "merchant@wallet.conduit.market",
          source: {
            type: "signed_profile" as const,
            profileEventId: MERCHANT_PROFILE.id,
            profileEventCreatedAt: NOW / 1_000,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit" as const,
        recipientId: conduit,
        destination: {
          type: "lightning_address" as const,
          value: conduit,
          source: {
            type: "conduit_allowlist" as const,
            policy: "production" as const,
          },
        },
        weightSats: calculateConduitCheckoutFeeSats(1_000),
      },
    ],
    storage,
    recoveryStorage: storage,
  }
}

function dependencies(acknowledged: boolean) {
  const calls = { open: 0, close: 0, publish: 0, invoice: 0 }
  return {
    calls,
    options: {
      now: () => NOW,
      fetchPayoutMetadata: (lud16: string) =>
        fetchLnurlPayMetadata(lud16, {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                tag: "payRequest",
                callback: "https://wallet.conduit.market/callback",
                minSendable: 1_000,
                maxSendable: 10_000_000,
                allowsNostr: false,
                metadata: "[]",
              }),
              { status: 200 }
            ),
        }),
      createWalletMaterial: () => ({
        walletId: "settled-wallet",
        network: "mainnet" as const,
        mnemonic: MNEMONIC,
        accountNumber: 1,
      }),
      openWallet: async () => {
        calls.open += 1
      },
      closeWallet: async () => {
        calls.close += 1
      },
      createFundingReceive: async () => {
        calls.invoice += 1
        return {
          walletId: "settled-wallet",
          network: "mainnet" as const,
          id: "settled-request",
          paymentRequest: INVOICE,
          paymentHash: HASH,
          providerStatus: "INVOICE_CREATED",
          requiredNetSats: GROSS,
          grossFundingSats: GROSS,
          expirySecs: 300,
          createdAt: NOW,
          expiresAt: NOW + 300_000,
          receiveSettledPolicy: "ordinary-exact-credit-v3" as const,
          receiverIdentityPublicKey: RECEIVER_IDENTITY,
        }
      },
      repository: {
        create: async (
          plan: Parameters<typeof createCheckoutSparkSettledReconciliation>[0]
        ) => ({
          status: "active" as const,
          revision: 1,
          state: createCheckoutSparkSettledReconciliation(plan),
        }),
        load: async () => ({ status: "absent" as const }),
      },
      publishRecoveryHandoff: async (input: {
        onPersisted?: (handoffId: string) => void | Promise<void>
      }) => {
        calls.publish += 1
        await input.onPersisted?.("handoff-1")
        return {
          handoffId: "handoff-1",
          canExposeFundingInvoice: acknowledged,
        } as never
      },
      verifyRecoveryAck: () => acknowledged,
    },
  }
}

describe("native treasury preparation", () => {
  it("rejects a malformed configured destination before wallet or invoice creation", async () => {
    const { calls, options } = dependencies(true)
    await expect(
      prepareCheckoutSparkSettledFunding(request(new MemoryStorage()), {
        ...options,
        treasuryConfiguration: { mainnetAddress: "invalid-static-destination" },
        validateTreasuryDestination: async () => {
          throw new Error("Configured treasury address is invalid.")
        },
      })
    ).rejects.toThrow("Configured treasury address is invalid.")
    expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
  })

  it("freezes the native sender-restricted request before exposing funding", async () => {
    const { calls, options } = dependencies(true)
    const sparkAddress = "static-treasury-fixture"
    const receiverIdentityPublicKey = `03${"b".repeat(64)}`
    const storage = new MemoryStorage()
    let preparedInvoiceId: string | undefined
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      {
        ...options,
        treasuryConfiguration: { mainnetAddress: sparkAddress },
        validateTreasuryDestination: async () => {
          expect(calls.open).toBe(0)
          return { sparkAddress, receiverIdentityPublicKey }
        },
        prepareTreasuryRequest: async (input) => {
          expect(calls.publish).toBe(0)
          expect(input.senderIdentityPublicKey).toBe(RECEIVER_IDENTITY)
          preparedInvoiceId = input.invoiceId
          return {
            schemaVersion: 1,
            sparkAddress,
            receiverIdentityPublicKey,
            senderIdentityPublicKey: input.senderIdentityPublicKey,
            invoiceId: input.invoiceId,
            invoiceRequest: "canonical-native-fixture",
            feePolicy: "zero_required",
            residualPolicy: "unused_commerce_reserves",
          }
        },
      }
    )
    expect(prepared.plan.schemaVersion).toBe(4)
    expect(prepared.state.schemaVersion).toBe(5)
    expect(prepared.plan.nativeTreasury?.invoiceId).toBe(preparedInvoiceId)
    expect(prepared.state.treasuryFinalization?.intent).toBeNull()
    expect(prepared.state.treasuryFinalization?.status).toBe("unprepared")
    expect(calls).toEqual({ open: 1, close: 0, publish: 1, invoice: 1 })
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, storage)
        ?.fundingInvoiceExposedAt
    ).toBe(NOW)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function supplierRequest(storage: MemoryStorage, sharedDestination = false) {
  const input = request(storage)
  const secret = generateSecretKey()
  const supplier = getPublicKey(secret)
  const profile = finalizeEvent(
    {
      kind: 0,
      created_at: NOW / 1_000,
      tags: [],
      content: JSON.stringify({
        lud16: sharedDestination
          ? "merchant@wallet.conduit.market"
          : "supplier@wallet.conduit.market",
      }),
    },
    secret
  )
  const original =
    input.quoteAuthority.products[0]!.supplierAllocation!.revisionEvent!
  const product = finalizeEvent(
    {
      kind: 30_402,
      created_at: original.created_at,
      tags: [
        ...original.tags,
        ["conduit_supplier_allocation", "1"],
        ["zap", MERCHANT, "wss://relay.conduit.market", "1"],
        ["zap", supplier, "wss://relay.conduit.market", "1"],
      ],
      content: original.content,
    },
    MERCHANT_SECRET
  )
  input.quoteAuthority.products = [
    { ...parseProductEvent(product), sourceEventId: product.id },
  ]
  input.quoteAuthority.lines = input.quoteAuthority.lines.map((line) => ({
    ...line,
    productEventId: product.id,
  }))
  input.sourceEvents = [product, MERCHANT_PROFILE, profile]
  input.recipients = [
    { ...input.recipients[0]!, weightSats: 500 },
    {
      kind: "supplier",
      recipientId: supplier,
      destination: {
        type: "lightning_address",
        value: sharedDestination
          ? "merchant@wallet.conduit.market"
          : "supplier@wallet.conduit.market",
        source: {
          type: "signed_profile",
          profileEventId: profile.id,
          profileEventCreatedAt: profile.created_at,
        },
      },
      weightSats: 500,
    },
    input.recipients[1]!,
  ]
  return input
}

function physicalRequest(storage: MemoryStorage) {
  const input = request(storage)
  const original =
    input.quoteAuthority.products[0]!.supplierAllocation!.revisionEvent!
  const coordinate = `30406:${MERCHANT}:router-fixture-shipping-standard`
  const shipping = finalizeEvent(
    {
      kind: 30_406,
      created_at: NOW / 1_000 - 1,
      tags: [
        ["d", "router-fixture-shipping-standard"],
        ["title", "Standard shipping"],
        ["price", "200", "SAT"],
        ["country", "US"],
        ["service", "standard"],
      ],
      content: "",
    },
    MERCHANT_SECRET
  )
  const product = finalizeEvent(
    {
      kind: 30_402,
      created_at: original.created_at,
      tags: original.tags
        .map((tag) =>
          tag[0] === "price"
            ? ["price", "800", "SAT"]
            : tag[0] === "type"
              ? ["type", "simple", "physical"]
              : [...tag]
        )
        .concat([["shipping_option", coordinate]]),
      content: original.content,
    },
    MERCHANT_SECRET
  )
  input.quoteAuthority.products = [
    { ...parseProductEvent(product), sourceEventId: product.id },
  ]
  input.quoteAuthority.pricing.items = input.quoteAuthority.pricing.items.map(
    (item) => ({
      ...item,
      priceAtPurchase: 800,
      shippingCostSats: 200,
      shippingOptionId: coordinate,
    })
  )
  input.quoteAuthority.lines = input.quoteAuthority.lines.map((line) => ({
    ...line,
    productEventId: product.id,
    shippingOption: { coordinate, eventId: shipping.id },
  }))
  input.quoteAuthority.shippingSourceEvents = [shipping]
  input.sourceEvents = [product, shipping, MERCHANT_PROFILE]
  return input
}

describe("settled Spark pre-funding metadata", () => {
  it("binds exact fixed shipping to recovery before exposing the funding invoice", async () => {
    const input = physicalRequest(new MemoryStorage())
    const { options, calls } = dependencies(true)
    let recoveryShipping = 0
    const prepared = await prepareCheckoutSparkSettledFunding(input, {
      ...options,
      publishRecoveryHandoff: async (handoff) => {
        recoveryShipping = handoff.sourceEvents!.filter(
          (event) => event.kind === 30_406
        ).length
        return options.publishRecoveryHandoff(handoff)
      },
    })
    expect(recoveryShipping).toBe(1)
    expect(prepared.plan.commerceQuote.lines[0]!.unitShippingSats).toBe(200)
    expect(prepared.plan.recipients[0]!.weightSats).toBe(1_000)
    expect(calls).toEqual({ open: 1, close: 0, publish: 1, invoice: 1 })
  })

  it("rejects missing fixed-shipping authority before metadata or wallet work", async () => {
    const input = physicalRequest(new MemoryStorage())
    input.sourceEvents = input.sourceEvents.filter(
      (event) => event.kind !== 30_406
    )
    const { options, calls } = dependencies(true)
    let metadataReads = 0
    await expect(
      prepareCheckoutSparkSettledFunding(input, {
        ...options,
        fetchPayoutMetadata: async (address) => {
          metadataReads++
          return options.fetchPayoutMetadata(address)
        },
      })
    ).rejects.toThrow("exact signed product allocation evidence")
    expect(metadataReads).toBe(0)
    expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
  })

  it.each([false, true])(
    "checks each distinct required destination before any wallet work, shared=%s",
    async (shared) => {
      const input = supplierRequest(new MemoryStorage(), shared)
      const { options, calls } = dependencies(true)
      const reads: string[] = []
      const expected = shared
        ? ["merchant@wallet.conduit.market"]
        : ["merchant@wallet.conduit.market", "supplier@wallet.conduit.market"]
      const prepared = await prepareCheckoutSparkSettledFunding(input, {
        ...options,
        fetchPayoutMetadata: async (lud16) => {
          expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
          reads.push(lud16)
          return options.fetchPayoutMetadata(lud16)
        },
        createWalletMaterial: () => {
          expect(reads).toEqual(expected)
          return options.createWalletMaterial()
        },
      })
      expect(reads).toEqual(expected)
      expect(prepared.state.credit).toBeNull()
      expect(
        prepared.state.legs.every(
          (leg) => leg.intent === null && leg.allocationSats === null
        )
      ).toBe(true)
      expect(calls).toEqual({ open: 1, close: 0, publish: 1, invoice: 1 })
    }
  )

  it("uses only the gross ceiling, not a promised recipient allocation or net amount", async () => {
    const { options } = dependencies(true)
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(new MemoryStorage()),
      {
        ...options,
        fetchPayoutMetadata: async (lud16) => ({
          ...(await options.fetchPayoutMetadata(lud16)),
          minSendable: (GROSS - 1) * 1_000,
          maxSendable: (GROSS - 1) * 1_000,
        }),
      }
    )
    expect(prepared.plan.recipients[0]?.weightSats).toBe(1_000)
    expect(prepared.state.credit).toBeNull()
    expect(prepared.state.legs[0]?.allocationSats).toBeNull()
  })

  it.each(["unavailable", "incompatible", "above_gross_ceiling"])(
    "fails %s with a safe typed preflight error and no wallet work",
    async (failure) => {
      const storage = new MemoryStorage()
      const { options, calls } = dependencies(true)
      let generated = 0
      let error: unknown
      try {
        await prepareCheckoutSparkSettledFunding(request(storage), {
          ...options,
          fetchPayoutMetadata: async (lud16) => {
            if (failure === "unavailable")
              throw new Error("Synthetic transport unavailable")
            return {
              ...(await options.fetchPayoutMetadata(lud16)),
              minSendable: failure === "incompatible" ? 1_001 : GROSS * 1_000,
              maxSendable: failure === "incompatible" ? 1_999 : GROSS * 1_000,
            }
          },
          createWalletMaterial: () => {
            generated++
            return options.createWalletMaterial()
          },
        })
      } catch (cause) {
        error = cause
      }
      expect(error).toBeInstanceOf(
        CheckoutSparkSettledFundingMetadataPreflightError
      )
      expect(error).not.toHaveProperty("cause")
      expect(String(error)).not.toContain("wallet.conduit.market")
      expect(generated).toBe(0)
      expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
      expect(
        getCheckoutSparkSettledPreparation("checkout-settled-test", storage)
      ).toBeNull()
    }
  )

  it("retries the same checkout after a metadata outage without a previous wallet or invoice", async () => {
    const input = request(new MemoryStorage())
    const { options, calls } = dependencies(true)
    let reads = 0
    const retryOptions = {
      ...options,
      fetchPayoutMetadata: async (lud16: string) => {
        if (++reads === 1) throw new Error("Synthetic temporary outage")
        return options.fetchPayoutMetadata(lud16)
      },
    }
    await expect(
      prepareCheckoutSparkSettledFunding(input, retryOptions)
    ).rejects.toBeInstanceOf(CheckoutSparkSettledFundingMetadataPreflightError)
    expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
    const prepared = await prepareCheckoutSparkSettledFunding(
      input,
      retryOptions
    )
    expect(prepared.plan.checkoutId).toBe(input.checkoutId)
    expect(reads).toBe(2)
    expect(calls).toEqual({ open: 1, close: 0, publish: 1, invoice: 1 })
  })

  it.each(["account_changed", "guest_expired", "guest_caller_revoked"])(
    "does no wallet work after %s during a held metadata read",
    async (reason) => {
      const input = supplierRequest(new MemoryStorage())
      let clock = NOW
      let active = true
      input.shouldContinue = () => active
      if (reason !== "account_changed") {
        input.identity = createSessionGuestOrderSigningIdentity(
          input.orderId,
          MERCHANT,
          { storage: null, nowMs: NOW }
        )
      }
      const { options, calls } = dependencies(true)
      const started = deferred<void>()
      const held = deferred<LnurlPayMetadata>()
      let reads = 0
      let generated = 0
      const operation = prepareCheckoutSparkSettledFunding(input, {
        ...options,
        now: () => clock,
        fetchPayoutMetadata: async () => {
          reads++
          started.resolve()
          return held.promise
        },
        createWalletMaterial: () => {
          generated++
          return options.createWalletMaterial()
        },
      })
      await Promise.race([started.promise, operation])
      if (
        reason === "guest_expired" &&
        input.identity.kind === "guest_ephemeral"
      )
        clock = input.identity.expiresAt
      else active = false
      input.shouldContinue = () => true // The original live callback remains bound.
      held.resolve(
        await options.fetchPayoutMetadata("merchant@wallet.conduit.market")
      )
      await expect(operation).rejects.toThrow("buyer session changed")
      expect(reads).toBe(1)
      expect(generated).toBe(0)
      expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
    }
  )

  it("pins scalar terms, signer identity, source graph and callback before metadata awaits", async () => {
    const storage = new MemoryStorage()
    const input = request(storage)
    input.shouldContinue = () => true
    const originalIdentity = input.identity
    const originalRecipients = structuredClone(input.recipients)
    const { options } = dependencies(true)
    const started = deferred<void>()
    const held = deferred<LnurlPayMetadata>()
    const operation = prepareCheckoutSparkSettledFunding(input, {
      ...options,
      fetchPayoutMetadata: async () => {
        started.resolve()
        return held.promise
      },
      publishRecoveryHandoff: async (handoff) => {
        expect(handoff.identity).toEqual(originalIdentity)
        return options.publishRecoveryHandoff(handoff)
      },
    })
    await Promise.race([started.promise, operation])
    input.checkoutId = "later-checkout"
    input.orderId = "later-order"
    const laterSigner = NDKPrivateKeySigner.generate()
    input.merchantPubkey = laterSigner.pubkey
    input.network = "regtest"
    input.takeoverAt = NOW
    input.grossFundingSats++
    input.fundingExpirySecs++
    input.identity = {
      kind: "signed_in",
      pubkey: laterSigner.pubkey,
      signer: laterSigner,
    }
    input.shouldContinue = () => false
    input.recipients = []
    input.sourceEvents = []
    input.quoteAuthority.products = []
    input.storage = new MemoryStorage()
    input.recoveryStorage = input.storage
    held.resolve(
      await options.fetchPayoutMetadata("merchant@wallet.conduit.market")
    )
    const prepared = await operation
    expect(prepared.plan).toMatchObject({
      checkoutId: "checkout-settled-test",
      orderId: "order-settled-test",
      merchantPubkey: MERCHANT,
      network: "mainnet",
      takeoverAt: NOW + 45 * 60_000,
    })
    expect(
      prepared.plan.recipients.map(
        ({ kind, recipientId, destination, weightSats }) => ({
          kind,
          recipientId,
          destination,
          weightSats,
        })
      )
    ).toEqual(originalRecipients)
    expect(
      getCheckoutSparkSettledPreparation("checkout-settled-test", storage)
        ?.fundingInvoiceExposedAt
    ).toBe(NOW)
  })

  it("does not generate a wallet if another preparation was saved during metadata", async () => {
    const storage = new MemoryStorage()
    const { options, calls } = dependencies(true)
    let generated = 0
    await expect(
      prepareCheckoutSparkSettledFunding(request(storage), {
        ...options,
        fetchPayoutMetadata: async (lud16) => {
          saveCheckoutSparkSettledPreparation(
            {
              schemaVersion: 3,
              checkoutId: "checkout-settled-test",
              planDigest: "1".repeat(64),
              recoveryHandoffId: null,
              fundingInvoiceExposedAt: null,
              fundingSubmissionState: "not_started",
              savedAt: NOW,
            },
            storage
          )
          return options.fetchPayoutMetadata(lud16)
        },
        createWalletMaterial: () => {
          generated++
          return options.createWalletMaterial()
        },
      })
    ).rejects.toThrow("already prepared")
    expect(generated).toBe(0)
    expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
  })

  it("rechecks competing preparations after waiting for the retention lock", async () => {
    const storage = new MemoryStorage()
    const { options, calls } = dependencies(true)
    let generated = 0
    let reads = 0
    const bothRead = deferred<void>()
    const release = await acquireCheckoutSparkWalletRetentionLock()
    const concurrentOptions = {
      ...options,
      fetchPayoutMetadata: async (lud16: string) => {
        const metadata = await options.fetchPayoutMetadata(lud16)
        if (++reads === 2) bothRead.resolve()
        return metadata
      },
      createWalletMaterial: () => {
        generated++
        return options.createWalletMaterial()
      },
    }
    const first = prepareCheckoutSparkSettledFunding(
      request(storage),
      concurrentOptions
    )
    const second = prepareCheckoutSparkSettledFunding(
      request(storage),
      concurrentOptions
    )
    try {
      await Promise.race([bothRead.promise, first, second])
      expect(generated).toBe(0)
    } finally {
      release()
    }
    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ])
    const rejected = outcomes.find((outcome) => outcome.status === "rejected")
    expect(
      rejected?.status === "rejected" && String(rejected.reason)
    ).toContain("already prepared")
    expect(generated).toBe(1)
    expect(calls).toEqual({ open: 1, close: 0, publish: 1, invoice: 1 })
  })
})

describe("settled Spark preparation", () => {
  it("requires complete signed source bytes before creating a wallet", async () => {
    const input = request(new MemoryStorage())
    const { options, calls } = dependencies(true)
    let generated = 0
    await expect(
      prepareCheckoutSparkSettledFunding(
        { ...input, sourceEvents: [] },
        {
          ...options,
          createWalletMaterial: () => {
            generated++
            return options.createWalletMaterial()
          },
        }
      )
    ).rejects.toThrow()
    expect(generated).toBe(0)
    expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
  })

  it("passes the detached exact source bundle into the initial recovery handoff", async () => {
    const input = request(new MemoryStorage())
    const expected = structuredClone(input.sourceEvents)
    const { options } = dependencies(true)
    await prepareCheckoutSparkSettledFunding(input, {
      ...options,
      openWallet: async () => {
        input.sourceEvents = []
      },
      publishRecoveryHandoff: async (handoff) => {
        expect(handoff.sourceEvents).toEqual(
          expected.sort((left, right) => left.id.localeCompare(right.id))
        )
        return options.publishRecoveryHandoff(handoff)
      },
    })
  })
  it.each(["before", "open", "receive", "persist", "ack"])(
    "stops guest preparation after session revocation at %s, preserving an acknowledged recovery",
    async (stage) => {
      const storage = new MemoryStorage()
      const base = request(storage)
      const identity = createSessionGuestOrderSigningIdentity(
        base.orderId,
        MERCHANT,
        {
          storage: null,
          nowMs: NOW,
        }
      )
      const { options, calls } = dependencies(true)
      let active = stage !== "before"
      await expect(
        prepareCheckoutSparkSettledFunding(
          {
            ...base,
            identity,
            shouldContinue: () => active,
          },
          {
            ...options,
            openWallet: async () => {
              await options.openWallet()
              if (stage === "open") active = false
            },
            createFundingReceive: async () => {
              const result = await options.createFundingReceive()
              if (stage === "receive") active = false
              return result
            },
            repository: {
              ...options.repository,
              create: async (plan) => {
                const result = await options.repository.create(plan)
                if (stage === "persist") active = false
                return result
              },
            },
            publishRecoveryHandoff: async (input) => {
              expect(input.transport?.shouldContinue?.()).toBe(true)
              const result = await options.publishRecoveryHandoff(input)
              if (stage === "ack") active = false
              return result
            },
          }
        )
      ).rejects.toThrow("buyer session changed")
      expect(calls.open).toBe(stage === "before" ? 0 : 1)
      expect(calls.invoice).toBe(stage === "before" || stage === "open" ? 0 : 1)
      expect(calls.publish).toBe(stage === "ack" ? 1 : 0)
      expect(calls.close).toBe(stage === "before" || stage === "ack" ? 0 : 1)
      const stored = getCheckoutSparkSettledPreparation(
        base.checkoutId,
        storage
      )
      if (stage === "ack") {
        expect(stored?.recoveryHandoffId).toBe("handoff-1")
        expect(stored?.fundingInvoiceExposedAt).toBeNull()
      } else expect(stored).toBeNull()
    }
  )

  it("rejects an expired guest before generating a wallet or receive request", async () => {
    const storage = new MemoryStorage()
    const base = request(storage)
    const identity = createSessionGuestOrderSigningIdentity(
      base.orderId,
      MERCHANT,
      { storage: null, nowMs: NOW }
    )
    const { options, calls } = dependencies(true)
    await expect(
      prepareCheckoutSparkSettledFunding(
        { ...base, identity, shouldContinue: () => true },
        {
          ...options,
          now: () => identity.expiresAt,
        }
      )
    ).rejects.toThrow("buyer session changed")
    expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
  })

  it("requires a live session callback even for a currently valid captured guest key", async () => {
    const storage = new MemoryStorage()
    const base = request(storage)
    const identity = createSessionGuestOrderSigningIdentity(
      base.orderId,
      MERCHANT,
      { storage: null, nowMs: NOW }
    )
    const { options, calls } = dependencies(true)
    await expect(
      prepareCheckoutSparkSettledFunding({ ...base, identity }, options)
    ).rejects.toThrow("buyer session changed")
    expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
  })

  it("defers registry cleanup until a newly opened checkout wallet has a saved plan", async () => {
    const storage = new MemoryStorage()
    const { options } = dependencies(true)
    const open = new Set<string>()
    let opened!: () => void
    let releaseReceive!: () => void
    const walletOpened = new Promise<void>((resolve) => {
      opened = resolve
    })
    const receiveMayFinish = new Promise<void>((resolve) => {
      releaseReceive = resolve
    })
    let snapshot: CheckoutSparkSettledRepositorySnapshot | null = null
    let cleanupReadStarted = false
    const prepare = prepareCheckoutSparkSettledFunding(request(storage), {
      ...options,
      openWallet: async (wallet) => {
        open.add(wallet.walletId)
        opened()
      },
      closeWallet: async (walletId) => {
        open.delete(walletId)
      },
      createFundingReceive: async (...args) => {
        await receiveMayFinish
        return options.createFundingReceive(...args)
      },
      repository: {
        ...options.repository,
        create: async (plan) => {
          snapshot = await options.repository.create(plan)
          return snapshot
        },
      },
    })
    await walletOpened
    expect(open.has("settled-wallet")).toBe(true)
    expect(
      getCheckoutSparkSettledPreparation("checkout-settled-test", storage)
    ).toBeNull()

    const cleanup = closeUnusedSparkWallets(
      {
        async closeWalletsExcept(keep) {
          for (const walletId of open) {
            if (!keep.has(walletId)) open.delete(walletId)
          }
        },
      },
      [],
      {
        now: NOW,
        listSettledPreparations: () => {
          cleanupReadStarted = true
          const saved = getCheckoutSparkSettledPreparation(
            "checkout-settled-test",
            storage
          )
          return saved ? [saved] : []
        },
        loadSettledSnapshot: async () => {
          if (!snapshot) throw new Error("Plan was not saved")
          return snapshot
        },
      }
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(cleanupReadStarted).toBe(false)
    expect(open.has("settled-wallet")).toBe(true)

    releaseReceive()
    await prepare
    await cleanup
    expect(cleanupReadStarted).toBe(true)
    expect(open.has("settled-wallet")).toBe(true)
  })

  it("rejects missing or excess allowance before creating a wallet or invoice", async () => {
    for (const grossFundingSats of [GROSS - 2, GROSS - 1, GROSS + 1]) {
      const storage = new MemoryStorage()
      const { calls, options } = dependencies(true)
      await expect(
        prepareCheckoutSparkSettledFunding(
          { ...request(storage), grossFundingSats },
          {
            ...options,
            createWalletMaterial: () => {
              throw new Error("must not create a wallet")
            },
          }
        )
      ).rejects.toThrow("gross funding differs from frozen terms")
      expect(calls).toEqual({ open: 0, close: 0, publish: 0, invoice: 0 })
      expect(
        getCheckoutSparkSettledPreparation("checkout-settled-test", storage)
      ).toBeNull()
    }
  })

  it("exposes an ordinary gross invoice only after durable plan, wrap and relay ACK", async () => {
    const storage = new MemoryStorage()
    const { calls, options } = dependencies(true)
    const prepared = await prepareCheckoutSparkSettledFunding(
      { ...request(storage), purchaseClaimDigest: "a".repeat(64) },
      options
    )
    expect(prepared.fundingInvoice).toBe(INVOICE)
    expect(prepared.plan.funding.grossFundingSats).toBe(GROSS)
    expect(prepared.plan.recipients.map((recipient) => recipient.kind)).toEqual(
      ["merchant", "conduit"]
    )
    expect(
      getCheckoutSparkSettledPreparation("checkout-settled-test", storage)
    ).toMatchObject({
      recoveryHandoffId: "handoff-1",
      purchaseClaimDigest: "a".repeat(64),
      fundingInvoiceExposedAt: NOW,
      fundingSubmissionState: "not_started",
    })
    expect(calls).toEqual({ open: 1, close: 0, publish: 1, invoice: 1 })
  })

  it("keeps the invoice hidden when the exact recovery wrap lacks relay ACK", async () => {
    const storage = new MemoryStorage()
    const { calls, options } = dependencies(false)
    await expect(
      prepareCheckoutSparkSettledFunding(request(storage), options)
    ).rejects.toThrow("recovery is not ready")
    expect(
      getCheckoutSparkSettledPreparation("checkout-settled-test", storage)
    ).toMatchObject({
      recoveryHandoffId: "handoff-1",
      fundingInvoiceExposedAt: null,
    })
    expect(calls).toEqual({ open: 1, close: 0, publish: 1, invoice: 1 })
  })

  it("refuses a stored invoice when its initial recovery ACK cannot be independently re-read", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    await expect(
      loadAuthorizedCheckoutSparkSettledFunding(prepared.plan.checkoutId, {
        storage,
        recoveryStorage: storage,
        repository: {
          create: async () => ({ status: "absent" as const }),
          load: async () => ({
            status: "active" as const,
            revision: 1,
            state: prepared.state,
          }),
        },
        now: () => NOW + 1_000,
      })
    ).rejects.toThrow("authorization is stale")
  })
})

describe("settled Spark funding bridge", () => {
  it("inspects the exact receive without paying even if the local clock says the invoice is live", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    let payerCalls = 0
    let creditReads = 0
    const result = await createCheckoutSparkSettledFundingBridge(
      prepared.plan.checkoutId,
      {
        storage,
        requireCrossTabLock: false,
        verifyBuyerAuthority: () => true,
        now: () => prepared.plan.funding.expiresAt - 1,
        loadAuthorized: async () => prepared,
        repository: {
          create: async () => ({ status: "absent" as const }),
          load: async () => ({
            status: "active" as const,
            revision: 1,
            state: prepared.state,
          }),
          save: async () => {
            throw new Error("must not save without credit")
          },
        },
        attestCredit: async () => {
          creditReads += 1
          return null
        },
        payInvoice: async () => {
          payerCalls += 1
          throw new Error("must not pay")
        },
      }
    ).fund({
      buyerPubkey: BUYER.pubkey,
      shouldContinue: () => true,
      inspectionOnly: true,
      paymentTarget: {
        type: "wallet",
        providerId: "spark",
        walletId: "payer",
      },
      walletPaymentAttemptId: "attempt-1",
      timeoutMs: 10_000,
      appId: "market",
    })
    expect(result).toMatchObject({
      status: "manual_required",
      reconciliation: { credit: null },
    })
    expect(creditReads).toBe(1)
    expect(payerCalls).toBe(0)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, storage)
    ).toMatchObject({ fundingSubmissionState: "not_started" })
  })

  it("records exact late credit against the original expired plan without another payment", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    let payerCalls = 0
    let savedState = prepared.state
    let providerCreditRecords = 0
    const result = await createCheckoutSparkSettledFundingBridge(
      prepared.plan.checkoutId,
      {
        storage,
        requireCrossTabLock: false,
        verifyBuyerAuthority: () => true,
        now: () => prepared.plan.funding.expiresAt + 1,
        loadAuthorized: async () => prepared,
        repository: {
          create: async () => ({ status: "absent" as const }),
          load: async () => ({
            status: "active" as const,
            revision: 1,
            state: savedState,
          }),
          save: async (next) => {
            savedState = next
            return { status: "active" as const, revision: 2, state: next }
          },
          recordMerchantCredit: async (
            plan,
            proof,
            _observedAt,
            assertCurrent
          ) => {
            assertCurrent?.()
            expect(plan.planDigest).toBe(prepared.plan.planDigest)
            expect(proof.transferId).toBe("exact-late-credit")
            providerCreditRecords += 1
            return createCheckoutSparkMerchantSettlementRecord(plan)
          },
        },
        attestCredit: async () => ({
          mode: "ordinary_v3",
          requestId: prepared.plan.funding.requestId,
          transferId: "exact-late-credit",
          receiverIdentityPublicKey: RECEIVER_IDENTITY,
          grossSats: GROSS,
          creditedSats: GROSS - 1,
        }),
        payInvoice: async () => {
          payerCalls += 1
          throw new Error("must not pay")
        },
      }
    ).fund({
      buyerPubkey: BUYER.pubkey,
      shouldContinue: () => true,
      inspectionOnly: true,
      paymentTarget: {
        type: "wallet",
        providerId: "spark",
        walletId: "payer",
      },
      walletPaymentAttemptId: "attempt-1",
      timeoutMs: 10_000,
      appId: "market",
    })
    expect(result.status).toBe("funded")
    expect(result.reconciliation.plan.planDigest).toBe(prepared.plan.planDigest)
    expect(result.reconciliation.credit?.creditedSats).toBe(GROSS - 1)
    expect(savedState.credit?.transferId).toBe("exact-late-credit")
    expect(payerCalls).toBe(0)
    expect(providerCreditRecords).toBe(1)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, storage)
    ).toMatchObject({ fundingSubmissionState: "not_started" })
  })

  it("keeps an expired funding invoice on its original order for reconciliation", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    let payerCalls = 0
    const result = await createCheckoutSparkSettledFundingBridge(
      prepared.plan.checkoutId,
      {
        storage,
        requireCrossTabLock: false,
        verifyBuyerAuthority: () => true,
        now: () => prepared.plan.funding.expiresAt + 1,
        loadAuthorized: async () => prepared,
        repository: {
          create: async () => ({ status: "absent" as const }),
          load: async () => ({
            status: "active" as const,
            revision: 1,
            state: prepared.state,
          }),
          save: async () => {
            throw new Error("must not save")
          },
        },
        attestCredit: async () => null,
        payInvoice: async () => {
          payerCalls += 1
          throw new Error("must not pay")
        },
      }
    ).fund({
      buyerPubkey: BUYER.pubkey,
      shouldContinue: () => true,
      paymentTarget: {
        type: "wallet",
        providerId: "spark",
        walletId: "payer",
      },
      walletPaymentAttemptId: "attempt-1",
      timeoutMs: 10_000,
      appId: "market",
    })
    expect(result).toMatchObject({
      status: "manual_required",
      reason: expect.stringContaining("original order"),
      reconciliation: { credit: null },
    })
    expect(payerCalls).toBe(0)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, storage)
    ).toMatchObject({
      planDigest: prepared.plan.planDigest,
      fundingSubmissionState: "not_started",
    })
    expect(prepared.plan.orderId).toBe("order-settled-test")
    expect(prepared.plan.funding.paymentRequest).toBe(INVOICE)
  })

  it("rejects funding if fee approval crosses the invoice deadline before wallet send", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    let clock = prepared.plan.funding.expiresAt - 1
    let walletSends = 0
    const result = await createCheckoutSparkSettledFundingBridge(
      prepared.plan.checkoutId,
      {
        storage,
        requireCrossTabLock: false,
        verifyBuyerAuthority: () => true,
        now: () => clock,
        loadAuthorized: async () => prepared,
        repository: {
          create: async () => ({ status: "absent" as const }),
          load: async () => ({
            status: "active" as const,
            revision: 1,
            state: prepared.state,
          }),
          save: async () => {
            throw new Error("must not save")
          },
        },
        attestCredit: async () => null,
        payInvoice: async (payment) => {
          // The coordinator checks beforeSend before entering the provider.
          await payment.beforeSend?.()
          // Spark fee approval may take arbitrarily long. Its provider calls
          // beforeSend again immediately before the actual wallet send.
          await payment.approveFee?.({
            amountSats: GROSS,
            feeSats: 0,
            totalSats: GROSS,
          })
          try {
            await payment.beforeSend?.()
          } catch (error) {
            return {
              status: "retryable_failure" as const,
              phase: "before_publish" as const,
              reason: error instanceof Error ? error.message : "expired",
            }
          }
          walletSends += 1
          throw new Error("must not send")
        },
      }
    ).fund({
      buyerPubkey: BUYER.pubkey,
      shouldContinue: () => true,
      paymentTarget: {
        type: "wallet",
        providerId: "spark",
        walletId: "payer",
      },
      walletPaymentAttemptId: "attempt-1",
      approveFee: async () => {
        clock = prepared.plan.funding.expiresAt
        return true
      },
      timeoutMs: 10_000,
      appId: "market",
    })
    expect(result).toMatchObject({
      status: "payment_retryable",
      reason: expect.stringContaining("expired"),
      reconciliation: { credit: null },
    })
    expect(walletSends).toBe(0)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, storage)
    ).toMatchObject({ fundingSubmissionState: "not_started" })
  })

  it("rechecks the invoice deadline after the caller's final beforeSend await", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    let clock = prepared.plan.funding.expiresAt - 1
    let walletSends = 0
    const result = await createCheckoutSparkSettledFundingBridge(
      prepared.plan.checkoutId,
      {
        storage,
        requireCrossTabLock: false,
        verifyBuyerAuthority: () => true,
        now: () => clock,
        loadAuthorized: async () => prepared,
        repository: {
          create: async () => ({ status: "absent" as const }),
          load: async () => ({
            status: "active" as const,
            revision: 1,
            state: prepared.state,
          }),
          save: async () => {
            throw new Error("must not save")
          },
        },
        attestCredit: async () => null,
        payInvoice: async (payment) => {
          try {
            await payment.beforeSend?.()
          } catch (error) {
            return {
              status: "retryable_failure" as const,
              phase: "before_publish" as const,
              reason: error instanceof Error ? error.message : "expired",
            }
          }
          walletSends += 1
          throw new Error("must not send")
        },
      }
    ).fund({
      buyerPubkey: BUYER.pubkey,
      shouldContinue: () => true,
      paymentTarget: {
        type: "wallet",
        providerId: "spark",
        walletId: "payer",
      },
      walletPaymentAttemptId: "attempt-1",
      beforeSend: async () => {
        clock = prepared.plan.funding.expiresAt
      },
      timeoutMs: 10_000,
      appId: "market",
    })
    expect(result).toMatchObject({
      status: "payment_retryable",
      reason: expect.stringContaining("expired"),
    })
    expect(walletSends).toBe(0)
  })

  it("keeps an after-publication NWC refusal provisional across retries", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    let walletCalls = 0
    const bridge = createCheckoutSparkSettledFundingBridge(
      prepared.plan.checkoutId,
      {
        storage,
        requireCrossTabLock: false,
        verifyBuyerAuthority: () => true,
        now: () => NOW + 1,
        loadAuthorized: async () => prepared,
        repository: {
          create: async () => ({ status: "absent" as const }),
          load: async () => ({
            status: "active" as const,
            revision: 1,
            state: prepared.state,
          }),
          save: async () => {
            throw new Error("unverified funding must not be saved as credit")
          },
        },
        attestCredit: async () => null,
        payInvoice: (payment) =>
          payCheckoutInvoice(payment, {
            walletPaymentCoordinator: {
              payInvoice: async () => {
                walletCalls += 1
                return {
                  status: "failed",
                  phase: "after_publish",
                  reason:
                    "NWC wallet returned a refusal after request publication.",
                }
              },
            },
            hasWebLN: () => false,
            weblnSendPayment: async () => {
              throw new Error("must not switch payment rails")
            },
          }),
      }
    )
    const input = {
      buyerPubkey: BUYER.pubkey,
      shouldContinue: () => true,
      paymentTarget: {
        type: "wallet" as const,
        providerId: "nwc" as const,
        walletId: "payer",
      },
      walletPaymentAttemptId: "attempt-1",
      timeoutMs: 10_000,
      appId: "market" as const,
    }

    expect(await bridge.fund(input)).toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "unknown",
    })
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, storage)
    ).toMatchObject({ fundingSubmissionState: "provisional" })
    expect(await bridge.fund(input)).toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "unknown",
    })
    expect(walletCalls).toBe(1)
  })

  it("rejects an account switch before touching the payer rail", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    let payerCalls = 0
    await expect(
      createCheckoutSparkSettledFundingBridge(prepared.plan.checkoutId, {
        storage,
        requireCrossTabLock: false,
        verifyBuyerAuthority: () => false,
        loadAuthorized: async () => prepared,
        payInvoice: async () => {
          payerCalls += 1
          throw new Error("must not pay")
        },
      }).fund({
        buyerPubkey: BUYER.pubkey,
        shouldContinue: () => true,
        paymentTarget: {
          type: "wallet",
          providerId: "spark",
          walletId: "payer",
        },
        walletPaymentAttemptId: "attempt-1",
        timeoutMs: 10_000,
        appId: "market",
      })
    ).rejects.toThrow("buyer session or recovery sender changed")
    expect(payerCalls).toBe(0)
  })

  it("does not submit a payer payment when exact receive lookup is unavailable", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    let payerCalls = 0
    const result = await createCheckoutSparkSettledFundingBridge(
      prepared.plan.checkoutId,
      {
        storage,
        requireCrossTabLock: false,
        verifyBuyerAuthority: () => true,
        loadAuthorized: async () => prepared,
        repository: {
          create: async () => ({ status: "absent" as const }),
          load: async () => ({
            status: "active" as const,
            revision: 1,
            state: prepared.state,
          }),
          save: async () => {
            throw new Error("must not save")
          },
        },
        attestCredit: async () => {
          throw new Error("exact provider lookup unavailable")
        },
        payInvoice: async () => {
          payerCalls += 1
          throw new Error("must not pay")
        },
      }
    ).fund({
      buyerPubkey: BUYER.pubkey,
      shouldContinue: () => true,
      paymentTarget: {
        type: "wallet",
        providerId: "spark",
        walletId: "payer",
      },
      walletPaymentAttemptId: "attempt-1",
      timeoutMs: 10_000,
      appId: "market",
    })
    expect(result).toMatchObject({ status: "awaiting_reconciliation" })
    expect(payerCalls).toBe(0)
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, storage)
    ).toMatchObject({ fundingSubmissionState: "not_started" })
  })

  it("never treats payer success as credit or repeats an ambiguous invoice after reload", async () => {
    const storage = new MemoryStorage()
    const prepared = await prepareCheckoutSparkSettledFunding(
      request(storage),
      dependencies(true).options
    )
    let state = prepared.state
    let revision = 1
    let payerCalls = 0
    let exactReads = 0
    let proofAvailable = false
    let providerCreditRecords = 0
    const bridgeDependencies = {
      storage,
      requireCrossTabLock: false,
      verifyBuyerAuthority: () => true,
      withStoreWriteLock: async <T>(operation: () => Promise<T>) => operation(),
      now: () => NOW + 1_000,
      loadAuthorized: async () => prepared,
      repository: {
        create: async () => ({ status: "absent" as const }),
        load: async () => ({ status: "active" as const, revision, state }),
        save: async (next: typeof state, priorRevision: number) => {
          expect(priorRevision).toBe(revision)
          revision += 1
          state = next
          return { status: "active" as const, revision, state }
        },
        recordMerchantCredit: async (plan: typeof prepared.plan) => {
          providerCreditRecords += 1
          return createCheckoutSparkMerchantSettlementRecord(plan)
        },
      },
      attestCredit: async () => {
        exactReads += 1
        return proofAvailable
          ? {
              mode: "ordinary_v3" as const,
              requestId: prepared.plan.funding.requestId,
              transferId: "exact-settling-transfer",
              receiverIdentityPublicKey: RECEIVER_IDENTITY,
              grossSats: GROSS,
              creditedSats: GROSS - 2,
            }
          : null
      },
      payInvoice: async () => {
        payerCalls += 1
        return {
          status: "paid" as const,
          rail: "wallet" as const,
          preimage: "6".repeat(64),
        }
      },
    }
    const fundingInput = {
      buyerPubkey: BUYER.pubkey,
      shouldContinue: () => true,
      paymentTarget: {
        type: "wallet" as const,
        providerId: "spark",
        walletId: "payer",
      },
      walletPaymentAttemptId: "attempt-1",
      timeoutMs: 10_000,
      appId: "market" as const,
    }
    await expect(
      createCheckoutSparkSettledFundingBridge(
        prepared.plan.checkoutId,
        bridgeDependencies
      ).fund(fundingInput)
    ).resolves.toMatchObject({
      status: "awaiting_reconciliation",
      paymentSubmission: "accepted",
      reconciliation: { credit: null },
    })
    expect(
      getCheckoutSparkSettledPreparation(prepared.plan.checkoutId, storage)
    ).toMatchObject({ fundingSubmissionState: "provisional" })
    await expect(
      createCheckoutSparkSettledFundingBridge(
        prepared.plan.checkoutId,
        bridgeDependencies
      ).fund(fundingInput)
    ).resolves.toMatchObject({ status: "awaiting_reconciliation" })
    expect(payerCalls).toBe(1)
    proofAvailable = true
    const funded = await createCheckoutSparkSettledFundingBridge(
      prepared.plan.checkoutId,
      bridgeDependencies
    ).fund(fundingInput)
    expect(funded.status).toBe("funded")
    if (funded.status === "funded") {
      expect(funded.reconciliation.credit?.creditedSats).toBe(GROSS - 2)
      expect(
        funded.reconciliation.legs.every((leg) => leg.allocationSats !== null)
      ).toBe(true)
    }
    expect(payerCalls).toBe(1)
    expect(exactReads).toBe(4)
    expect(providerCreditRecords).toBe(1)
  })
})
