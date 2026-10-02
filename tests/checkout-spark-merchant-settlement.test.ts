import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"

import { ConduitDB } from "@conduit/core/db"
import {
  DexieCheckoutSparkSettledRepository,
  CheckoutSparkInvoiceOriginUnavailableError,
  CheckoutSparkSettledRepositoryConflictError,
  createCheckoutSparkMerchantSettlementRecord,
  createCheckoutSparkInvoiceOriginRecord,
  createCheckoutSparkSettledReconciliation,
  decodeLightningInvoicePaymentHash,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  projectCheckoutSparkMerchantSettlement,
  recordCheckoutSparkMerchantCredit,
  recordCheckoutSparkMerchantPayout,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  restoreCheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingTarget,
} from "@conduit/core/protocol"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"

const CREATED_SECONDS = 1_800_000_000
const CREATED_AT = CREATED_SECONDS * 1_000
const MERCHANT = "a".repeat(64)
const SUPPLIER = "b".repeat(64)

function invoice(amountSats: number, byte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_SECONDS,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(byte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function plan() {
  return freezeCheckoutSparkSettledPlan({
    checkoutId: "settlement-checkout",
    orderId: "settlement-order",
    merchantPubkey: MERCHANT,
    walletId: "settlement-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    commerceQuote: {
      commerceTotalSats: 100_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:sku`,
          productEventId: "c".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 100_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "settlement-receive",
      paymentRequest: invoice(102_250, 1),
      paymentHash: "01".repeat(32),
      receiverIdentityPublicKey: `02${"f".repeat(64)}`,
      grossFundingSats: 102_250,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "d".repeat(64),
            profileEventCreatedAt: CREATED_SECONDS - 1,
          },
        },
        weightSats: 80_000,
      },
      {
        kind: "supplier",
        recipientId: SUPPLIER,
        destination: {
          type: "lightning_address",
          value: "supplier@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: CREATED_SECONDS - 1,
          },
        },
        weightSats: 20_000,
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: {
            type: "conduit_allowlist",
            policy: "local_router_canary",
          },
        },
        weightSats: 2_100,
      },
    ],
  })
}

function creditProof() {
  return {
    mode: "ordinary_v3" as const,
    requestId: "settlement-receive",
    transferId: "exact-funding-transfer",
    receiverIdentityPublicKey: `02${"f".repeat(64)}`,
    grossSats: 102_250,
    creditedSats: 102_200,
  }
}

function payout(
  frozen: ReturnType<typeof plan>,
  kind: "merchant" | "supplier" | "conduit"
) {
  const credited = recordCheckoutSparkSettledCredit(
    createCheckoutSparkSettledReconciliation(frozen),
    {
      ...creditProof(),
      paymentHash: frozen.funding.paymentHash,
      observedAt: CREATED_AT + 1_000,
    }
  )
  const recipient = frozen.recipients.find(
    (candidate) => candidate.kind === kind
  )!
  const allocationSats = credited.legs.find(
    (leg) => leg.legId === recipient.legId
  )!.allocationSats!
  const byte = kind === "merchant" ? 2 : kind === "supplier" ? 3 : 4
  const outgoingInvoice = invoice(allocationSats - 1, byte)
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: frozen.walletId,
    network: frozen.network,
    legId: recipient.legId,
    recipientId: recipient.recipientId,
    allocationSats,
    unpaidAllocationSats: creditProof().creditedSats,
    intent: {
      legId: recipient.legId,
      transferId: deriveCheckoutSparkSettledTransferId(frozen, recipient.legId),
      paymentRequest: outgoingInvoice,
      paymentHash: decodeLightningInvoicePaymentHash(outgoingInvoice)!,
      invoiceAmountSats: allocationSats - 1,
      maxFeeSats: 1,
      preparedAt: CREATED_AT + 2_000,
    },
  }
  const observation: CheckoutSparkSettledOutgoingObservation = {
    legId: target.legId,
    transferId: target.intent.transferId,
    paymentRequest: target.intent.paymentRequest,
    paymentHash: target.intent.paymentHash,
    invoiceAmountSats: target.intent.invoiceAmountSats,
    maxFeeSats: target.intent.maxFeeSats,
    status: "paid",
    finalFeeSats: 1,
    finalDebitSats: allocationSats,
  }
  return { frozen, target, observation }
}

async function localOrigin(exact: ReturnType<typeof payout>) {
  const recipient = exact.frozen.recipients.find(
    (leg) => leg.legId === exact.target.legId
  )!
  const resolved = await resolveCheckoutSparkFixtureInvoice(
    {
      lud16: recipient.destination.value,
      network: exact.frozen.network,
      amountSats: exact.target.intent.invoiceAmountSats,
      nowSeconds: Math.floor(exact.target.intent.preparedAt / 1_000),
      shouldContinue: () => true,
    },
    exact.target.intent.paymentRequest
  )
  return {
    token: resolved.origin!,
    record: createCheckoutSparkInvoiceOriginRecord(
      exact.frozen,
      exact.target,
      resolved.origin!
    ),
  }
}

describe("Merchant provider-verified settlement projection", () => {
  it("requires exact credit and all commerce payouts; fee is independent", async () => {
    const frozen = plan()
    const initial = createCheckoutSparkMerchantSettlementRecord(frozen)
    expect(projectCheckoutSparkMerchantSettlement(initial)).toEqual({
      creditVerified: false,
      merchantVerified: false,
      commerceVerified: false,
      feePending: false,
      recipientUnverified: false,
    })
    const credit = recordCheckoutSparkMerchantCredit(
      initial,
      frozen,
      creditProof(),
      CREATED_AT + 1_000
    )
    expect(
      projectCheckoutSparkMerchantSettlement(credit).commerceVerified
    ).toBe(false)
    expect(projectCheckoutSparkMerchantSettlement(credit).feePending).toBe(true)
    const merchant = payout(frozen, "merchant")
    const merchantPaid = recordCheckoutSparkMerchantPayout(
      credit,
      frozen,
      merchant.target,
      merchant.observation,
      CREATED_AT + 3_000,
      (await localOrigin(merchant)).record
    )
    expect(projectCheckoutSparkMerchantSettlement(merchantPaid)).toEqual({
      creditVerified: true,
      merchantVerified: true,
      commerceVerified: false,
      feePending: true,
      recipientUnverified: false,
    })
    const supplier = payout(frozen, "supplier")
    const commercePaid = recordCheckoutSparkMerchantPayout(
      merchantPaid,
      frozen,
      supplier.target,
      supplier.observation,
      CREATED_AT + 4_000,
      (await localOrigin(supplier)).record
    )
    expect(projectCheckoutSparkMerchantSettlement(commercePaid)).toEqual({
      creditVerified: true,
      merchantVerified: true,
      commerceVerified: true,
      feePending: true,
      recipientUnverified: false,
    })
    const fee = payout(frozen, "conduit")
    expect(() =>
      recordCheckoutSparkMerchantPayout(
        commercePaid,
        frozen,
        fee.target,
        { ...fee.observation, status: "pending" },
        CREATED_AT + 5_000
      )
    ).toThrow()
    expect(
      projectCheckoutSparkMerchantSettlement(commercePaid).commerceVerified
    ).toBe(true)
    const allPaid = recordCheckoutSparkMerchantPayout(
      commercePaid,
      frozen,
      fee.target,
      fee.observation,
      CREATED_AT + 6_000
    )
    expect(projectCheckoutSparkMerchantSettlement(allPaid).feePending).toBe(
      false
    )
    expect(projectCheckoutSparkMerchantSettlement(allPaid)).toMatchObject({
      commerceVerified: true,
      recipientUnverified: true,
    })
    expect(
      recordCheckoutSparkMerchantPayout(
        allPaid,
        frozen,
        fee.target,
        fee.observation,
        CREATED_AT + 7_000
      )
    ).toEqual(allPaid)
    expect(JSON.stringify(allPaid)).not.toMatch(
      /paymentRequest|paymentHash|preimage|mnemonic|destination|@rizful/
    )
  })

  it("retains unattributed exact paid evidence before credit without claiming recipient payment", () => {
    const frozen = plan()
    const merchant = payout(frozen, "merchant")
    const paid = recordCheckoutSparkMerchantPayout(
      createCheckoutSparkMerchantSettlementRecord(frozen),
      frozen,
      merchant.target,
      merchant.observation,
      CREATED_AT + 3_000
    )
    expect(projectCheckoutSparkMerchantSettlement(paid)).toEqual({
      creditVerified: false,
      merchantVerified: false,
      commerceVerified: false,
      feePending: false,
      recipientUnverified: true,
    })
    const credited = recordCheckoutSparkMerchantCredit(
      paid,
      frozen,
      creditProof(),
      CREATED_AT + 4_000
    )
    expect(
      projectCheckoutSparkMerchantSettlement(credited).creditVerified
    ).toBe(true)
    expect(() =>
      recordCheckoutSparkMerchantCredit(
        credited,
        frozen,
        { ...creditProof(), transferId: "other-transfer" },
        CREATED_AT + 5_000
      )
    ).toThrow()
  })

  it("rejects a changed plan, mismatched provider observation and extra private fields", () => {
    const frozen = plan()
    const merchant = payout(frozen, "merchant")
    const initial = createCheckoutSparkMerchantSettlementRecord(frozen)
    expect(() =>
      recordCheckoutSparkMerchantPayout(
        initial,
        frozen,
        merchant.target,
        { ...merchant.observation, transferId: "wrong" },
        CREATED_AT + 3_000
      )
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkMerchantSettlementRecord({
        ...initial,
        paymentRequest: "not-allowed",
      } as typeof initial)
    ).toThrow()
    expect(() =>
      restoreCheckoutSparkMerchantSettlementRecord(
        { ...initial, planDigest: "f".repeat(64) },
        frozen
      )
    ).toThrow()
  })

  it("persists monotonic exact facts privately and scopes loads to principal", async () => {
    const database = new ConduitDB(`settlement-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const frozen = plan()
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.create(frozen)
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          frozen.checkoutId,
          frozen.planDigest
        )
      ).toBeNull()
      const merchant = payout(frozen, "merchant")
      await expect(
        repository.recordMerchantPayout(
          frozen,
          merchant.target,
          merchant.observation,
          CREATED_AT + 3_000
        )
      ).rejects.toThrow()
      const initiallyCredited = recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(frozen),
        {
          ...creditProof(),
          paymentHash: frozen.funding.paymentHash,
          observedAt: CREATED_AT + 1_000,
        }
      )
      const preparedMerchant = prepareCheckoutSparkSettledLeg(
        initiallyCredited,
        merchant.target.intent
      )
      await repository.savePreparedWithInvoiceOrigin(preparedMerchant, 1, {
        legId: merchant.target.legId,
        origin: (await localOrigin(merchant)).token,
      })
      await repository.recordMerchantPayout(
        frozen,
        merchant.target,
        merchant.observation,
        CREATED_AT + 3_000
      )
      const stored = await repository.loadMerchantSettlement(
        MERCHANT,
        frozen.checkoutId,
        frozen.planDigest
      )
      expect(
        stored &&
          projectCheckoutSparkMerchantSettlement(stored).commerceVerified
      ).toBe(false)
      await repository.recordMerchantCredit(
        frozen,
        creditProof(),
        CREATED_AT + 4_000
      )
      const reload = new DexieCheckoutSparkSettledRepository(database)
      expect(await reload.hasInvoiceOrigin(frozen, merchant.target)).toBe(true)
      await expect(
        reload.assertLocalInvoiceOrigin(frozen, merchant.target)
      ).resolves.toBeUndefined()
      const verified = await reload.loadMerchantSettlement(
        MERCHANT,
        frozen.checkoutId,
        frozen.planDigest
      )
      expect(
        verified &&
          projectCheckoutSparkMerchantSettlement(verified).creditVerified
      ).toBe(true)
      await expect(
        reload.loadMerchantSettlement(
          "b".repeat(64),
          frozen.checkoutId,
          frozen.planDigest
        )
      ).rejects.toThrow()
      const row = await database.checkoutSparkPlanBindings.get(
        frozen.checkoutId
      )
      expect(row?.merchantSettlement).toEqual(verified)
      expect(JSON.stringify(row?.merchantSettlement)).not.toContain(
        "merchant@example.test"
      )

      // Buyer/local paid markers alone cannot elevate an unverified supplier.
      let state = preparedMerchant
      for (const [index, kind] of (
        ["merchant", "supplier", "conduit"] as const
      ).entries()) {
        const exact = payout(frozen, kind)
        if (kind !== "merchant") {
          state = prepareCheckoutSparkSettledLeg(state, exact.target.intent)
        }
        state = recordCheckoutSparkSettledLegStatus(state, {
          legId: exact.target.legId,
          transferId: exact.target.intent.transferId,
          paymentHash: exact.target.intent.paymentHash,
          status: "paid",
          observedAt: CREATED_AT + 5_000 + index,
          finalFeeSats: 1,
          finalDebitSats: exact.target.allocationSats,
        })
      }
      const saved = await repository.save(state, 2)
      if (saved.status !== "active") throw new Error("Expected active checkout")
      await repository.retire({
        checkoutId: frozen.checkoutId,
        planDigest: frozen.planDigest,
        expectedRevision: saved.revision,
        evidence: {
          walletId: frozen.walletId,
          network: frozen.network,
          observedAt: state.updatedAt + 1,
          availableSats: 0,
          ownedSats: 0,
          incomingSats: 0,
          fundingReceiveTerminal: true,
          sendHistoryTerminal: true,
          claimsTerminal: true,
          refundsTerminal: true,
        },
      })
      const afterRetirement = await reload.loadMerchantSettlement(
        MERCHANT,
        frozen.checkoutId,
        frozen.planDigest
      )
      expect(
        afterRetirement &&
          projectCheckoutSparkMerchantSettlement(afterRetirement)
      ).toEqual({
        creditVerified: true,
        merchantVerified: true,
        commerceVerified: false,
        feePending: true,
        recipientUnverified: false,
      })
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.invoiceOrigins
      ).toBeUndefined()
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("merges independent provider facts across clients and rolls back lost authority", async () => {
    const database = new ConduitDB(`settlement-race-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const frozen = plan()
      const first = new DexieCheckoutSparkSettledRepository(database)
      const second = new DexieCheckoutSparkSettledRepository(database)
      const merchant = payout(frozen, "merchant")
      await first.create(frozen)
      const credited = recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(frozen),
        {
          ...creditProof(),
          paymentHash: frozen.funding.paymentHash,
          observedAt: CREATED_AT + 1_000,
        }
      )
      await first.savePreparedWithInvoiceOrigin(
        prepareCheckoutSparkSettledLeg(credited, merchant.target.intent),
        1,
        {
          legId: merchant.target.legId,
          origin: (await localOrigin(merchant)).token,
        }
      )
      await Promise.all([
        first.recordMerchantCredit(frozen, creditProof(), CREATED_AT + 3_000),
        second.recordMerchantPayout(
          frozen,
          merchant.target,
          merchant.observation,
          CREATED_AT + 4_000
        ),
      ])
      const combined = await second.loadMerchantSettlement(
        MERCHANT,
        frozen.checkoutId,
        frozen.planDigest
      )
      expect(
        combined && projectCheckoutSparkMerchantSettlement(combined)
      ).toEqual({
        creditVerified: true,
        merchantVerified: true,
        commerceVerified: false,
        feePending: true,
        recipientUnverified: false,
      })
    } finally {
      database.close()
      await database.delete()
    }

    const guardedDatabase = new ConduitDB(
      `settlement-authority-${crypto.randomUUID()}`,
      { indexedDB, IDBKeyRange }
    )
    try {
      const frozen = plan()
      const repository = new DexieCheckoutSparkSettledRepository(
        guardedDatabase
      )
      await repository.create(frozen)
      let current = true
      guardedDatabase.checkoutSparkPlanBindings.hook("updating", () => {
        current = false
      })
      await expect(
        repository.recordMerchantCredit(
          frozen,
          creditProof(),
          CREATED_AT + 3_000,
          () => {
            if (!current) throw new Error("Merchant authority changed")
          }
        )
      ).rejects.toThrow("Merchant authority changed")
      expect(
        await repository.loadMerchantSettlement(
          MERCHANT,
          frozen.checkoutId,
          frozen.planDigest
        )
      ).toBeNull()
    } finally {
      guardedDatabase.close()
      await guardedDatabase.delete()
    }
  })

  it("imports existing intents as history-only without minting local recipient authority", async () => {
    const database = new ConduitDB(`settlement-import-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const frozen = plan()
      const merchant = payout(frozen, "merchant")
      const credited = recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(frozen),
        {
          ...creditProof(),
          paymentHash: frozen.funding.paymentHash,
          observedAt: CREATED_AT + 1_000,
        }
      )
      const prepared = prepareCheckoutSparkSettledLeg(
        credited,
        merchant.target.intent
      )
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.importRecoveryState(prepared, () => undefined)
      expect(await repository.hasInvoiceOrigin(frozen, merchant.target)).toBe(
        false
      )
      await expect(
        repository.assertLocalInvoiceOrigin(frozen, merchant.target)
      ).rejects.toBeInstanceOf(CheckoutSparkInvoiceOriginUnavailableError)
      const paid = await repository.recordMerchantPayout(
        frozen,
        merchant.target,
        merchant.observation,
        CREATED_AT + 3_000
      )
      expect(paid.paidLegs).toHaveLength(1)
      expect(paid.paidLegs[0]!.recipientVerified).toBeUndefined()
      expect(projectCheckoutSparkMerchantSettlement(paid)).toMatchObject({
        merchantVerified: false,
        recipientUnverified: true,
      })
      await repository.importRecoveryState(prepared, () => undefined)
      expect(await repository.hasInvoiceOrigin(frozen, merchant.target)).toBe(
        false
      )
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.invoiceOrigins
      ).toBeUndefined()
    } finally {
      database.close()
      await database.delete()
    }
  })

  it("commits local origin only with the CAS-winning exact intent and rolls back cancellation", async () => {
    const database = new ConduitDB(`settlement-origin-${crypto.randomUUID()}`, {
      indexedDB,
      IDBKeyRange,
    })
    try {
      const frozen = plan()
      const merchant = payout(frozen, "merchant")
      const credited = recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(frozen),
        {
          ...creditProof(),
          paymentHash: frozen.funding.paymentHash,
          observedAt: CREATED_AT + 1_000,
        }
      )
      const prepared = prepareCheckoutSparkSettledLeg(
        credited,
        merchant.target.intent
      )
      const repository = new DexieCheckoutSparkSettledRepository(database)
      await repository.create(frozen)
      const local = await localOrigin(merchant)
      let current = true
      const revoke = () => {
        current = false
      }
      database.checkoutSparkPlanBindings.hook("updating", revoke)
      await expect(
        repository.savePreparedWithInvoiceOrigin(
          prepared,
          1,
          { legId: merchant.target.legId, origin: local.token },
          () => {
            if (!current) throw new Error("Local actor changed")
          }
        )
      ).rejects.toThrow("Local actor changed")
      database.checkoutSparkPlanBindings.hook("updating").unsubscribe(revoke)
      expect(await repository.hasInvoiceOrigin(frozen, merchant.target)).toBe(
        false
      )
      const unchanged = await repository.load(
        frozen.checkoutId,
        frozen.planDigest
      )
      expect(unchanged.status === "active" && unchanged.revision).toBe(1)
      expect(
        unchanged.status === "active" &&
          unchanged.state.legs.every((leg) => leg.intent === null)
      ).toBe(true)
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.invoiceOrigins
      ).toBeUndefined()

      await repository.savePreparedWithInvoiceOrigin(prepared, 1, {
        legId: merchant.target.legId,
        origin: local.token,
      })
      await expect(
        repository.savePreparedWithInvoiceOrigin(prepared, 1, {
          legId: merchant.target.legId,
          origin: local.token,
        })
      ).rejects.toBeInstanceOf(CheckoutSparkSettledRepositoryConflictError)
      expect(await repository.hasInvoiceOrigin(frozen, merchant.target)).toBe(
        true
      )
      await repository.importRecoveryState(prepared, () => undefined)
      expect(await repository.hasInvoiceOrigin(frozen, merchant.target)).toBe(
        true
      )
      const origins = (
        await database.checkoutSparkPlanBindings.get(frozen.checkoutId)
      )?.invoiceOrigins
      expect(origins).toEqual([local.record])
      expect(JSON.stringify(origins)).not.toMatch(
        /paymentRequest|paymentHash|destination|@|lnbc/
      )
    } finally {
      database.close()
      await database.delete()
    }
  })
})
