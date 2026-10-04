import { ConduitDB, db } from "../db"
import { restoreCheckoutSparkMerchantOrderWitness } from "./checkout-spark-merchant-order-witness"
import { restoreCheckoutSparkMerchantSettlementRecord } from "./checkout-spark-merchant-settlement"
import {
  restoreCheckoutSparkSettledPlan,
  type CheckoutSparkSettledPlan,
} from "./checkout-spark-settled-router"
import {
  getCheckoutSparkSupplierNotifications,
  buildCheckoutSparkSupplierNotificationRumor,
  restoreCheckoutSparkSupplierNotificationRecord,
  type CheckoutSparkSupplierNotification,
  type CheckoutSparkSupplierNotificationRecord,
  type CheckoutSparkSupplierNotificationStore,
  type StoredCheckoutSparkSupplierNotification,
} from "./checkout-spark-supplier-notification"

function invalid(): never {
  throw new Error("Supplier notification outbox binding is invalid.")
}

/**
 * Account/order-bound ciphertext on the existing durable plan binding. No new
 * table or migration is needed. Retired bindings retain these notification
 * tombstones and any unacknowledged wraps without retaining wallet credentials.
 */
export class DexieCheckoutSparkSupplierNotificationRepository implements CheckoutSparkSupplierNotificationStore {
  constructor(private readonly database: ConduitDB = db) {}

  private async readBound(
    input: Pick<
      CheckoutSparkSupplierNotification,
      "merchantPubkey" | "checkoutId" | "planDigest"
    >
  ) {
    const binding = await this.database.checkoutSparkPlanBindings.get(
      input.checkoutId
    )
    if (
      !binding ||
      binding.planDigest !== input.planDigest ||
      !binding.merchantSettlement
    )
      invalid()
    const settlement = restoreCheckoutSparkMerchantSettlementRecord(
      binding.merchantSettlement
    )
    if (
      settlement.merchantPubkey !== input.merchantPubkey ||
      settlement.checkoutId !== input.checkoutId ||
      settlement.planDigest !== input.planDigest
    )
      invalid()
    const entries = binding.supplierNotificationOutbox ?? []
    if (!Array.isArray(entries) || entries.length > 512) invalid()
    const intents = binding.supplierNotificationIntents ?? []
    if (!Array.isArray(intents) || intents.length > 512) invalid()
    const validateIntent = (
      notification: CheckoutSparkSupplierNotification
    ) => {
      buildCheckoutSparkSupplierNotificationRumor(notification)
      const paid = settlement.paidLegs.find(
        (leg) => leg.legId === notification.legId
      )
      if (
        notification.merchantPubkey !== input.merchantPubkey ||
        notification.checkoutId !== input.checkoutId ||
        notification.planDigest !== input.planDigest ||
        !settlement.credit ||
        !paid?.recipientVerified ||
        paid.finalDebitSats - paid.finalFeeSats !== notification.amountSats
      )
        invalid()
      return { ...notification }
    }
    const restoredIntents = intents.map(validateIntent)
    if (
      new Set(restoredIntents.map((intent) => intent.notificationId)).size !==
      intents.length
    )
      invalid()
    const restored = entries.map((entry) => {
      const record = restoreCheckoutSparkSupplierNotificationRecord(
        entry.record
      )
      if (
        typeof entry.recipientAccepted !== "boolean" ||
        typeof entry.senderAccepted !== "boolean" ||
        record.notification.merchantPubkey !== input.merchantPubkey ||
        record.notification.checkoutId !== input.checkoutId ||
        record.notification.planDigest !== input.planDigest
      )
        invalid()
      if (
        !restoredIntents.some(
          (intent) =>
            JSON.stringify(intent) === JSON.stringify(record.notification)
        )
      )
        invalid()
      const paid = settlement.paidLegs.find(
        (leg) => leg.legId === record.notification.legId
      )
      if (
        !settlement.credit ||
        !paid?.recipientVerified ||
        paid.finalDebitSats - paid.finalFeeSats !==
          record.notification.amountSats
      )
        invalid()
      return {
        record,
        recipientAccepted: entry.recipientAccepted,
        senderAccepted: entry.senderAccepted,
      }
    })
    if (
      new Set(restored.map((entry) => entry.record.notification.notificationId))
        .size !== restored.length
    )
      invalid()
    return { binding, entries: restored, settlement, intents: restoredIntents }
  }

  async loadIntent(
    notification: CheckoutSparkSupplierNotification
  ): Promise<boolean> {
    return (await this.readBound(notification)).intents.some(
      (intent) => JSON.stringify(intent) === JSON.stringify(notification)
    )
  }

  async listIntents(
    merchantPubkey: string,
    checkoutId: string,
    planDigest: string
  ): Promise<CheckoutSparkSupplierNotification[]> {
    return (await this.readBound({ merchantPubkey, checkoutId, planDigest }))
      .intents
  }

  async load(
    notification: CheckoutSparkSupplierNotification
  ): Promise<StoredCheckoutSparkSupplierNotification | null> {
    const { entries } = await this.readBound(notification)
    return (
      entries.find(
        (entry) =>
          entry.record.notification.notificationId ===
          notification.notificationId
      ) ?? null
    )
  }

  async list(
    merchantPubkey: string,
    checkoutId: string,
    planDigest: string
  ): Promise<StoredCheckoutSparkSupplierNotification[]> {
    return (await this.readBound({ merchantPubkey, checkoutId, planDigest }))
      .entries
  }

  async stage(
    input: CheckoutSparkSupplierNotificationRecord,
    assertCurrent: () => void,
    inputPlan?: CheckoutSparkSettledPlan
  ): Promise<StoredCheckoutSparkSupplierNotification> {
    const record = restoreCheckoutSparkSupplierNotificationRecord(input)
    const plan = inputPlan
      ? restoreCheckoutSparkSettledPlan(inputPlan)
      : undefined
    const notification = record.notification
    assertCurrent()
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        assertCurrent()
        const { binding, entries, settlement, intents } =
          await this.readBound(notification)
        assertCurrent()
        if (
          !intents.some(
            (intent) => JSON.stringify(intent) === JSON.stringify(notification)
          )
        )
          invalid()
        const previous = entries.find(
          (entry) =>
            entry.record.notification.notificationId ===
            notification.notificationId
        )
        if (previous) {
          if (
            JSON.stringify(previous.record.notification) !==
            JSON.stringify(notification)
          )
            invalid()
          return previous
        }
        const active = await this.database.checkoutSparkReconciliations.get(
          notification.checkoutId
        )
        const retired = await this.database.checkoutSparkRetirements.get(
          notification.checkoutId
        )
        assertCurrent()
        if (
          (!active && !retired) ||
          (active &&
            active.state.schemaVersion !== 3 &&
            active.state.schemaVersion !== 4 &&
            active.state.schemaVersion !== 5) ||
          !binding.orderWitness ||
          (plan &&
            (plan.planDigest !== binding.planDigest ||
              plan.checkoutId !== binding.checkoutId))
        )
          invalid()
        if (
          retired &&
          binding.retiredSettlementSummary?.planDigest !==
            notification.planDigest
        )
          invalid()
        const witness = restoreCheckoutSparkMerchantOrderWitness(
          binding.orderWitness,
          plan
        )
        if (
          witness.merchantPubkey !== notification.merchantPubkey ||
          witness.checkoutId !== notification.checkoutId ||
          witness.planDigest !== notification.planDigest
        )
          invalid()
        const eligible = plan
          ? getCheckoutSparkSupplierNotifications(
              plan,
              settlement,
              active &&
                (active.state.schemaVersion === 3 ||
                  active.state.schemaVersion === 4 ||
                  active.state.schemaVersion === 5)
                ? active.state
                : binding.retiredSettlementSummary
            ).find(
              (item) => item.notificationId === notification.notificationId
            )
          : notification
        if (
          !eligible ||
          JSON.stringify(eligible) !== JSON.stringify(notification) ||
          entries.length >= 512
        )
          invalid()
        const stored = {
          record,
          recipientAccepted: false,
          senderAccepted: false,
        }
        await this.database.checkoutSparkPlanBindings.put({
          ...binding,
          supplierNotificationOutbox: [...entries, stored],
        })
        assertCurrent()
        return stored
      }
    )
  }

  async markAccepted(
    notification: CheckoutSparkSupplierNotification,
    copy: "recipient" | "sender",
    assertCurrent: () => void
  ): Promise<StoredCheckoutSparkSupplierNotification> {
    assertCurrent()
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      async () => {
        assertCurrent()
        const { binding, entries } = await this.readBound(notification)
        assertCurrent()
        const index = entries.findIndex(
          (entry) =>
            entry.record.notification.notificationId ===
            notification.notificationId
        )
        const previous = entries[index]
        if (
          !previous ||
          JSON.stringify(previous.record.notification) !==
            JSON.stringify(notification)
        )
          invalid()
        const accepted = {
          ...previous,
          [copy === "recipient" ? "recipientAccepted" : "senderAccepted"]: true,
        }
        entries[index] = accepted
        await this.database.checkoutSparkPlanBindings.put({
          ...binding,
          supplierNotificationOutbox: entries,
        })
        assertCurrent()
        return accepted
      }
    )
  }
}
