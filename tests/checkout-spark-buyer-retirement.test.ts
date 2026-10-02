import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { generateMnemonic } from "../apps/market/node_modules/@scure/bip39/index.js"
import { wordlist } from "../apps/market/node_modules/@scure/bip39/wordlists/english.js"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { ConduitDB } from "@conduit/core/db"
import {
  CONDUIT_CHECKOUT_FEE_RECIPIENT,
  GUEST_ORDER_LOCAL_RETENTION_MS,
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  projectCheckoutSparkMerchantSettlement,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type OrderLifecycle,
} from "@conduit/core"
import { FirstPartySparkSdkFactory } from "../apps/market/src/lib/spark-sdk"
import { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import type { GuestOrderSigningIdentity } from "../apps/market/src/lib/guest-order-identity"
import { deriveMerchantCheckoutSparkRecoveryIdentity } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { retireCheckoutSparkSettledShopper } from "../apps/market/src/lib/checkout-spark-settled-retirement"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = Math.floor(Date.now() / 1_000) * 1_000 - 1_000
const MERCHANT = "a".repeat(64)
const BUYER = "b".repeat(64)
const WALLET_ID = "buyer-retirement-wallet"
// Runtime-generated synthetic recovery; the fixture never opens a provider connection.
const CREDENTIALS = {
  mnemonic: generateMnemonic(wordlist),
  accountNumber: 0,
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function invoice(amountSats: number, preimage: Uint8Array): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbcrt${amountSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(createHash("sha256").update(preimage).digest()),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField("Synthetic buyer retirement"),
      { tag: "x", words: [28, 4] },
    ],
  })
}

async function withFixture(
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  options: { feeReserve?: number; guest?: boolean } = {}
) {
  const f = await fixture(options)
  try {
    await run(f)
  } finally {
    await f.manager.close(WALLET_ID)
    f.database.close()
    await f.database.delete()
  }
}

async function fixture(options: { feeReserve?: number; guest?: boolean } = {}) {
  const database = new ConduitDB(`buyer-retirement-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const repository = new DexieCheckoutSparkSettledRepository(database)
  const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
    CREDENTIALS.mnemonic,
    CREDENTIALS.accountNumber
  )
  const native = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      invoice(amountSats, new Uint8Array(32).fill(61)),
  })
  const guestSigner = options.guest
    ? new NDKPrivateKeySigner("11".repeat(32))
    : null
  const guest: GuestOrderSigningIdentity | null = guestSigner
    ? {
        kind: "guest_ephemeral",
        orderId: "buyer-retirement-order",
        merchantPubkey: MERCHANT,
        pubkey: guestSigner.pubkey,
        createdAt: NOW,
        expiresAt: NOW + GUEST_ORDER_LOCAL_RETENTION_MS,
        signer: guestSigner,
      }
    : null
  const buyer = guest?.pubkey ?? BUYER
  const authority = {
    active: true,
    buyer: buyer as string | null,
    guest,
    now: NOW + 100,
  }
  const nativeReads = { opened: 0, closed: 0 }
  const hooks: {
    omitHistoryTransfer?: boolean
    failHistory?: boolean
    failCleanupOnce?: boolean
    beforeFundingRead?: () => Promise<void>
    beforePayoutRead?: () => Promise<void>
    afterPending?: () => Promise<void>
  } = {}
  const manager = new SparkWalletManager(
    new FirstPartySparkSdkFactory({
      network: "regtest",
      now: () => NOW,
      wait: async () => {},
      loadModule: async () => ({
        ...native.module,
        decodeSparkAddress(address, network) {
          if (
            address !== `hermetic-regtest:0:${identity}` ||
            network !== "REGTEST"
          ) {
            throw new Error("Synthetic address scope changed")
          }
          return { identityPublicKey: identity }
        },
        getNetworkFromSparkAddress: () => "REGTEST",
        isValidSparkAddress: (address) =>
          address === `hermetic-regtest:0:${identity}`,
        async initialize(input) {
          const { wallet } = await native.module.initialize(input)
          return {
            wallet: {
              ...wallet,
              async getLightningReceiveRequest(id) {
                await hooks.beforeFundingRead?.()
                return wallet.getLightningReceiveRequest(id)
              },
              async getTransferFromSsp(id) {
                await hooks.beforePayoutRead?.()
                return wallet.getTransferFromSsp(id)
              },
              async openRetirementReader() {
                nativeReads.opened += 1
                const opened = await native.openAuthenticatedRetirementReader({
                  ...CREDENTIALS,
                  network: "regtest",
                })
                return {
                  reader: {
                    ...opened.reader,
                    async getTransfers(request) {
                      if (hooks.failHistory)
                        throw new Error("Synthetic history unavailable")
                      const result = await opened.reader.getTransfers(request)
                      return hooks.omitHistoryTransfer
                        ? {
                            ...result,
                            transfers: result.transfers.slice(0, -1),
                          }
                        : result
                    },
                    async getPendingTransfers(address) {
                      const result =
                        await opened.reader.getPendingTransfers(address)
                      await hooks.afterPending?.()
                      return result
                    },
                  },
                  async cleanup() {
                    nativeReads.closed += 1
                    await opened.cleanup()
                    if (hooks.failCleanupOnce) {
                      hooks.failCleanupOnce = false
                      throw new Error("Synthetic reader cleanup unavailable")
                    }
                  },
                }
              },
            },
          }
        },
      }),
    }),
    async () => ({ release: async () => {} }),
    undefined,
    () => authority.now
  )
  await manager.openWithMnemonic({ walletId: WALLET_ID, ...CREDENTIALS })
  const control = native.control.forIdentity(identity)
  const receive = await manager.createCheckoutReceive(WALLET_ID, {
    receiveMode: "ordinary_settled_v3",
    description: "Synthetic checkout",
    requiredNetSats: 1_113,
    grossFundingSats: 1_113,
    expirySecs: 900,
  })
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "buyer-retirement-checkout",
    orderId: "buyer-retirement-order",
    merchantPubkey: MERCHANT,
    walletId: WALLET_ID,
    network: "regtest",
    createdAt: NOW,
    takeoverAt: NOW + 120_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:retirement`,
          productEventId: "c".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: receive.id,
      paymentRequest: receive.paymentRequest,
      paymentHash: receive.paymentHash,
      receiverIdentityPublicKey: identity,
      grossFundingSats: receive.grossFundingSats,
      createdAt: receive.createdAt,
      expiresAt: receive.expiresAt,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@wallet.conduit.market",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: NOW / 1_000,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: CONDUIT_CHECKOUT_FEE_RECIPIENT,
        destination: {
          type: "lightning_address",
          value: CONDUIT_CHECKOUT_FEE_RECIPIENT,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: 111,
      },
    ],
  })
  await repository.create(plan)
  control.completeFunding()
  const credit = await manager.attestCheckoutReceiveCredit(WALLET_ID, receive)
  if (!credit) throw new Error("Synthetic receive was not credited")
  let state = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(plan),
    {
      ...credit,
      paymentHash: plan.funding.paymentHash,
      observedAt: NOW + 1,
    }
  )
  let revision = 1
  await repository.save(state, revision++)
  for (const [index, leg] of state.legs.entries()) {
    const preimage = new Uint8Array(32).fill(62 + index)
    const reserve = options.feeReserve ?? 1
    const amount = leg.allocationSats! - reserve
    const paymentRequest = invoice(amount, preimage)
    control.registerPayout({
      paymentRequest,
      preimage: Buffer.from(preimage).toString("hex"),
      feeSats: 1,
    })
    const intent = {
      legId: leg.legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, leg.legId),
      paymentRequest,
      paymentHash: createHash("sha256").update(preimage).digest("hex"),
      invoiceAmountSats: amount,
      maxFeeSats: reserve,
      preparedAt: NOW + 2 + index * 2,
    }
    state = prepareCheckoutSparkSettledLeg(state, intent)
    const resolved = await resolveCheckoutSparkFixtureInvoice(
      {
        lud16: plan.recipients[index]!.destination.value,
        amountSats: amount,
        network: "regtest",
        nowSeconds: NOW / 1_000,
        shouldContinue: () => true,
      },
      paymentRequest
    )
    await repository.savePreparedWithInvoiceOrigin(state, revision++, {
      legId: leg.legId,
      origin: resolved.origin!,
    })
    const sent = await manager.sendCheckoutLightningObligation(WALLET_ID, {
      network: "regtest",
      transferId: intent.transferId,
      paymentRequest,
      amountSats: amount,
      maxFeeSats: reserve,
      assertBeforeSend: async () => {},
    })
    if (sent.status !== "paid") throw new Error("Synthetic payout was not paid")
    state = recordCheckoutSparkSettledLegStatus(state, {
      legId: leg.legId,
      transferId: intent.transferId,
      paymentHash: intent.paymentHash,
      status: "paid",
      finalFeeSats: 1,
      finalDebitSats: amount + 1,
      observedAt: intent.preparedAt + 1,
    })
    await repository.save(state, revision++)
  }
  const order: OrderLifecycle = {
    orderId: plan.orderId,
    buyerPubkey: buyer,
    buyerIdentityKind: guest ? "guest_ephemeral" : "signed_in",
    ...(guest ? { guestSessionExpiresAt: guest.expiresAt } : {}),
    merchantPubkey: MERCHANT,
    checkoutMode: "private_checkout",
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId: WALLET_ID,
    },
    items: [],
    itemSubtotalSats: 1_000,
    shippingCostSats: 0,
    totalSats: 1_000,
    totalMsats: 1_000_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "sent",
    invoiceStatus: "received",
    paymentStatus: "paid",
    proofDeliveryStatus: "sent",
    zapReceiptStatus: "not_applicable",
    phase: "completed",
    createdAt: NOW,
    updatedAt: NOW + 10,
  }
  await database.orderLifecycles.put(order)
  await repository.bindBuyerOrder(plan, buyer, () => {})
  return {
    database,
    repository,
    manager,
    plan,
    control,
    nativeReads,
    authority,
    hooks,
    input: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      orderId: plan.orderId,
      merchantPubkey: MERCHANT,
      network: "regtest" as const,
      buyerPubkey: buyer,
      currentBuyerPubkey: () => authority.buyer,
      guestIdentity: guest,
      currentGuestIdentity: () => authority.guest,
      shouldContinue: () => authority.active,
    },
    dependencies: {
      repository,
      readOrder: (id: string) => database.orderLifecycles.get(id),
      sparkManager: () => manager,
      now: () => authority.now,
    },
  }
}

describe("buyer successful checkout retirement", () => {
  it("bounds a stalled funding attestation and ignores its late result without changing recovery", async () => {
    await withFixture(async (f) => {
      const entered = deferred()
      const release = deferred()
      f.hooks.beforeFundingRead = async () => {
        entered.resolve()
        await release.promise
      }
      const before = await f.repository.loadBuyerSettlement(
        f.plan.checkoutId,
        f.plan.planDigest,
        BUYER
      )
      const providerBefore = f.control.snapshot()
      const retirement = retireCheckoutSparkSettledShopper(
        f.input,
        f.dependencies
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await entered.promise
        const result = await Promise.race([
          retirement,
          new Promise<"inspection_did_not_finish">((resolve) => {
            timer = setTimeout(
              () => resolve("inspection_did_not_finish"),
              6_000
            )
          }),
        ])
        expect(result).toEqual({ status: "unavailable" })
        expect(
          await f.repository.loadBuyerSettlement(
            f.plan.checkoutId,
            f.plan.planDigest,
            BUYER
          )
        ).toEqual(before)
        release.resolve()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(
          await f.repository.loadBuyerSettlement(
            f.plan.checkoutId,
            f.plan.planDigest,
            BUYER
          )
        ).toEqual(before)
        expect(f.nativeReads.opened).toBe(0)
        expect(f.control.snapshot()).toEqual(providerBefore)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        release.resolve()
        await retirement
      }
    })
  }, 10_000)

  it("bounds a stalled payout inspection and ignores its late result without advancing retirement", async () => {
    await withFixture(async (f) => {
      const entered = deferred()
      const release = deferred()
      f.hooks.beforePayoutRead = async () => {
        entered.resolve()
        await release.promise
      }
      const before = await f.repository.load(
        f.plan.checkoutId,
        f.plan.planDigest
      )
      const providerBefore = f.control.snapshot()
      const retirement = retireCheckoutSparkSettledShopper(
        f.input,
        f.dependencies
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await entered.promise
        const result = await Promise.race([
          retirement,
          new Promise<"inspection_did_not_finish">((resolve) => {
            timer = setTimeout(
              () => resolve("inspection_did_not_finish"),
              6_000
            )
          }),
        ])
        expect(result).toEqual({ status: "unavailable" })
        expect(
          await f.repository.load(f.plan.checkoutId, f.plan.planDigest)
        ).toEqual(before)
        const timedOut = await f.repository.loadBuyerSettlement(
          f.plan.checkoutId,
          f.plan.planDigest,
          BUYER
        )
        expect(timedOut.status).toBe("active")
        release.resolve()
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(
          await f.repository.loadBuyerSettlement(
            f.plan.checkoutId,
            f.plan.planDigest,
            BUYER
          )
        ).toEqual(timedOut)
        expect(f.nativeReads.opened).toBe(0)
        expect(f.control.snapshot()).toEqual(providerBefore)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        release.resolve()
        await retirement
      }
    })
  }, 10_000)

  it("retires an exactly bound paid checkout only after native zero-funds history and retains its paid projection", async () => {
    await withFixture(async (f) => {
      const before = f.control.snapshot()
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "retired" })
      const saved = await f.repository.loadBuyerSettlement(
        f.plan.checkoutId,
        f.plan.planDigest,
        BUYER
      )
      expect(saved.status).toBe("retired")
      if (saved.status === "retired") {
        expect(saved.settlement).not.toBeNull()
        expect(
          projectCheckoutSparkMerchantSettlement(saved.settlement!)
        ).toMatchObject({ commerceVerified: true, feePending: false })
      }
      expect(f.control.snapshot()).toEqual(before)
      expect(f.nativeReads).toEqual({ opened: 1, closed: 1 })
    })
  })

  it("keeps paid commerce and recovery when real send fees leave residual sats", async () => {
    await withFixture(
      async (f) => {
        const before = f.control.snapshot()
        expect(
          await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
        ).toEqual({ status: "retirement_pending" })
        const saved = await f.repository.loadBuyerSettlement(
          f.plan.checkoutId,
          f.plan.planDigest,
          BUYER
        )
        expect(saved.status).toBe("active")
        if (saved.status === "active") {
          expect(saved.state.legs.every((leg) => leg.status === "paid")).toBe(
            true
          )
          expect(
            projectCheckoutSparkMerchantSettlement(saved.settlement!)
          ).toMatchObject({ commerceVerified: true, feePending: false })
        }
        expect((await f.manager.getFundsState(WALLET_ID)).availableSats).toBe(2)
        expect(f.control.snapshot()).toEqual(before)
        expect(f.nativeReads).toEqual({ opened: 1, closed: 1 })
      },
      { feeReserve: 2 }
    )
  })

  it("returns the retained buyer tombstone on retry without reopening the wallet or sending again", async () => {
    await withFixture(async (f) => {
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "retired" })
      const before = f.control.snapshot()
      await f.manager.close(WALLET_ID)
      f.authority.now = f.plan.takeoverAt + 1
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "retired" })
      expect(f.nativeReads).toEqual({ opened: 1, closed: 1 })
      expect(f.control.snapshot()).toEqual(before)
    })
  })

  it("retires a completed guest checkout only for its current bounded signing session", async () => {
    await withFixture(
      async (f) => {
        expect(
          await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
        ).toEqual({ status: "retired" })
        expect(
          (
            await f.repository.loadBuyerSettlement(
              f.plan.checkoutId,
              f.plan.planDigest,
              f.input.buyerPubkey
            )
          ).status
        ).toBe("retired")
      },
      { guest: true }
    )
  })

  it("does not use a guest lifecycle containing private contact data as cleanup authority", async () => {
    await withFixture(
      async (f) => {
        await f.database.orderLifecycles.update(f.plan.orderId, {
          contactNote: "Synthetic contact",
        })
        expect(
          await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
        ).toEqual({ status: "unavailable" })
        expect(
          (await f.repository.load(f.plan.checkoutId, f.plan.planDigest)).status
        ).toBe("active")
        expect(f.nativeReads.opened).toBe(0)
      },
      { guest: true }
    )
  })

  for (const condition of [
    "locked",
    "incoming",
    "incomplete_history",
    "history_unavailable",
  ] as const) {
    it(`preserves the active paid checkout while ${condition} prevents terminal evidence`, async () => {
      await withFixture(async (f) => {
        if (condition === "locked") f.control.setAdditionalOwnedSats(1)
        if (condition === "incoming")
          f.control.setPendingTransfers([
            {
              id: "synthetic-pending-inbound",
              type: 3,
              status: 2,
              network: 2,
              totalValue: 1,
            },
          ])
        if (condition === "incomplete_history")
          f.hooks.omitHistoryTransfer = true
        if (condition === "history_unavailable") f.hooks.failHistory = true
        const before = f.control.snapshot()
        expect(
          await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
        ).toEqual({ status: "retirement_pending" })
        const saved = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        expect(saved.status).toBe("active")
        if (saved.status === "active")
          expect(saved.state.legs.every((leg) => leg.status === "paid")).toBe(
            true
          )
        expect(f.nativeReads).toEqual({ opened: 1, closed: 1 })
        expect(f.control.snapshot()).toEqual(before)
      })
    })
  }

  for (const change of [
    "signout",
    "refund_requested",
    "takeover",
    "order_binding",
    "wallet_closed",
    "guest_removed",
    "guest_replaced",
  ] as const) {
    it(`preserves recovery when ${change} changes during authenticated terminal inspection`, async () => {
      await withFixture(
        async (f) => {
          f.hooks.afterPending = async () => {
            if (change === "signout") f.authority.buyer = null
            // Merchant conversation status belongs to the caller's live guard,
            // not to OrderLifecycle.phase.
            if (change === "refund_requested") f.authority.active = false
            if (change === "takeover") f.authority.now = f.plan.takeoverAt
            if (change === "order_binding")
              await f.database.orderLifecycles.update(f.plan.orderId, {
                checkoutSparkRouterBinding: {
                  checkoutId: "another-checkout",
                  planDigest: f.plan.planDigest,
                  walletId: WALLET_ID,
                },
              })
            if (change === "wallet_closed") await f.manager.close(WALLET_ID)
            if (change === "guest_removed") f.authority.guest = null
            if (change === "guest_replaced") {
              const previous = f.authority.guest!
              f.authority.guest = {
                ...previous,
                createdAt: previous.createdAt + 1,
                expiresAt: previous.expiresAt + 1,
              }
            }
          }
          const before = f.control.snapshot()
          expect(
            await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
          ).toEqual({ status: "unavailable" })
          expect(
            (await f.repository.load(f.plan.checkoutId, f.plan.planDigest))
              .status
          ).toBe("active")
          expect(f.nativeReads).toEqual({ opened: 1, closed: 1 })
          expect(f.control.snapshot()).toEqual(before)
        },
        { guest: change.startsWith("guest_") }
      )
    })
  }

  it("does not start buyer inspection at the frozen Merchant takeover boundary", async () => {
    await withFixture(async (f) => {
      f.authority.now = f.plan.takeoverAt
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "unavailable" })
      expect(f.nativeReads.opened).toBe(0)
      expect(
        (await f.repository.load(f.plan.checkoutId, f.plan.planDigest)).status
      ).toBe("active")
    })
  })

  it("rolls back the tombstone when buyer authority changes inside the retirement transaction", async () => {
    await withFixture(async (f) => {
      f.database.checkoutSparkRetirements.hook("creating", () => {
        f.authority.active = false
      })
      const before = f.control.snapshot()
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "unavailable" })
      expect(
        (await f.repository.load(f.plan.checkoutId, f.plan.planDigest)).status
      ).toBe("active")
      expect(f.nativeReads).toEqual({ opened: 1, closed: 1 })
      expect(f.control.snapshot()).toEqual(before)
    })
  })

  it("does not clean up a cancelled checkout even when its recorded payouts are paid", async () => {
    await withFixture(async (f) => {
      await f.database.orderLifecycles.update(f.plan.orderId, {
        phase: "cancelled",
      })
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "unavailable" })
      expect(
        (await f.repository.load(f.plan.checkoutId, f.plan.planDigest)).status
      ).toBe("active")
      expect(f.nativeReads.opened).toBe(0)
    })
  })

  it("does not expose a cleanup result for an order cancelled after retirement", async () => {
    await withFixture(async (f) => {
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "retired" })
      await f.database.orderLifecycles.update(f.plan.orderId, {
        phase: "cancelled",
      })
      const before = f.control.snapshot()
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "unavailable" })
      expect(f.nativeReads).toEqual({ opened: 1, closed: 1 })
      expect(f.control.snapshot()).toEqual(before)
    })
  })

  it("does not begin inspection after a refund request revokes the caller's cleanup authority", async () => {
    await withFixture(async (f) => {
      f.authority.active = false
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "unavailable" })
      expect(
        (await f.repository.load(f.plan.checkoutId, f.plan.planDigest)).status
      ).toBe("active")
      expect(f.nativeReads.opened).toBe(0)
    })
  })

  it("keeps recovery when a concurrent state save supersedes the inspected revision", async () => {
    await withFixture(async (f) => {
      f.hooks.afterPending = async () => {
        const current = await f.repository.load(
          f.plan.checkoutId,
          f.plan.planDigest
        )
        if (current.status !== "active")
          throw new Error("Synthetic state unavailable")
        await f.repository.save(current.state, current.revision)
      }
      const before = f.control.snapshot()
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "unavailable" })
      expect(
        (await f.repository.load(f.plan.checkoutId, f.plan.planDigest)).status
      ).toBe("active")
      expect(f.control.snapshot()).toEqual(before)
      expect(f.nativeReads).toEqual({ opened: 1, closed: 1 })
    })
  })

  it("keeps recovery if authenticated reader cleanup fails before the retirement commit", async () => {
    await withFixture(async (f) => {
      f.hooks.failCleanupOnce = true
      const before = f.control.snapshot()
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "unavailable" })
      expect(
        (await f.repository.load(f.plan.checkoutId, f.plan.planDigest)).status
      ).toBe("active")
      expect(f.control.snapshot()).toEqual(before)
    })
  })

  it("does not retire paid-looking state without durable exact invoice-origin evidence", async () => {
    await withFixture(async (f) => {
      await f.database.checkoutSparkPlanBindings.update(f.plan.checkoutId, {
        invoiceOrigins: [],
      })
      const before = f.control.snapshot()
      expect(
        await retireCheckoutSparkSettledShopper(f.input, f.dependencies)
      ).toEqual({ status: "unavailable" })
      expect(
        (await f.repository.load(f.plan.checkoutId, f.plan.planDigest)).status
      ).toBe("active")
      expect(f.nativeReads.opened).toBe(0)
      expect(f.control.snapshot()).toEqual(before)
    })
  })
})
