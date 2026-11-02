import { ConduitDB, db } from "../db"
import { restoreCheckoutSparkMerchantOrderWitness } from "./checkout-spark-merchant-order-witness"
import {
  parseMerchantCheckoutSparkProgressDeliveryRecord,
  type MerchantCheckoutSparkProgressDelivery,
  type MerchantCheckoutSparkProgressDeliveryRecord,
} from "./checkout-spark-merchant-progress-delivery"
import { deriveCheckoutSparkOrganizerRecoveryHandoffId } from "./checkout-spark-organizer-recovery"
import {
  isCheckoutSparkEventMarketPlan,
  restoreCheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"

const HEX_64 = /^[0-9a-f]{64}$/
const MAX_RETAINED_WRAPS = 512

export type StoredMerchantCheckoutSparkProgressDelivery =
  MerchantCheckoutSparkProgressDelivery

function requireRecord(
  value: unknown
): MerchantCheckoutSparkProgressDeliveryRecord {
  const parsed = parseMerchantCheckoutSparkProgressDeliveryRecord(value)
  if (!parsed) {
    throw new Error("Checkout Spark Merchant progress delivery is invalid.")
  }
  return parsed
}

function requireStored(
  value: unknown,
  merchantPubkey: string,
  checkoutId: string,
  planDigest: string
): StoredMerchantCheckoutSparkProgressDelivery {
  if (
    !value ||
    typeof value !== "object" ||
    ![2, 4].includes(Object.keys(value).length) ||
    !Object.keys(value).every((key) =>
      [
        "record",
        "relayAccepted",
        "merchantAccepted",
        "organizerAccepted",
      ].includes(key)
    ) ||
    typeof (value as { relayAccepted?: unknown }).relayAccepted !== "boolean"
  ) {
    throw new Error("Checkout Spark Merchant progress outbox is invalid.")
  }
  const record = requireRecord((value as { record?: unknown }).record)
  if (
    record.merchantPubkey !== merchantPubkey ||
    record.checkoutId !== checkoutId ||
    record.planDigest !== planDigest
  ) {
    throw new Error("Checkout Spark Merchant progress outbox binding changed.")
  }
  const saved = value as StoredMerchantCheckoutSparkProgressDelivery
  if (
    record.schemaVersion === 2
      ? Object.keys(value).length !== 4 ||
        typeof saved.merchantAccepted !== "boolean" ||
        typeof saved.organizerAccepted !== "boolean" ||
        saved.relayAccepted !==
          (saved.merchantAccepted && saved.organizerAccepted)
      : Object.keys(value).length !== 2
  )
    throw new Error(
      "Checkout Spark Merchant progress acknowledgement is invalid."
    )
  return {
    record,
    relayAccepted: (value as { relayAccepted: boolean }).relayAccepted,
    ...(record.schemaVersion === 2
      ? {
          merchantAccepted: saved.merchantAccepted!,
          organizerAccepted: saved.organizerAccepted!,
        }
      : {}),
  }
}

function requireEntries(
  value: unknown,
  merchantPubkey: string,
  checkoutId: string,
  planDigest: string
): StoredMerchantCheckoutSparkProgressDelivery[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_RETAINED_WRAPS) {
    throw new Error("Checkout Spark Merchant progress outbox is invalid.")
  }
  const entries = value.map((entry) =>
    requireStored(entry, merchantPubkey, checkoutId, planDigest)
  )
  if (
    new Set(entries.map((entry) => entry.record.snapshotId)).size !==
    entries.length
  ) {
    throw new Error("Checkout Spark Merchant progress outbox conflicts.")
  }
  return entries
}

function requireKey(
  merchantPubkey: string,
  checkoutId: string,
  planDigest: string,
  snapshotId?: string
): void {
  if (
    !HEX_64.test(merchantPubkey) ||
    !checkoutId ||
    checkoutId.length > 512 ||
    checkoutId.trim() !== checkoutId ||
    !HEX_64.test(planDigest) ||
    (snapshotId !== undefined && !HEX_64.test(snapshotId))
  ) {
    throw new Error("Checkout Spark Merchant progress selection is invalid.")
  }
}

function assertOrganizerDeliveryBinding(
  record: MerchantCheckoutSparkProgressDeliveryRecord,
  state: ReturnType<typeof restoreCheckoutSparkSettledReconciliation>,
  witness: ReturnType<typeof restoreCheckoutSparkMerchantOrderWitness>
): void {
  if (record.schemaVersion !== 2) return
  if (
    !isCheckoutSparkEventMarketPlan(state.plan) ||
    state.plan.eventMarket?.mode !== "organizer_handoff" ||
    witness.schemaVersion !== 2 ||
    !witness.organizerOrderBinding ||
    record.organizerDelivery!.organizerPubkey !==
      state.plan.eventMarket.organizerPubkey ||
    record.organizerDelivery!.initialHandoffId !==
      deriveCheckoutSparkOrganizerRecoveryHandoffId({
        merchantHandoffId: record.initialHandoffId,
        organizerPubkey: state.plan.eventMarket.organizerPubkey,
        orderBinding: witness.organizerOrderBinding,
      })
  )
    throw new Error(
      "Checkout Spark Merchant organizer delivery binding changed."
    )
}

/** Device-local ciphertext outbox. It is never payment or recovery authority. */
export class DexieMerchantCheckoutSparkProgressRepository {
  constructor(private readonly database: ConduitDB = db) {}

  private async readBound(
    merchantPubkey: string,
    checkoutId: string,
    planDigest: string
  ) {
    const binding =
      await this.database.checkoutSparkPlanBindings.get(checkoutId)
    const active =
      await this.database.checkoutSparkReconciliations.get(checkoutId)
    const retired = await this.database.checkoutSparkRetirements.get(checkoutId)
    if (
      !binding ||
      binding.checkoutId !== checkoutId ||
      binding.planDigest !== planDigest ||
      !active ||
      retired ||
      active.checkoutId !== checkoutId ||
      (active.state.schemaVersion !== 3 &&
        active.state.schemaVersion !== 4 &&
        active.state.schemaVersion !== 5 &&
        active.state.schemaVersion !== 6 &&
        active.state.schemaVersion !== 7) ||
      !Number.isSafeInteger(active.revision) ||
      active.revision < 1
    ) {
      throw new Error("Checkout Spark Merchant progress plan is not active.")
    }
    const state = restoreCheckoutSparkSettledReconciliation(active.state)
    if (
      state.plan.checkoutId !== checkoutId ||
      state.plan.planDigest !== planDigest ||
      state.plan.merchantPubkey !== merchantPubkey ||
      !binding.orderWitness
    ) {
      throw new Error("Checkout Spark Merchant progress binding is invalid.")
    }
    const witness = restoreCheckoutSparkMerchantOrderWitness(
      binding.orderWitness,
      state.plan
    )
    if (witness.merchantPubkey !== merchantPubkey) {
      throw new Error("Checkout Spark Merchant progress order is invalid.")
    }
    const entries = requireEntries(
      binding.merchantProgressOutbox,
      merchantPubkey,
      checkoutId,
      planDigest
    )
    for (const entry of entries)
      assertOrganizerDeliveryBinding(entry.record, state, witness)
    return {
      binding,
      state,
      witness,
      entries,
    }
  }

  async loadOrganizerOrderBinding(
    merchantPubkey: string,
    checkoutId: string,
    planDigest: string
  ) {
    requireKey(merchantPubkey, checkoutId, planDigest)
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const { state, witness } = await this.readBound(
          merchantPubkey,
          checkoutId,
          planDigest
        )
        if (
          !isCheckoutSparkEventMarketPlan(state.plan) ||
          state.plan.eventMarket?.mode !== "organizer_handoff"
        )
          return null
        if (witness.schemaVersion !== 2 || !witness.organizerOrderBinding)
          throw new Error(
            "Original Event checkout order must be authenticated again."
          )
        return { ...witness.organizerOrderBinding }
      }
    )
  }

  async load(
    merchantPubkey: string,
    checkoutId: string,
    planDigest: string,
    snapshotId: string
  ): Promise<StoredMerchantCheckoutSparkProgressDelivery | null> {
    requireKey(merchantPubkey, checkoutId, planDigest, snapshotId)
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const { entries } = await this.readBound(
          merchantPubkey,
          checkoutId,
          planDigest
        )
        return (
          entries.find((entry) => entry.record.snapshotId === snapshotId) ??
          null
        )
      }
    )
  }

  async list(
    merchantPubkey: string,
    checkoutId: string,
    planDigest: string
  ): Promise<StoredMerchantCheckoutSparkProgressDelivery[]> {
    requireKey(merchantPubkey, checkoutId, planDigest)
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const { entries } = await this.readBound(
          merchantPubkey,
          checkoutId,
          planDigest
        )
        return entries
      }
    )
  }

  async stage(
    value: MerchantCheckoutSparkProgressDeliveryRecord,
    assertCurrent: () => void
  ): Promise<StoredMerchantCheckoutSparkProgressDelivery> {
    assertCurrent()
    const record = requireRecord(value)
    requireKey(
      record.merchantPubkey,
      record.checkoutId,
      record.planDigest,
      record.snapshotId
    )
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        assertCurrent()
        const { binding, entries, state, witness } = await this.readBound(
          record.merchantPubkey,
          record.checkoutId,
          record.planDigest
        )
        assertCurrent()
        assertOrganizerDeliveryBinding(record, state, witness)
        const previous = entries.find(
          (entry) => entry.record.snapshotId === record.snapshotId
        )
        if (previous) {
          const legacyRecord = { ...record, schemaVersion: 1 as const }
          delete legacyRecord.organizerDelivery
          if (
            previous.record.schemaVersion === 1 &&
            record.schemaVersion === 2 &&
            JSON.stringify(previous.record) === JSON.stringify(legacyRecord)
          ) {
            const upgraded = {
              record,
              relayAccepted: false,
              merchantAccepted: previous.relayAccepted,
              organizerAccepted: false,
            }
            await this.database.checkoutSparkPlanBindings.put({
              ...binding,
              merchantProgressOutbox: entries.map((entry) =>
                entry.record.snapshotId === record.snapshotId ? upgraded : entry
              ),
            })
            assertCurrent()
            return upgraded
          }
          if (JSON.stringify(previous.record) !== JSON.stringify(record)) {
            throw new Error("Checkout Spark Merchant progress wrap conflicts.")
          }
          return previous
        }
        if (entries.length >= MAX_RETAINED_WRAPS) {
          throw new Error("Checkout Spark Merchant progress outbox is full.")
        }
        const stored = {
          record,
          relayAccepted: false,
          ...(record.schemaVersion === 2
            ? { merchantAccepted: false, organizerAccepted: false }
            : {}),
        }
        await this.database.checkoutSparkPlanBindings.put({
          ...binding,
          merchantProgressOutbox: [...entries, stored],
        })
        assertCurrent()
        return stored
      }
    )
  }

  async markAccepted(
    merchantPubkey: string,
    checkoutId: string,
    planDigest: string,
    snapshotId: string,
    assertCurrent: () => void,
    acknowledgements?: {
      merchantAccepted?: boolean
      organizerAccepted?: boolean
    }
  ): Promise<StoredMerchantCheckoutSparkProgressDelivery> {
    assertCurrent()
    requireKey(merchantPubkey, checkoutId, planDigest, snapshotId)
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        assertCurrent()
        const { binding, entries } = await this.readBound(
          merchantPubkey,
          checkoutId,
          planDigest
        )
        assertCurrent()
        const position = entries.findIndex(
          (entry) => entry.record.snapshotId === snapshotId
        )
        if (position < 0) {
          throw new Error("Checkout Spark Merchant progress wrap is missing.")
        }
        const previous = entries[position]!
        if (previous.relayAccepted) return previous
        const accepted =
          previous.record.schemaVersion === 2
            ? {
                ...previous,
                merchantAccepted:
                  previous.merchantAccepted ||
                  acknowledgements?.merchantAccepted === true,
                organizerAccepted:
                  previous.organizerAccepted ||
                  acknowledgements?.organizerAccepted === true,
                relayAccepted:
                  (previous.merchantAccepted ||
                    acknowledgements?.merchantAccepted === true) &&
                  (previous.organizerAccepted ||
                    acknowledgements?.organizerAccepted === true),
              }
            : { ...previous, relayAccepted: true }
        const next = entries.map((entry, index) =>
          index === position ? accepted : entry
        )
        await this.database.checkoutSparkPlanBindings.put({
          ...binding,
          merchantProgressOutbox: next,
        })
        assertCurrent()
        return accepted
      }
    )
  }
}
