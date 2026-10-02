import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import { ConduitDB } from "@conduit/core/db"
import {
  DexieCheckoutSparkSettledRepository,
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
  type CheckoutSparkMerchantOrderWitness,
} from "@conduit/core/protocol"
import type { MerchantCheckoutSparkProgressDeliveryRecord } from "../packages/core/src/protocol/checkout-spark-merchant-progress-delivery"
import { DexieMerchantCheckoutSparkProgressRepository } from "../packages/core/src/protocol/checkout-spark-merchant-progress-repository"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { createRuntimeInvalidMnemonic } from "./support/runtime-wallet-fixtures"

const POISON_MNEMONIC = createRuntimeInvalidMnemonic()
const CONFLICT_CIPHERTEXT = crypto.randomUUID()
const SECOND_CIPHERTEXT = crypto.randomUUID()

const CREATED_AT = 1_800_000_000_000
const SECRET = generateSecretKey()
const MERCHANT = getPublicKey(SECRET)
const BUYER = "b".repeat(64)

function plan() {
  const paymentRequest = makeSignedBolt11Fixture({
    hrp: "lnbc11130n",
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(3)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
  return freezeCheckoutSparkSettledPlan({
    checkoutId: "merchant-progress-checkout",
    orderId: "merchant-progress-order",
    merchantPubkey: MERCHANT,
    walletId: "merchant-progress-wallet",
    network: "mainnet",
    createdAt: CREATED_AT,
    takeoverAt: CREATED_AT + 120_000,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:progress-test`,
          productEventId: "c".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "merchant-progress-receive",
      paymentRequest,
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"d".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 3_600_000,
    },
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        weightSats: 1_000,
        destination: {
          type: "lightning_address",
          value: "merchant@example.test",
          source: {
            type: "signed_profile",
            profileEventId: "e".repeat(64),
            profileEventCreatedAt: CREATED_AT / 1_000,
          },
        },
      },
      {
        kind: "conduit",
        recipientId: "conduit-tester@rizful.com",
        weightSats: 111,
        destination: {
          type: "lightning_address",
          value: "conduit-tester@rizful.com",
          source: { type: "conduit_allowlist", policy: "local_router_canary" },
        },
      },
    ],
  })
}

function witness(
  frozen: ReturnType<typeof plan>
): CheckoutSparkMerchantOrderWitness {
  return {
    schemaVersion: 1,
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    orderId: frozen.orderId,
    rumorId: "4".repeat(64),
    contentHash: "5".repeat(64),
    checkoutId: frozen.checkoutId,
    planDigest: frozen.planDigest,
  }
}

function delivery(
  frozen: ReturnType<typeof plan>,
  input: { snapshotId?: string; ciphertext?: string; recordedAt?: number } = {}
): MerchantCheckoutSparkProgressDeliveryRecord {
  const signedRecipientWrap = structuredClone(
    finalizeEvent(
      {
        kind: 1_059,
        created_at: CREATED_AT / 1_000,
        tags: [["p", MERCHANT]],
        content: input.ciphertext ?? "synthetic encrypted recovery progress",
      },
      SECRET
    )
  )
  return {
    schemaVersion: 1,
    merchantPubkey: MERCHANT,
    checkoutId: frozen.checkoutId,
    planDigest: frozen.planDigest,
    snapshotId: input.snapshotId ?? "6".repeat(64),
    initialHandoffId: "7".repeat(64),
    rumorId: "8".repeat(64),
    signedRecipientWrap,
    recordedAt: input.recordedAt ?? CREATED_AT + 130_000,
  }
}

async function harness(importWitness = true) {
  const database = new ConduitDB(`progress-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const frozen = plan()
  const settled = new DexieCheckoutSparkSettledRepository(database)
  if (importWitness) {
    await settled.importMerchantOrderRecovery(
      createCheckoutSparkSettledReconciliation(frozen),
      witness(frozen),
      () => {}
    )
  } else {
    await settled.create(frozen)
  }
  return {
    database,
    frozen,
    repository: new DexieMerchantCheckoutSparkProgressRepository(database),
    close: async () => {
      database.close()
      await database.delete()
    },
  }
}

describe("Merchant Spark ciphertext progress outbox", () => {
  it("stages an exact signed wrap, keeps only ciphertext, and accepts monotonically", async () => {
    const { database, frozen, repository, close } = await harness()
    try {
      const record = delivery(frozen)
      expect(
        await repository.list(MERCHANT, frozen.checkoutId, frozen.planDigest)
      ).toEqual([])
      const staged = await repository.stage(record, () => {})
      expect(staged).toEqual({ record, relayAccepted: false })
      expect(
        await repository.load(
          MERCHANT,
          frozen.checkoutId,
          frozen.planDigest,
          record.snapshotId
        )
      ).toEqual(staged)
      const reloaded = new DexieMerchantCheckoutSparkProgressRepository(
        database
      )
      expect(await reloaded.stage(record, () => {})).toEqual(staged)
      const accepted = await reloaded.markAccepted(
        MERCHANT,
        frozen.checkoutId,
        frozen.planDigest,
        record.snapshotId,
        () => {}
      )
      expect(accepted.relayAccepted).toBe(true)
      expect(await repository.stage(record, () => {})).toEqual(accepted)
      expect(
        await repository.markAccepted(
          MERCHANT,
          frozen.checkoutId,
          frozen.planDigest,
          record.snapshotId,
          () => {}
        )
      ).toEqual(accepted)
      const row = await database.checkoutSparkPlanBindings.get(
        frozen.checkoutId
      )
      expect(row?.merchantProgressOutbox).toEqual([accepted])
      expect(JSON.stringify(row?.merchantProgressOutbox)).not.toContain(
        "merchant@example.test"
      )
      expect(JSON.stringify(row?.merchantProgressOutbox)).not.toContain(
        POISON_MNEMONIC
      )
    } finally {
      await close()
    }
  })

  it("rejects a different wrapper or metadata for one snapshot and isolates accounts", async () => {
    const { frozen, repository, close } = await harness()
    try {
      const record = delivery(frozen)
      await repository.stage(record, () => {})
      await expect(
        repository.stage(
          delivery(frozen, { ciphertext: CONFLICT_CIPHERTEXT }),
          () => {}
        )
      ).rejects.toThrow()
      await expect(
        repository.stage(
          { ...record, recordedAt: record.recordedAt + 1 },
          () => {}
        )
      ).rejects.toThrow()
      await expect(
        repository.load(
          "c".repeat(64),
          frozen.checkoutId,
          frozen.planDigest,
          record.snapshotId
        )
      ).rejects.toThrow()
      await expect(
        repository.list(MERCHANT, frozen.checkoutId, "a".repeat(64))
      ).rejects.toThrow()
      await expect(
        repository.markAccepted(
          MERCHANT,
          frozen.checkoutId,
          frozen.planDigest,
          "9".repeat(64),
          () => {}
        )
      ).rejects.toThrow()
      expect(
        await repository.list(MERCHANT, frozen.checkoutId, frozen.planDigest)
      ).toEqual([{ record, relayAccepted: false }])
    } finally {
      await close()
    }
  })

  it("never stores plaintext attached to an otherwise valid signed wrap", async () => {
    const { database, frozen, repository, close } = await harness()
    try {
      const record = delivery(frozen)
      const staged = await repository.stage(
        {
          ...record,
          signedRecipientWrap: {
            ...record.signedRecipientWrap,
            mnemonic: POISON_MNEMONIC,
          },
        },
        () => {}
      )
      expect(staged.record.signedRecipientWrap).not.toHaveProperty("mnemonic")
      const persisted = await database.checkoutSparkPlanBindings.get(
        frozen.checkoutId
      )
      expect(JSON.stringify(persisted?.merchantProgressOutbox)).not.toContain(
        POISON_MNEMONIC
      )
      expect(persisted?.merchantProgressOutbox?.[0]?.record).toEqual(record)
    } finally {
      await close()
    }
  })

  it("requires active order-bound state and preserves queued ciphertext when active state is unavailable", async () => {
    const noWitness = await harness(false)
    try {
      await expect(
        noWitness.repository.stage(delivery(noWitness.frozen), () => {})
      ).rejects.toThrow()
    } finally {
      await noWitness.close()
    }
    const { database, frozen, repository, close } = await harness()
    try {
      const record = delivery(frozen)
      await repository.stage(record, () => {})
      await database.checkoutSparkReconciliations.delete(frozen.checkoutId)
      await expect(
        repository.stage(
          delivery(frozen, { snapshotId: "9".repeat(64) }),
          () => {}
        )
      ).rejects.toThrow()
      await expect(
        repository.list(MERCHANT, frozen.checkoutId, frozen.planDigest)
      ).rejects.toThrow()
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.merchantProgressOutbox
      ).toEqual([{ record, relayAccepted: false }])
    } finally {
      await close()
    }
  })

  it("rolls back a staged wrap when authority expires during the write", async () => {
    const { database, frozen, repository, close } = await harness()
    try {
      let current = true
      database.checkoutSparkPlanBindings.hook("updating", () => {
        current = false
      })
      await expect(
        repository.stage(delivery(frozen), () => {
          if (!current) throw new Error("session switched")
        })
      ).rejects.toThrow("session switched")
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.merchantProgressOutbox
      ).toBeUndefined()
    } finally {
      await close()
    }
  })

  it("merges independent clients without losing an unresolved signed wrap", async () => {
    const { database, frozen, repository, close } = await harness()
    try {
      const second = new DexieMerchantCheckoutSparkProgressRepository(database)
      const firstRecord = delivery(frozen)
      const secondRecord = delivery(frozen, {
        snapshotId: "9".repeat(64),
        ciphertext: SECOND_CIPHERTEXT,
      })
      await Promise.all([
        repository.stage(firstRecord, () => {}),
        second.stage(secondRecord, () => {}),
      ])
      expect(
        (await repository.list(MERCHANT, frozen.checkoutId, frozen.planDigest))
          .map((entry) => entry.record.snapshotId)
          .sort()
      ).toEqual([firstRecord.snapshotId, secondRecord.snapshotId].sort())
    } finally {
      await close()
    }
  })

  it("purges wraps only with successful terminal retirement and keeps its order witness", async () => {
    const { database, frozen, repository, close } = await harness()
    try {
      const record = delivery(frozen)
      await repository.stage(record, () => {})
      const settled = new DexieCheckoutSparkSettledRepository(database)
      await expect(
        settled.retire({
          checkoutId: frozen.checkoutId,
          planDigest: frozen.planDigest,
          expectedRevision: 1,
          evidence: {
            walletId: frozen.walletId,
            network: frozen.network,
            observedAt: CREATED_AT + 131_000,
            availableSats: 0,
            ownedSats: 0,
            incomingSats: 0,
            fundingReceiveTerminal: true,
            sendHistoryTerminal: true,
            claimsTerminal: true,
            refundsTerminal: true,
          },
        })
      ).rejects.toThrow()
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.merchantProgressOutbox
      ).toEqual([{ record, relayAccepted: false }])

      let state = recordCheckoutSparkSettledCredit(
        createCheckoutSparkSettledReconciliation(frozen),
        {
          requestId: frozen.funding.requestId,
          paymentHash: frozen.funding.paymentHash,
          transferId: "exact-merchant-progress-funding",
          receiverIdentityPublicKey: frozen.funding.receiverIdentityPublicKey,
          grossSats: frozen.funding.grossFundingSats,
          creditedSats: frozen.funding.grossFundingSats,
          observedAt: CREATED_AT + 1_000,
        }
      )
      for (const [index, leg] of state.legs.entries()) {
        const allocationSats = leg.allocationSats!
        const amountSats = allocationSats - 1
        const paymentRequest = makeSignedBolt11Fixture({
          hrp: `lnbc${amountSats * 10}n`,
          createdAt: CREATED_AT / 1_000,
          fields: [
            bolt11PaymentHashField(new Uint8Array(32).fill(index + 10)),
            bolt11PaymentSecretField(),
            bolt11PlainDescriptionField(),
          ],
        })
        const transferId = deriveCheckoutSparkSettledTransferId(
          frozen,
          leg.legId
        )
        const paymentHash = (index + 10)
          .toString(16)
          .padStart(2, "0")
          .repeat(32)
        state = prepareCheckoutSparkSettledLeg(state, {
          legId: leg.legId,
          transferId,
          paymentRequest,
          paymentHash,
          invoiceAmountSats: amountSats,
          maxFeeSats: 1,
          preparedAt: CREATED_AT + 2_000 + index,
        })
        state = recordCheckoutSparkSettledLegStatus(state, {
          legId: leg.legId,
          transferId,
          paymentHash,
          status: "paid",
          finalFeeSats: 1,
          finalDebitSats: allocationSats,
          observedAt: CREATED_AT + 3_000 + index,
        })
      }
      const saved = await settled.save(state, 1)
      if (saved.status !== "active") throw new Error("Expected active checkout")
      expect(
        (await database.checkoutSparkPlanBindings.get(frozen.checkoutId))
          ?.merchantProgressOutbox
      ).toEqual([{ record, relayAccepted: false }])
      await settled.retire({
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
      const binding = await database.checkoutSparkPlanBindings.get(
        frozen.checkoutId
      )
      expect(binding?.merchantProgressOutbox).toBeUndefined()
      expect(binding?.orderWitness).toEqual(witness(frozen))
      expect(binding?.retiredSettlementSummary?.planDigest).toBe(
        frozen.planDigest
      )
      expect(
        (await settled.load(frozen.checkoutId, frozen.planDigest)).status
      ).toBe("retired")
    } finally {
      await close()
    }
  })
})
