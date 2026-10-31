import { setTestAccountSigner as setSigner } from "./helpers/plain-signer"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { Nip47NetworkError, Nip47PublishError } from "@getalby/sdk/nwc"
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
  createSelectedProfileContext,
  getProfiles,
  patchClaimedOrderLifecyclePayment,
  reconcileInterruptedOrderPayment,
  recordOrderPaymentWalletSuccessRecovery,
  type CachedProfile,
  type OrderLifecycle,
} from "@conduit/core"
import { db } from "../packages/core/src/db"
import { __resetPublicReaderTestState } from "../packages/core/src/protocol/relay-reader"
import {
  runOrderPayment,
  type OrderPaymentContext,
  type OrderPaymentDependencies,
} from "../apps/market/src/lib/order-payment-service"
import { createNwcPaymentFixture } from "./support/nwc-payment-fixture"
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
const originalNow = Date.now
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window"
)
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
let invoiceCreatedAt: number

function invoice(kind: "preclaim" | "acquired"): string {
  return makeBolt11Fixture({
    hrp: "lnbc10n",
    createdAt: invoiceCreatedAt,
    fields: [
      bolt11PaymentHashField(
        new Uint8Array(32).fill(kind === "preclaim" ? 7 : 8)
      ),
      bolt11PlainDescriptionField(),
    ],
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
    fenceClaimedOrderLifecyclePaymentAuthority: async (
      orderId,
      paymentClaimId,
      merchantPubkey
    ) => {
      const result = await patchClaimedOrderLifecyclePayment(
        orderId,
        paymentClaimId,
        {}
      )
      if (result.status !== "patched") return result
      return {
        status: "fenced",
        lifecycle: result.lifecycle,
        selectedProfileContext: createSelectedProfileContext({
          pubkey: merchantPubkey,
          row: profile,
        }),
      }
    },
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
        invoice: invoice("acquired"),
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
  __resetPublicReaderTestState()
  invoiceCreatedAt = Math.floor(Date.now() / 1_000)
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
    invoice: invoice("preclaim"),
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
    fetchPublicEvents: async () => [],
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
    fetchPublicEventsWithDiagnostics: async () => {
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
  Date.now = originalNow
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, "window")
  }
  db.orderLifecycles.get = originalGet
  db.orderLifecycles.put = originalPut
  db.transaction = originalTransaction
  __resetCommerceTestOverrides()
  __resetRelayListTestOverrides()
  __resetPublicReaderTestState()
})

describe("executor profile authority workflow", () => {
  it("keeps final NWC admission denial retryable with zero SDK dispatches", async () => {
    await observeProfile(JSON.stringify({ lud16: SAVED_ADDRESS }))
    let current = true
    const nwc = await createNwcPaymentFixture(
      async () => {
        throw new Nip47PublishError(
          "Local acknowledgment unavailable",
          "INTERNAL"
        )
      },
      {
        prepare: () => {
          current = false
        },
      }
    )
    try {
      current = true
      stored.paymentTarget = nwc.target
      const input = {
        ...context(),
        paymentTarget: nwc.target,
        shouldContinue: () => current,
      }
      const deps = { ...dependencies(), payCheckoutInvoice: nwc.payInvoice }
      const denied = await runOrderPayment(input, deps)
      expect(nwc.submitted).toHaveLength(0)
      expect(denied.lifecycle?.paymentStatus).toBe("failed")
      current = true
      // Explicit fresh authority now allows the next admission boundary.
      await runOrderPayment({ ...input, shouldContinue: () => true }, deps)
      expect(nwc.submitted).toHaveLength(1)
      expect(stored.paymentStatus).toBe("ambiguous")
    } finally {
      nwc.dispose()
    }
  })

  it("binds a late NWC success to the interrupted original attempt monotonically", async () => {
    await observeProfile(JSON.stringify({ lud16: SAVED_ADDRESS }))
    let entered!: () => void
    let release!: () => void
    const submitted = new Promise<void>((done) => {
      entered = done
    })
    const held = new Promise<void>((done) => {
      release = done
    })
    const nwc = await createNwcPaymentFixture(async () => {
      entered()
      await held
      return { preimage: "f".repeat(64) }
    })
    const originalAttemptGet = db.paymentAttempts.get
    db.paymentAttempts.get = (async () =>
      undefined) as typeof originalAttemptGet
    let pending: ReturnType<typeof runOrderPayment> | undefined
    try {
      stored.paymentTarget = nwc.target
      const input = { ...context(), paymentTarget: nwc.target }
      const deps = {
        ...dependencies(),
        payCheckoutInvoice: nwc.payInvoice,
        savePaymentAttempt: async () => {},
      }
      pending = runOrderPayment(input, deps)
      await submitted
      const original = structuredClone(stored)
      stored.paymentClaimLeaseExpiresAt = 0
      expect(
        (
          await reconcileInterruptedOrderPayment(
            stored.orderId,
            stored.paymentClaimId!
          )
        ).status
      ).toBe("marked_ambiguous")
      expect(stored.invoice).toBe(original.invoice)
      release()
      expect((await pending).lifecycle?.paymentStatus).toBe("paid")
      expect(stored.invoice).toBe(original.invoice)
      expect(stored.walletPaymentAttemptId).toBe(
        original.walletPaymentAttemptId
      )
      expect(stored.proofDeliveryStatus).toBe("retry_needed")
      // Duplicate evidence cannot regress proof already sent for this attempt.
      await recordOrderPaymentWalletSuccessRecovery(stored.orderId, {
        invoice: original.invoice!,
        preimage: stored.preimage!,
        proofDeliveryStatus: "sent",
      })
      await recordOrderPaymentWalletSuccessRecovery(stored.orderId, {
        invoice: original.invoice!,
        preimage: stored.preimage!,
        proofDeliveryStatus: "pending",
      })
      expect(stored.proofDeliveryStatus).toBe("sent")
      await runOrderPayment(input, deps)
      expect(nwc.submitted).toEqual([original.invoice!])
      expect(counts.invoice).toBe(1)
      expect(stored.phase).toBe("in_progress")
    } finally {
      release()
      await pending
      db.paymentAttempts.get = originalAttemptGet
      nwc.dispose()
    }
  })

  it.each([Nip47PublishError, Nip47NetworkError])(
    "retains the original NWC obligation after %p, reconnect and restored storage",
    async (PaymentError) => {
      await observeProfile(JSON.stringify({ lud16: SAVED_ADDRESS }))
      const nwc = await createNwcPaymentFixture(async () => {
        throw new PaymentError("Local acknowledgment unavailable", "INTERNAL")
      })
      try {
        stored.paymentTarget = nwc.target
        const input = { ...context(), paymentTarget: nwc.target }
        const deps = { ...dependencies(), payCheckoutInvoice: nwc.payInvoice }
        const first = await runOrderPayment(input, deps)
        expect(first.lifecycle?.paymentStatus).toBe("ambiguous")
        expect(first.lifecycle?.invoice).toBe(invoice("acquired"))
        const retained = structuredClone(stored)
        expect(retained.walletPaymentAttemptId).toBeDefined()
        expect(retained.proofDeliveryStatus).toBe("not_started")
        expect(retained.phase).toBe("in_progress")
        await nwc.reconnect()
        stored = JSON.parse(JSON.stringify(retained)) as OrderLifecycle
        for (const paymentTarget of [
          nwc.target,
          { type: "manual" as const },
          { type: "webln" as const },
          { ...nwc.target, walletId: "replacement-wallet" },
        ]) {
          await runOrderPayment({ ...input, paymentTarget }, deps)
          expect(stored.invoice).toBe(retained.invoice)
          expect(stored.walletPaymentAttemptId).toBe(
            retained.walletPaymentAttemptId
          )
          expect(stored.paymentTarget).toEqual(nwc.target)
          expect(stored.paymentStatus).toBe("ambiguous")
        }
        expect(counts.invoice).toBe(1)
        expect(nwc.submitted).toEqual([retained.invoice!])
        expect(nwc.attempts).toHaveLength(1)
        expect(nwc.attempts[0]?.idempotencyKey).toBe(
          retained.walletPaymentAttemptId
        )
      } finally {
        nwc.dispose()
      }
    }
  )

  for (const change of ["removal", "session", "expiry", "none"] as const) {
    it(`rechecks ${change} after real WebLN enable before submitting`, async () => {
      await observeProfile(JSON.stringify({ lud16: SAVED_ADDRESS }))
      const preclaimLifecycle = structuredClone(stored)
      let signalEnabled!: () => void
      let releaseEnable!: () => void
      const enabled = new Promise<void>((resolve) => {
        signalEnabled = resolve
      })
      const enableGate = new Promise<void>((resolve) => {
        releaseEnable = resolve
      })
      let sessionCurrent = true
      const submittedInvoices: string[] = []
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          localStorage: { getItem: () => null },
          webln: {
            enable: async () => {
              signalEnabled()
              await enableGate
            },
            sendPayment: async (paymentRequest: string) => {
              submittedInvoices.push(paymentRequest)
              throw new Error("Synthetic provider received the invoice.")
            },
          },
        },
      })
      const paymentDependencies = dependencies()
      // Exercise the real rails and WebLN adapter; only the extension is fake.
      delete paymentDependencies.payCheckoutInvoice
      const payment = runOrderPayment(
        { ...context(), shouldContinue: () => sessionCurrent },
        paymentDependencies
      )
      await enabled
      const acquiredInvoice = stored.invoice
      expect(acquiredInvoice).toBeTruthy()
      expect(acquiredInvoice).not.toBe(preclaimLifecycle.invoice)
      expect(submittedInvoices).toEqual([])
      if (change === "removal") {
        await observeProfile("{}")
        expect(profile?.rawContent).toBe("{}")
      }
      if (change === "session") sessionCurrent = false
      if (change === "expiry") Date.now = () => originalNow() + 7_200_000
      releaseEnable()
      const result = await payment
      expect(counts).toEqual({ metadata: 1, invoice: 1, wallet: 0 })
      expect(submittedInvoices.length).toBe(change === "none" ? 1 : 0)
      if (change === "none") {
        expect(submittedInvoices[0] === acquiredInvoice).toBe(true)
        expect(result.error).toContain(
          "Synthetic provider received the invoice."
        )
        expect(stored.invoice).toBe(acquiredInvoice)
      } else {
        expect(result.error).toMatch(/address|account changed|expired/i)
        expect(stored.invoice).toBe(preclaimLifecycle.invoice)
        expect(result.lifecycle?.invoice).toBe(preclaimLifecycle.invoice)
        expect(stored.invoiceStatus).toBe(preclaimLifecycle.invoiceStatus)
        expect(stored.paymentStatus).toBe(preclaimLifecycle.paymentStatus)
      }
      expect(stored.paymentClaimId).toBeUndefined()
    })
  }

  for (const identityKind of ["signed_in", "guest_ephemeral"] as const) {
    it(`admits an initial ${identityKind} payment through real lifecycle and profile admission`, async () => {
      stored.buyerIdentityKind = identityKind
      stored.paymentStatus = "not_started"
      stored.invoiceStatus = "not_requested"
      stored.invoice = undefined
      await observeProfile(JSON.stringify({ lud16: SAVED_ADDRESS }))
      const paymentContext: OrderPaymentContext = {
        ...context(),
        accountPubkey: identityKind === "signed_in" ? BUYER : null,
        authenticatedPubkey: identityKind === "signed_in" ? BUYER : null,
        shouldContinue: identityKind === "signed_in" ? () => true : undefined,
        buyerIdentity:
          identityKind === "guest_ephemeral"
            ? {
                kind: "guest_ephemeral",
                pubkey: BUYER,
                signer: buyerSigner,
                orderId: stored.orderId,
                merchantPubkey: MERCHANT,
              }
            : undefined,
      }
      const result = await runOrderPayment(paymentContext, dependencies())
      expect(counts).toEqual({ metadata: 1, invoice: 1, wallet: 1 })
      expect(result.error).toBe("Synthetic wallet declined before sending.")
      expect(result.lifecycle?.invoice).toBeTruthy()
      expect(stored.buyerIdentityKind).toBe(identityKind)
      expect(stored.paymentClaimId).toBeUndefined()
    })
  }

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
