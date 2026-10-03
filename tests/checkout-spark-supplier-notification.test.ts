import { describe, expect, it } from "bun:test"
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  recordCheckoutSparkMerchantCredit,
  recordCheckoutSparkMerchantPayout,
  recordCheckoutSparkSettledCredit,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledLegStatus,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkInvoiceOriginRecord,
  wrapPrivateMessage,
  unwrapGiftWrap,
  type CheckoutSparkSettledOutgoingTarget,
} from "@conduit/core/protocol"
import {
  buildCheckoutSparkSupplierNotificationRumor,
  captureCheckoutSparkSupplierNotificationSession,
  getCheckoutSparkSupplierNotifications,
  publishCheckoutSparkSupplierPaymentNotification,
  publishRetainedCheckoutSparkSupplierNotification,
  retryCheckoutSparkSupplierNotification,
  type CheckoutSparkSupplierNotificationTransport,
  type CheckoutSparkSupplierNotificationStore,
  type StoredCheckoutSparkSupplierNotification,
} from "../packages/core/src/protocol/checkout-spark-supplier-notification"
import { DexieCheckoutSparkSupplierNotificationRepository } from "../packages/core/src/protocol/checkout-spark-supplier-notification-repository"
import {
  activateAccountSigner,
  retireAccountSigner,
  SessionSigner,
} from "../packages/core/src/protocol/session-signer"
import { plainTestSigner } from "./helpers/plain-signer"
import {
  installProtectedReadSigner,
  removeProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import { isValidSignedPublicNostrEvent } from "../packages/core/src/protocol/signed-event"
import {
  makeSignedBolt11Fixture,
  bolt11PaymentSecretField,
} from "./support/signed-bolt11-fixture"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"

const NOW = 1_800_000_000_000
const merchantSecret = generateSecretKey()
const supplierSecret = generateSecretKey()
const MERCHANT = getPublicKey(merchantSecret)
const SUPPLIER = getPublicKey(supplierSecret)
const MERCHANT_INBOX = "wss://merchant.inbox.relay.dev"
const SUPPLIER_INBOX = "wss://supplier.inbox.relay.dev"
const signer = plainTestSigner(
  new NDKPrivateKeySigner(Buffer.from(merchantSecret).toString("hex"))
)
const supplierSigner = plainTestSigner(
  new NDKPrivateKeySigner(Buffer.from(supplierSecret).toString("hex"))
)

function accountSigner(
  authMethod: "nip07" | "nip46",
  hasAuthority: () => boolean,
  revision = "synthetic-revision"
) {
  return new SessionSigner(signer, {
    expectedPubkey: MERCHANT,
    revision,
    authMethod,
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority,
  })
}

function invoice(sats: number, byte: number) {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${sats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(byte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

async function fixture() {
  const destination = (value: string, profile: string) => ({
    type: "lightning_address" as const,
    value,
    source: {
      type: "signed_profile" as const,
      profileEventId: profile.repeat(64),
      profileEventCreatedAt: NOW / 1_000,
    },
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "notification-checkout",
    orderId: "private-order-never-shared",
    merchantPubkey: MERCHANT,
    walletId: "private-wallet-never-shared",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt: NOW + 180_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:private-product`,
          productEventId: "a".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "private-funding-request",
      paymentRequest: invoice(1_113, 1),
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${"d".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: destination("merchant@example.test", "b"),
        weightSats: 750,
      },
      {
        kind: "supplier",
        recipientId: SUPPLIER,
        destination: destination("supplier@example.test", "c"),
        weightSats: 250,
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
        weightSats: 111,
      },
    ],
  })
  const proof = {
    mode: "ordinary_v3" as const,
    requestId: plan.funding.requestId,
    transferId: "private-inbound-transfer",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: 1_113,
    creditedSats: 1_113,
  }
  const credited = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    { ...proof, paymentHash: plan.funding.paymentHash, observedAt: NOW + 1_000 }
  )
  const leg = credited.legs[1]!
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: plan.walletId,
    network: "mainnet",
    legId: leg.legId,
    recipientId: SUPPLIER,
    allocationSats: leg.allocationSats!,
    unpaidAllocationSats: 1_113,
    intent: {
      legId: leg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, leg.legId),
      paymentRequest: invoice(247, 2),
      paymentHash: "02".repeat(32),
      invoiceAmountSats: 247,
      maxFeeSats: leg.allocationSats! - 247,
      preparedAt: NOW + 2_000,
    },
  }
  const initial = recordCheckoutSparkMerchantCredit(
    createCheckoutSparkMerchantSettlementRecord(plan),
    plan,
    proof,
    NOW + 1_000
  )
  const observation = {
    status: "paid" as const,
    legId: leg.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: 247,
    maxFeeSats: target.intent.maxFeeSats,
    finalFeeSats: 2,
    finalDebitSats: 249,
  }
  const endpoint = await resolveCheckoutSparkFixtureInvoice(
    {
      lud16: plan.recipients[1]!.destination.value,
      network: "mainnet",
      amountSats: 247,
      nowSeconds: NOW / 1_000,
      shouldContinue: () => true,
    },
    target.intent.paymentRequest
  )
  const unbound = recordCheckoutSparkMerchantPayout(
    initial,
    plan,
    target,
    observation,
    NOW + 3_000
  )
  const settlement = recordCheckoutSparkMerchantPayout(
    initial,
    plan,
    target,
    observation,
    NOW + 3_000,
    createCheckoutSparkInvoiceOriginRecord(plan, target, endpoint.origin!)
  )
  return {
    plan,
    settlement,
    initial,
    unbound,
    target,
    supplierLegId: leg.legId,
    credited,
    proof,
    observation,
    origin: createCheckoutSparkInvoiceOriginRecord(
      plan,
      target,
      endpoint.origin!
    ),
  }
}

function memoryStore() {
  const entries = new Map<string, StoredCheckoutSparkSupplierNotification>()
  const store: CheckoutSparkSupplierNotificationStore = {
    async loadIntent() {
      return true
    },
    async load(notification) {
      return entries.get(notification.notificationId) ?? null
    },
    async stage(record, assertCurrent) {
      assertCurrent()
      const previous = entries.get(record.notification.notificationId)
      const entry = previous ?? {
        record,
        recipientAccepted: false,
        senderAccepted: false,
      }
      entries.set(record.notification.notificationId, entry)
      return entry
    },
    async markAccepted(notification, copy, assertCurrent) {
      assertCurrent()
      const previous = entries.get(notification.notificationId)!
      const entry = {
        ...previous,
        [copy === "recipient" ? "recipientAccepted" : "senderAccepted"]: true,
      }
      entries.set(notification.notificationId, entry)
      return entry
    },
  }
  return { store, entries }
}

function transport(
  publishFn: NonNullable<
    CheckoutSparkSupplierNotificationTransport["publishFn"]
  >
): CheckoutSparkSupplierNotificationTransport {
  return {
    recipientInboxRelays: [SUPPLIER_INBOX],
    senderInboxRelays: [MERCHANT_INBOX],
    accountNetworkLocalStateRepository: { get: async () => undefined },
    inspectOwnInboxReadiness: async () => ({
      state: "ready",
      eventId: "e".repeat(64),
      relayUrls: [MERCHANT_INBOX],
      stale: false,
      distributionRepairable: false,
    }),
    waitForSignerVisibility: async () => {},
    publishFn,
  }
}
function delivery(targets: readonly string[], success = true) {
  return {
    attemptedRelayUrls: [...targets],
    successfulRelayUrls: success ? [...targets] : [],
    failedRelayUrls: success ? [] : [...targets],
    relayFailureMessages: {},
  }
}

describe("verified supplier payment notifications", () => {
  for (const authMethod of ["nip07", "nip46"] as const) {
    it(`enables account-bound NIP-42 writes for the active ${authMethod} signer`, async () => {
      const f = await fixture()
      let active = true
      const owner = accountSigner(authMethod, () => active)
      activateAccountSigner(owner)
      const lease = installProtectedReadSigner(owner, MERCHANT, () => active)
      try {
        const session = captureCheckoutSparkSupplierNotificationSession({
          merchantPubkey: MERCHANT,
          assertCurrent() {},
        })!
        expect(session).not.toBeNull()
        expect(session.transport.relayAuthMethod).toBe(authMethod)
        expect(
          captureCheckoutSparkSupplierNotificationSession({
            merchantPubkey: SUPPLIER,
            assertCurrent() {},
          })
        ).toBeNull()
        const { store } = memoryStore()
        let authenticatedWrites = 0
        const io = transport(async (_event, options) => {
          const authentication = options.relayAuthentication!
          expect(authentication).toBeDefined()
          expect(authentication.expectedPubkey).toBe(MERCHANT)
          expect(authentication.sessionScope).toBe(owner)
          expect(authentication.signer.authMethod).toBe(authMethod)
          const signed = await authentication.signer.signEvent({
            kind: 22242,
            pubkey: MERCHANT,
            created_at: NOW / 1_000,
            content: "",
            tags: [
              ["relay", options.exclusiveRelayUrls![0]!],
              ["challenge", "synthetic-write-challenge"],
            ],
          })
          expect(isValidSignedPublicNostrEvent(signed)).toBe(true)
          authenticatedWrites += 1
          return delivery(options.exclusiveRelayUrls!)
        })
        expect(
          await publishCheckoutSparkSupplierPaymentNotification({
            ...f,
            signer: session.signer,
            store,
            shouldContinue: session.shouldContinue,
            transport: { ...io, ...session.transport },
          })
        ).toBe("relay_accepted")
        expect(authenticatedWrites).toBe(2)
        active = false
        expect(() => session.shouldContinue()).toThrow()
        expect(
          captureCheckoutSparkSupplierNotificationSession({
            merchantPubkey: MERCHANT,
            assertCurrent() {},
          })
        ).toBeNull()
      } finally {
        removeProtectedReadSigner(lease)
        retireAccountSigner(owner)
      }
    })
  }

  it("does not transfer a protected-read lease to a replacement owner for the same account", () => {
    const previous = accountSigner("nip07", () => true, "previous-revision")
    const replacement = accountSigner("nip07", () => true, "next-revision")
    activateAccountSigner(previous)
    const previousLease = installProtectedReadSigner(
      previous,
      MERCHANT,
      () => true
    )
    const captured = captureCheckoutSparkSupplierNotificationSession({
      merchantPubkey: MERCHANT,
      assertCurrent() {},
    })!
    let replacementLease: ReturnType<typeof installProtectedReadSigner> | null =
      null
    try {
      activateAccountSigner(replacement)
      expect(captured.shouldContinue()).toBe(false)
      expect(
        captureCheckoutSparkSupplierNotificationSession({
          merchantPubkey: MERCHANT,
          assertCurrent() {},
        })
      ).toBeNull()
      replacementLease = installProtectedReadSigner(
        replacement,
        MERCHANT,
        () => true
      )
      expect(() => captured.shouldContinue()).toThrow()
      removeProtectedReadSigner(previousLease)
      retireAccountSigner(previous)
      const current = captureCheckoutSparkSupplierNotificationSession({
        merchantPubkey: MERCHANT,
        assertCurrent() {},
      })!
      expect(current.signer).toBe(replacement)
      expect(current.shouldContinue()).toBe(true)
    } finally {
      removeProtectedReadSigner(previousLease)
      if (replacementLease) removeProtectedReadSigner(replacementLease)
      retireAccountSigner(previous)
      retireAccountSigner(replacement)
    }
  })

  it("does not manufacture relay authentication from transport metadata", async () => {
    const f = await fixture()
    const { store } = memoryStore()
    let writes = 0
    const io = transport(async (_event, options) => {
      expect(options.relayAuthentication).toBeUndefined()
      writes++
      return delivery(options.exclusiveRelayUrls!)
    })
    expect(
      await publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        signer,
        store,
        shouldContinue: () => true,
        transport: { ...io, relayAuthMethod: "nip07" },
      })
    ).toBe("relay_accepted")
    expect(writes).toBe(2)
  })

  it("suppresses staging and network writes when a late signer response belongs to a revoked session", async () => {
    const f = await fixture()
    const { store, entries } = memoryStore()
    let active = true
    let writes = 0
    const io = transport(async (_event, options) => {
      writes++
      return delivery(options.exclusiveRelayUrls!)
    })
    await expect(
      publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        signer,
        store,
        shouldContinue: () => active,
        transport: {
          ...io,
          giftWrapFn: async (...args) => {
            const wrap = await wrapPrivateMessage(...args)
            active = false
            return wrap
          },
        },
      })
    ).rejects.toThrow()
    expect(writes).toBe(0)
    expect(entries.size).toBe(0)
  })

  it("retains the exact retry after a relay completes following session revocation", async () => {
    const f = await fixture()
    const { store, entries } = memoryStore()
    let active = true
    const sent: string[] = []
    const io = transport(async (event, options) => {
      sent.push(event.id)
      active = false
      return delivery(options.exclusiveRelayUrls!)
    })
    await expect(
      publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        signer,
        store,
        shouldContinue: () => active,
        transport: io,
      })
    ).rejects.toThrow()
    expect(sent).toHaveLength(1)
    const saved = [...entries.values()][0]!
    expect(saved.recipientAccepted).toBe(false)
    expect(saved.senderAccepted).toBe(false)
    active = true
    expect(
      await retryCheckoutSparkSupplierNotification({
        record: saved.record,
        signer,
        store,
        shouldContinue: () => active,
        transport: transport(async (event, options) => {
          sent.push(event.id)
          return delivery(options.exclusiveRelayUrls!)
        }),
      })
    ).toBe("relay_accepted")
    expect(sent).toEqual([
      saved.record.signedRecipientWrap.id,
      saved.record.signedRecipientWrap.id,
      saved.record.signedSenderWrap!.id,
    ])
  })
  it("does not roll back supplier delivery when the sender copy fails, and only retries that copy", async () => {
    const f = await fixture()
    const { store, entries } = memoryStore()
    const targets: string[][] = []
    let senderAvailable = false
    const io = transport(async (_event, options) => {
      const relays = [...options.exclusiveRelayUrls!]
      targets.push(relays)
      return delivery(relays, relays[0] === SUPPLIER_INBOX || senderAvailable)
    })
    const input = {
      ...f,
      signer,
      store,
      shouldContinue: () => true,
      transport: io,
    }
    expect(await publishCheckoutSparkSupplierPaymentNotification(input)).toBe(
      "relay_accepted"
    )
    expect([...entries.values()][0]!.senderAccepted).toBe(false)
    senderAvailable = true
    expect(await publishCheckoutSparkSupplierPaymentNotification(input)).toBe(
      "relay_accepted"
    )
    expect(targets).toEqual([
      [SUPPLIER_INBOX],
      [MERCHANT_INBOX],
      [MERCHANT_INBOX],
    ])
  })

  it("ignores ACKs from outside the current signed inbox route", async () => {
    const f = await fixture()
    const { store, entries } = memoryStore()
    expect(
      await publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        signer,
        store,
        shouldContinue: () => true,
        transport: transport(async (_event, options) => ({
          ...delivery(options.exclusiveRelayUrls!, false),
          successfulRelayUrls: ["wss://unplanned.relay.dev"],
        })),
      })
    ).toBe("pending")
    expect([...entries.values()][0]!.recipientAccepted).toBe(false)
  })
  it("does not notify funding-only, pending, unknown, or recipient-unverified payouts", async () => {
    const f = await fixture()
    expect(getCheckoutSparkSupplierNotifications(f.plan, f.initial)).toEqual([])
    expect(getCheckoutSparkSupplierNotifications(f.plan, f.unbound)).toEqual([])
    expect(
      getCheckoutSparkSupplierNotifications(f.plan, {
        ...f.settlement,
        credit: null,
      })
    ).toEqual([])
    let touched = false
    expect(
      await publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        settlement: f.unbound,
        signer,
        store: memoryStore().store,
        shouldContinue: () => {
          touched = true
          return true
        },
      })
    ).toBe("not_eligible")
    expect(touched).toBe(false)
    expect(() =>
      getCheckoutSparkSupplierNotifications(f.plan, {
        ...f.settlement,
        planDigest: "f".repeat(64),
      })
    ).toThrow()
    expect(() =>
      getCheckoutSparkSupplierNotifications(f.plan, {
        ...f.settlement,
        paidLegs: [
          { ...f.settlement.paidLegs[0]!, transferId: "another-transfer" },
        ],
      })
    ).toThrow()
  })

  it("uses real Merchant-signed NIP17 encryption, minimal content, and separate strict inboxes", async () => {
    const f = await fixture()
    const { store, entries } = memoryStore()
    const published: NDKEvent[] = []
    const result = await publishCheckoutSparkSupplierPaymentNotification({
      ...f,
      signer,
      store,
      shouldContinue: () => true,
      transport: transport(async (event, options) => {
        expect(entries.size).toBe(1)
        expect(options.exclusiveRelayUrls).toEqual([
          published.length === 0 ? SUPPLIER_INBOX : MERCHANT_INBOX,
        ])
        expect(options.appRelayUrls).toEqual([])
        published.push(event)
        return delivery(options.exclusiveRelayUrls!)
      }),
    })
    expect(result).toBe("relay_accepted")
    expect(published).toHaveLength(2)
    const supplier = await unwrapGiftWrap(published[0]!, supplierSigner)
    const self = await unwrapGiftWrap(published[1]!, signer)
    expect(supplier.status).toBe("ok")
    expect(self.status).toBe("ok")
    if (supplier.status !== "ok" || self.status !== "ok")
      throw new Error("Expected genuine NIP17 wraps")
    expect(supplier.rumor.id).toBe(self.rumor.id)
    expect(supplier.rumor.pubkey).toBe(MERCHANT)
    expect(supplier.rumor.kind).toBe(14)
    expect(supplier.rumor.content).toContain("247 sats")
    expect(supplier.rumor.content).not.toContain(f.plan.orderId)
    expect(supplier.rumor.content).not.toContain(f.plan.walletId)
    expect(supplier.rumor.content).not.toContain("lnbc")
    expect(supplier.rumor.content).not.toContain("@")
    expect(supplier.rumor.tags.filter((tag) => tag[0] === "p")).toEqual([
      ["p", SUPPLIER],
    ])
    expect(JSON.stringify([...entries.values()])).not.toContain(
      "Your revenue share"
    )
    expect(JSON.stringify([...entries.values()])).not.toContain("private-order")
  })

  it("retries the identical wrap after lost ACK and skips accepted recipient on self-copy retry", async () => {
    const f = await fixture()
    const { store, entries } = memoryStore()
    const ids: string[] = []
    let succeeds = false
    const io = transport(async (event, options) => {
      ids.push(event.id)
      return delivery(options.exclusiveRelayUrls!, succeeds)
    })
    expect(
      await publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        signer,
        store,
        shouldContinue: () => true,
        transport: io,
      })
    ).toBe("pending")
    const original = [...entries.values()][0]!.record
    succeeds = true
    expect(
      await publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        signer,
        store,
        shouldContinue: () => true,
        transport: {
          ...io,
          giftWrapFn: async () => {
            throw new Error("Must not sign new wrapper")
          },
        },
      })
    ).toBe("relay_accepted")
    expect(ids).toEqual([
      original.signedRecipientWrap.id,
      original.signedSenderWrap!.id,
      original.signedRecipientWrap.id,
      original.signedSenderWrap!.id,
    ])
    expect(
      await retryCheckoutSparkSupplierNotification({
        record: original,
        signer,
        store,
        shouldContinue: () => true,
        transport: io,
      })
    ).toBe("relay_accepted")
    expect(ids).toHaveLength(4)
  })

  it("keeps the same semantic message after fresh-device verification at a later time", async () => {
    const f = await fixture()
    const first = getCheckoutSparkSupplierNotifications(
      f.plan,
      f.settlement
    )[0]!
    const later = getCheckoutSparkSupplierNotifications(f.plan, {
      ...f.settlement,
      paidLegs: f.settlement.paidLegs.map((leg) => ({
        ...leg,
        observedAt: NOW + 86_400_000,
      })),
    })[0]!
    expect(buildCheckoutSparkSupplierNotificationRumor(first).id).toBe(
      buildCheckoutSparkSupplierNotificationRumor(later).id
    )
  })

  it("blocks wrong signer, session replacement, and missing recipient declaration without delivery", async () => {
    const f = await fixture()
    let writes = 0
    const io = transport(async (_event, options) => {
      writes++
      return delivery(options.exclusiveRelayUrls!)
    })
    await expect(
      publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        signer: supplierSigner,
        store: memoryStore().store,
        shouldContinue: () => true,
        transport: io,
      })
    ).rejects.toThrow()
    await expect(
      publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        signer,
        store: memoryStore().store,
        shouldContinue: () => false,
        transport: io,
      })
    ).rejects.toThrow()
    await expect(
      publishCheckoutSparkSupplierPaymentNotification({
        ...f,
        signer,
        store: memoryStore().store,
        shouldContinue: () => true,
        transport: { ...io, recipientInboxRelays: [] },
      })
    ).rejects.toThrow()
    expect(writes).toBe(0)
  })

  it("persists verified eligibility before wrapping, retires, reloads, and delivers the first notice", async () => {
    const f = await fixture()
    const database = new ConduitDB(
      `supplier-retired-intent-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    await database.open()
    try {
      const repository = new DexieCheckoutSparkSettledRepository(database)
      let terminal = f.credited
      for (const [index, leg] of terminal.legs.entries()) {
        const intent =
          index === 1
            ? f.target.intent
            : {
                legId: leg.legId,
                transferId: deriveCheckoutSparkSettledTransferId(
                  f.plan,
                  leg.legId
                ),
                paymentRequest: invoice(leg.allocationSats! - 1, index + 4),
                paymentHash: (index + 4)
                  .toString(16)
                  .padStart(2, "0")
                  .repeat(32),
                invoiceAmountSats: leg.allocationSats! - 1,
                maxFeeSats: 1,
                preparedAt: NOW + 2_000,
              }
        terminal = prepareCheckoutSparkSettledLeg(terminal, intent)
        terminal = recordCheckoutSparkSettledLegStatus(terminal, {
          legId: leg.legId,
          transferId: intent.transferId,
          paymentHash: intent.paymentHash,
          status: "paid",
          observedAt: NOW + 3_000,
          finalFeeSats: index === 1 ? 2 : 1,
          finalDebitSats: index === 1 ? 249 : leg.allocationSats!,
        })
      }
      await repository.create(f.plan)
      await repository.save(terminal, 1)
      await database.checkoutSparkPlanBindings.update(f.plan.checkoutId, {
        merchantSettlement: f.initial,
        invoiceOrigins: [f.origin],
        orderWitness: {
          schemaVersion: 1,
          merchantPubkey: MERCHANT,
          buyerPubkey: "f".repeat(64),
          orderId: f.plan.orderId,
          rumorId: "1".repeat(64),
          contentHash: "2".repeat(64),
          checkoutId: f.plan.checkoutId,
          planDigest: f.plan.planDigest,
        },
      })
      await repository.recordMerchantPayout(
        f.plan,
        f.target,
        f.observation,
        NOW + 3_000
      )
      let stored = await database.checkoutSparkPlanBindings.get(
        f.plan.checkoutId
      )
      expect(stored!.supplierNotificationIntents).toHaveLength(1)
      expect(stored!.supplierNotificationOutbox).toBeUndefined()
      const originalIntent = stored!.supplierNotificationIntents![0]!
      const privateIntent = JSON.stringify(originalIntent)
      expect(privateIntent).not.toContain(f.plan.walletId)
      expect(privateIntent).not.toContain(f.plan.orderId)
      expect(privateIntent).not.toContain(f.plan.funding.paymentRequest)
      expect(privateIntent).not.toContain(
        f.plan.recipients[1]!.destination.value
      )
      const outbox = new DexieCheckoutSparkSupplierNotificationRepository(
        database
      )
      await expect(
        publishCheckoutSparkSupplierPaymentNotification({
          ...f,
          signer,
          store: outbox,
          shouldContinue: () => true,
          transport: {
            ...transport(async () => {
              throw new Error("No relay write expected")
            }),
            recipientInboxRelays: [],
          },
        })
      ).rejects.toThrow()
      expect(
        (await database.checkoutSparkPlanBindings.get(f.plan.checkoutId))!
          .supplierNotificationOutbox
      ).toBeUndefined()
      // Provider zero-funds/refund evidence is simulated; this tests the actual
      // retirement transaction and persistence boundary, not a live payment.
      await repository.retire({
        checkoutId: f.plan.checkoutId,
        planDigest: f.plan.planDigest,
        expectedRevision: 2,
        evidence: {
          walletId: f.plan.walletId,
          network: "mainnet",
          availableSats: 0,
          ownedSats: 0,
          incomingSats: 0,
          observedAt: NOW + 4_000,
          fundingReceiveTerminal: true,
          sendHistoryTerminal: true,
          claimsTerminal: true,
          refundsTerminal: true,
        },
      })
      expect(
        await database.checkoutSparkReconciliations.get(f.plan.checkoutId)
      ).toBeUndefined()
      stored = await database.checkoutSparkPlanBindings.get(f.plan.checkoutId)
      expect(stored!.supplierNotificationIntents).toEqual([originalIntent])
      const reopened = new DexieCheckoutSparkSupplierNotificationRepository(
        database
      )
      const intents = await reopened.listIntents(
        MERCHANT,
        f.plan.checkoutId,
        f.plan.planDigest
      )
      const published: string[] = []
      const io = transport(async (event, options) => {
        published.push(event.id)
        return delivery(options.exclusiveRelayUrls!)
      })
      expect(
        await publishRetainedCheckoutSparkSupplierNotification({
          notification: intents[0]!,
          signer,
          store: reopened,
          shouldContinue: () => true,
          transport: io,
        })
      ).toBe("relay_accepted")
      expect(published).toHaveLength(2)
      expect(
        await publishRetainedCheckoutSparkSupplierNotification({
          notification: intents[0]!,
          signer,
          store: reopened,
          shouldContinue: () => true,
          transport: io,
        })
      ).toBe("relay_accepted")
      expect(published).toHaveLength(2)
      await expect(
        publishRetainedCheckoutSparkSupplierNotification({
          notification: { ...intents[0]!, supplierPubkey: "e".repeat(64) },
          signer,
          store: reopened,
          shouldContinue: () => true,
          transport: io,
        })
      ).rejects.toThrow()
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("atomically keeps one wrap across tabs and retains accepted delivery after retirement", async () => {
    const f = await fixture()
    const database = new ConduitDB(
      `supplier-notifications-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    await database.open()
    try {
      await database.checkoutSparkPlanBindings.put({
        checkoutId: f.plan.checkoutId,
        planDigest: f.plan.planDigest,
        merchantSettlement: f.settlement,
        supplierNotificationIntents: getCheckoutSparkSupplierNotifications(
          f.plan,
          f.settlement
        ),
        orderWitness: {
          schemaVersion: 1,
          merchantPubkey: MERCHANT,
          buyerPubkey: "f".repeat(64),
          orderId: f.plan.orderId,
          rumorId: "1".repeat(64),
          contentHash: "2".repeat(64),
          checkoutId: f.plan.checkoutId,
          planDigest: f.plan.planDigest,
        },
      })
      await database.checkoutSparkReconciliations.put({
        checkoutId: f.plan.checkoutId,
        revision: 1,
        state: createCheckoutSparkSettledReconciliation(f.plan),
      })
      const published: string[] = []
      const io = transport(async (event, options) => {
        published.push(event.id)
        return delivery(options.exclusiveRelayUrls!)
      })
      await Promise.all(
        [1, 2].map(() =>
          publishCheckoutSparkSupplierPaymentNotification({
            ...f,
            signer,
            store: new DexieCheckoutSparkSupplierNotificationRepository(
              database
            ),
            shouldContinue: () => true,
            transport: io,
          })
        )
      )
      const binding = await database.checkoutSparkPlanBindings.get(
        f.plan.checkoutId
      )
      expect(binding!.supplierNotificationOutbox).toHaveLength(1)
      const record = binding!.supplierNotificationOutbox![0]!.record
      expect(new Set(published).size).toBe(2)
      // The real retirement retains this binding; removing the active state
      // models its completed cleanup without inventing payment evidence.
      await database.checkoutSparkReconciliations.delete(f.plan.checkoutId)
      const reopened = new DexieCheckoutSparkSupplierNotificationRepository(
        database
      )
      expect(
        (await reopened.load(record.notification))?.recipientAccepted
      ).toBe(true)
      const count = published.length
      expect(
        await retryCheckoutSparkSupplierNotification({
          record,
          signer,
          store: reopened,
          shouldContinue: () => true,
          transport: io,
        })
      ).toBe("relay_accepted")
      expect(published).toHaveLength(count)
    } finally {
      database.close()
      await database.delete()
    }
  })
})
