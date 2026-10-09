import { ConduitDB, db } from "../db"
import { restoreCheckoutSparkMerchantOrderWitness } from "./checkout-spark-merchant-order-witness"
import {
  parseMerchantCheckoutSparkProgressDeliveryRecord,
  type MerchantCheckoutSparkProgressDeliveryRecord,
} from "./checkout-spark-merchant-progress-delivery"
import { restoreCheckoutSparkSettledReconciliation } from "./checkout-spark-settled-router"

const HEX_64 = /^[0-9a-f]{64}$/
const MAX_RETAINED_WRAPS = 512

export interface StoredMerchantCheckoutSparkProgressDelivery {
  record: MerchantCheckoutSparkProgressDeliveryRecord
  relayAccepted: boolean
}

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
    Object.keys(value).length !== 2 ||
    !Object.keys(value).every((key) =>
      ["record", "relayAccepted"].includes(key)
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
  return {
    record,
    relayAccepted: (value as { relayAccepted: boolean }).relayAccepted,
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
        active.state.schemaVersion !== 5) ||
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
    return {
      binding,
      entries: requireEntries(
        binding.merchantProgressOutbox,
        merchantPubkey,
        checkoutId,
        planDigest
      ),
    }
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
        const { binding, entries } = await this.readBound(
          record.merchantPubkey,
          record.checkoutId,
          record.planDigest
        )
        assertCurrent()
        const previous = entries.find(
          (entry) => entry.record.snapshotId === record.snapshotId
        )
        if (previous) {
          if (JSON.stringify(previous.record) !== JSON.stringify(record)) {
            throw new Error("Checkout Spark Merchant progress wrap conflicts.")
          }
          return previous
        }
        if (entries.length >= MAX_RETAINED_WRAPS) {
          throw new Error("Checkout Spark Merchant progress outbox is full.")
        }
        const stored = { record, relayAccepted: false }
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
    assertCurrent: () => void
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
        const accepted = { ...previous, relayAccepted: true }
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
