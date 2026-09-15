import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  __resetCommerceTestOverrides,
  __resetRelayListTestOverrides,
  __setCommerceTestOverrides,
  __setRelayListTestOverrides,
  getProfiles,
  type CachedProfile,
  type OrderLifecycle,
} from "@conduit/core"
import { db } from "../packages/core/src/db"
import {
  __resetNdkTestState,
  setSigner,
} from "../packages/core/src/protocol/ndk"
import {
  runOrderPayment,
  type OrderPaymentContext,
  type OrderPaymentDependencies,
} from "../apps/market/src/lib/order-payment-service"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
  makeBolt11Fixture,
} from "./support/bolt11-fixture"

const merchantSecret = generateSecretKey()
const buyerSecret = generateSecretKey()
const MERCHANT = getPublicKey(merchantSecret)
const BUYER = getPublicKey(buyerSecret)
const SAVED_ADDRESS = "merchant@wallet.example"
const originalGet = db.orderLifecycles.get
const originalPut = db.orderLifecycles.put
const originalTransaction = db.transaction
let stored: OrderLifecycle
let profile: CachedProfile | undefined
let profileEvents: NDKEvent[]
let profileTimestamp: number
let networkFails: boolean
let cacheWritesFail: boolean
let counts: { metadata: number; invoice: number; wallet: number }
let afterMetadata: (() => Promise<void>) | undefined
let afterInvoice: (() => Promise<void>) | undefined
let exerciseShopperSigning: boolean
let buyerSigner: NDKPrivateKeySigner

function invoice(): string {
  return makeBolt11Fixture({
    hrp: "lnbc10n",
    createdAt: Math.floor(Date.now() / 1_000),
    fields: [bolt11PaymentHashField(), bolt11PlainDescriptionField()],
  })
}

async function observeProfile(content: string): Promise<void> {
  profileEvents = [
    new NDKEvent(
      undefined,
      finalizeEvent(
        {
          kind: 0,
          created_at: profileTimestamp++,
          content,
          tags: [],
        },
        merchantSecret
      )
    ),
  ]
  await getProfiles({
    pubkeys: [MERCHANT],
    skipCache: true,
    requireCompleteEvidence: true,
    evidenceScope: "payment",
  })
}

function context(): OrderPaymentContext {
  return {
    orderId: stored.orderId,
    buyerPubkey: BUYER,
    merchantPubkey: MERCHANT,
    merchantLud16: SAVED_ADDRESS,
    zapMode: exerciseShopperSigning
      ? "public_zap_as_shopper"
      : "private_checkout",
    zapContent: "",
    totalSats: 1,
    totalMsats: 1_000,
    items: [],
    paymentTarget: { type: "webln" },
  }
}

function dependencies(): Partial<OrderPaymentDependencies> {
  return {
    rememberOrderPaymentClaim: () => true,
    clearOrderPaymentClaim: () => true,
    fetchLnurlPayMetadata: async () => {
      counts.metadata += 1
      await afterMetadata?.()
      return {
        payRequestUrl: "https://wallet.example/.well-known/lnurlp/merchant",
        lnurl: "lnurl1fixture",
        callback: "https://wallet.example/callback",
        minSendable: 1_000,
        maxSendable: 1_000_000,
        tag: "payRequest",
        allowsNostr: true,
        nostrPubkey: MERCHANT,
        metadata: "[]",
      }
    },
    requestCheckoutLnurlInvoice: async (_input, requestDependencies) => {
      if (exerciseShopperSigning) {
        await requestDependencies!.signZapRequest!({
          kind: 9734,
          createdAt: Math.floor(Date.now() / 1_000),
          content: "",
          tags: [
            ["p", MERCHANT],
            ["amount", "1000"],
            ["relays", "wss://relay.damus.io"],
          ],
        })
      }
      counts.invoice += 1
      await afterInvoice?.()
      return {
        invoice: invoice(),
        zapRelayUrls: [],
        shouldWaitForZapReceipt: false,
      }
    },
    payCheckoutInvoice: async () => {
      counts.wallet += 1
      return {
        status: "retryable_failure",
        reason: "Synthetic wallet declined before sending.",
      }
    },
  }
}

beforeEach(() => {
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetNdkTestState()
  profile = undefined
  profileEvents = []
  profileTimestamp = Math.floor(Date.now() / 1_000)
  networkFails = false
  cacheWritesFail = false
  counts = { metadata: 0, invoice: 0, wallet: 0 }
  afterMetadata = undefined
  afterInvoice = undefined
  exerciseShopperSigning = false
  buyerSigner = new NDKPrivateKeySigner(
    Buffer.from(buyerSecret).toString("hex")
  )
  setSigner(buyerSigner)
  stored = {
    orderId: crypto.randomUUID(),
    buyerPubkey: BUYER,
    merchantPubkey: MERCHANT,
    merchantLightningAddress: SAVED_ADDRESS,
    checkoutMode: "private_checkout",
    paymentTarget: { type: "webln" },
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    invoiceStatus: "failed",
    paymentStatus: "failed",
    invoice: invoice(),
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "in_progress",
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now(),
  }
  // Keep real lifecycle admission/claim/patch logic; replace only storage I/O.
  db.orderLifecycles.get = (async () =>
    structuredClone(stored)) as typeof originalGet
  db.orderLifecycles.put = (async (row: OrderLifecycle) => {
    stored = structuredClone(row)
    return row.orderId
  }) as typeof originalPut
  db.transaction = (async (...args: unknown[]) =>
    (args.at(-1) as () => Promise<unknown>)()) as typeof originalTransaction
  __setRelayListTestOverrides({
    loadCached: async () => undefined,
    putCached: async () => {},
    fetchEventsFanout: async () => [],
  })
  __setCommerceTestOverrides({
    getCachedProducts: async () => [],
    getCachedProfiles: async (pubkeys) =>
      pubkeys.map((pubkey) => (pubkey === MERCHANT ? profile : undefined)),
    putCachedProfiles: async (rows) => {
      if (cacheWritesFail)
        throw new Error("Synthetic profile persistence failure")
      profile = rows.find((row) => row.pubkey === MERCHANT) ?? profile
    },
    fetchEventsFanoutWithDiagnostics: async () => {
      if (networkFails) throw new Error("Synthetic profile network outage")
      return {
        events: profileEvents,
        attemptedRelayUrls: ["wss://relay.damus.io"],
        successfulRelayUrls: ["wss://relay.damus.io"],
        failedRelayUrls: [],
        cappedRelayUrls: [],
      }
    },
  })
})

afterEach(() => {
  db.orderLifecycles.get = originalGet
  db.orderLifecycles.put = originalPut
  db.transaction = originalTransaction
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetNdkTestState()
})

describe("executor profile authority workflow", () => {
  for (const retention of ["durable", "failed_write"] as const) {
    for (const [label, content] of [
      ["removed", "{}"],
      ["malformed", "[]"],
      ["changed", JSON.stringify({ lud16: "merchant@new-wallet.example" })],
    ]) {
      it(`blocks ${retention} ${label} authority before claiming or contacting a provider`, async () => {
        cacheWritesFail = retention === "failed_write"
        await observeProfile(content!)
        profileEvents = []
        const before = structuredClone(stored)
        const result = await runOrderPayment(context(), dependencies())
        expect(result.error).toMatch(/address|profile/i)
        expect(counts).toEqual({ metadata: 0, invoice: 0, wallet: 0 })
        expect(stored).toEqual(before)
        expect(result.lifecycle?.invoice).toBe(before.invoice)
        expect(stored.paymentClaimId).toBeUndefined()
      })
    }
  }

  for (const unavailable of [false, true]) {
    it(`allows ${unavailable ? "unavailable" : "empty"} profile lookup when no contradictory authority is known`, async () => {
      networkFails = unavailable
      const result = await runOrderPayment(context(), dependencies())
      expect(counts).toEqual({ metadata: 1, invoice: 1, wallet: 1 })
      expect(result.lifecycle?.paymentStatus).toBe("failed")
      expect(result.error).toBe("Synthetic wallet declined before sending.")
    })
  }

  it("admits a newer signed recovery of the saved address after retained removal blocks", async () => {
    await observeProfile("{}")
    profileEvents = []
    const blocked = await runOrderPayment(context(), dependencies())
    expect(blocked.error).toMatch(/address/i)
    expect(counts.wallet).toBe(0)
    await observeProfile(JSON.stringify({ lud16: SAVED_ADDRESS }))
    const recovered = await runOrderPayment(context(), dependencies())
    expect(counts).toEqual({ metadata: 1, invoice: 1, wallet: 1 })
    expect(recovered.error).toBe("Synthetic wallet declined before sending.")
  })

  it("stops before invoice acquisition when stronger authority arrives during metadata lookup", async () => {
    await observeProfile(JSON.stringify({ lud16: SAVED_ADDRESS }))
    afterMetadata = () => observeProfile("{}")
    const result = await runOrderPayment(context(), dependencies())
    expect(result.error).toMatch(/address|profile/i)
    expect(counts).toEqual({ metadata: 1, invoice: 0, wallet: 0 })
    expect(stored.paymentClaimId).toBeUndefined()
  })

  it("stops before wallet submission when stronger authority arrives during invoice lookup", async () => {
    await observeProfile(JSON.stringify({ lud16: SAVED_ADDRESS }))
    afterInvoice = () => observeProfile("[]")
    const result = await runOrderPayment(context(), dependencies())
    expect(result.error).toMatch(/address|profile/i)
    expect(counts).toEqual({ metadata: 1, invoice: 1, wallet: 0 })
    expect(stored.paymentClaimId).toBeUndefined()
  })

  it("stops after shopper signing when a stronger signed removal was observed during the signer await", async () => {
    exerciseShopperSigning = true
    stored.checkoutMode = "public_zap_as_shopper"
    await observeProfile(JSON.stringify({ lud16: SAVED_ADDRESS }))
    const originalSign = buyerSigner.sign.bind(buyerSigner)
    let signCalls = 0
    buyerSigner.sign = async (event) => {
      signCalls += 1
      const signature = await originalSign(event)
      await observeProfile("{}")
      return signature
    }
    const result = await runOrderPayment(context(), dependencies())
    expect(signCalls).toBe(1)
    expect(result.error).toMatch(/address|profile/i)
    expect(counts).toEqual({ metadata: 1, invoice: 0, wallet: 0 })
    expect(stored.paymentClaimId).toBeUndefined()
  })
})
