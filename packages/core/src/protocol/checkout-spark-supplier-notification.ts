import { NDKEvent } from "@nostr-dev-kit/ndk"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  restoreCheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkMerchantSettlementRecord,
} from "./checkout-spark-merchant-settlement"
import {
  deriveCheckoutSparkSettledTransferId,
  deriveCheckoutSparkSettledRenewalTransferId,
  getCheckoutSparkSettledLegGeneration,
  restoreCheckoutSparkSettledPlan,
  restoreCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
  type CheckoutSparkSettledReconciliation,
} from "./checkout-spark-settled-router"
import {
  restoreCheckoutSparkRetiredSettlementSummary,
  validateCheckoutSparkRetiredSettlementRecord,
  type CheckoutSparkRetiredSettlementSummary,
} from "./checkout-spark-retired-settlement"
import {
  buildDirectMessageRumor,
  publishPrivateMessage,
  type PublishPrivateMessageInput,
} from "./messaging"
import { getNdk } from "./ndk"
import type { NostrKeySigner } from "./nostr-event-signer"
import { getAccountSigner } from "./session-signer"
import { waitForVisibleDocument } from "./interactive-signer"
import {
  getProtectedReadAuthorization,
  assertProtectedReadAuthorization,
} from "./protected-read-authorization"
import {
  resolveInboxDeclaration,
  MAX_DECLARED_INBOX_WRITE_RELAYS,
} from "./private-message-routing"
import { normalizeSecureOrIsolatedE2eRelayUrls } from "./relay-settings"
import {
  publishWithPlanner,
  RelayPublishDiagnosticsError,
} from "./relay-publish"
import {
  isValidSignedPublicNostrEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

const HEX_64 = /^[0-9a-f]{64}$/
function invalid(): never {
  throw new Error("Supplier payment notification binding is invalid.")
}

/** Private local attribution. Only amount and an opaque reference enter the DM. */
export interface CheckoutSparkSupplierNotification {
  merchantPubkey: string
  supplierPubkey: string
  checkoutId: string
  planDigest: string
  legId: string
  notificationId: string
  amountSats: number
  createdAt: number
}

export interface CheckoutSparkSupplierNotificationRecord {
  notification: CheckoutSparkSupplierNotification
  rumorId: string
  signedRecipientWrap: SignedPublicNostrEvent
  signedSenderWrap: SignedPublicNostrEvent | null
}

export interface StoredCheckoutSparkSupplierNotification {
  record: CheckoutSparkSupplierNotificationRecord
  recipientAccepted: boolean
  senderAccepted: boolean
}

export interface CheckoutSparkSupplierNotificationStore {
  /** Eligibility was frozen with exact provider/recipient verification. */
  loadIntent(notification: CheckoutSparkSupplierNotification): Promise<boolean>
  load(
    notification: CheckoutSparkSupplierNotification
  ): Promise<StoredCheckoutSparkSupplierNotification | null>
  /** Atomically return the first staged wrap for this semantic notification. */
  stage(
    record: CheckoutSparkSupplierNotificationRecord,
    assertCurrent: () => void,
    plan?: CheckoutSparkSettledPlan
  ): Promise<StoredCheckoutSparkSupplierNotification>
  markAccepted(
    notification: CheckoutSparkSupplierNotification,
    copy: "recipient" | "sender",
    assertCurrent: () => void
  ): Promise<StoredCheckoutSparkSupplierNotification>
}

export type CheckoutSparkSupplierNotificationTransport = Pick<
  PublishPrivateMessageInput,
  | "recipientInboxRelays"
  | "senderInboxRelays"
  | "resolveInboxRelays"
  | "inspectOwnInboxReadiness"
  | "giftWrapFn"
  | "publishFn"
  | "accountNetworkLocalStateRepository"
  | "relayAuthMethod"
  | "waitForSignerVisibility"
>

/** Auth metadata comes from the current external account signer, never a guess. */
export function captureCheckoutSparkSupplierNotificationSession(input: {
  merchantPubkey: string
  assertCurrent: () => void
}) {
  input.assertCurrent()
  const signer = getAccountSigner()
  const authorization = getProtectedReadAuthorization(input.merchantPubkey)
  const relayAuthMethod = signer?.authMethod
  if (
    !signer ||
    !authorization ||
    authorization.signer !== signer ||
    (relayAuthMethod !== "nip07" && relayAuthMethod !== "nip46")
  )
    return null
  return {
    signer,
    transport: { relayAuthMethod },
    shouldContinue: () => {
      input.assertCurrent()
      assertProtectedReadAuthorization(authorization, input.merchantPubkey)
      return getAccountSigner() === signer
    },
  }
}

function notificationId(
  input: Pick<
    CheckoutSparkSupplierNotification,
    "merchantPubkey" | "planDigest" | "legId"
  >
): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          "conduit:supplier-payment-notification:v1",
          input.merchantPubkey,
          input.planDigest,
          input.legId,
        ])
      )
    )
  )
}

/** Buyer claims and unbound provider-paid rows never authorize a notice. */
export type CheckoutSparkSupplierNotificationGenerationBinding =
  CheckoutSparkSettledReconciliation | CheckoutSparkRetiredSettlementSummary

export function getCheckoutSparkSupplierNotifications(
  inputPlan: CheckoutSparkSettledPlan,
  inputSettlement: CheckoutSparkMerchantSettlementRecord,
  generationBinding?: CheckoutSparkSupplierNotificationGenerationBinding
): CheckoutSparkSupplierNotification[] {
  const plan = restoreCheckoutSparkSettledPlan(inputPlan)
  const settlement = restoreCheckoutSparkMerchantSettlementRecord(
    inputSettlement,
    plan
  )
  if (!settlement.credit) return []
  return plan.recipients.flatMap((recipient) => {
    if (recipient.kind !== "supplier") return []
    const paid = settlement.paidLegs.find(
      (leg) => leg.legId === recipient.legId
    )
    if (!paid || paid.recipientVerified !== true) return []
    const originalId = deriveCheckoutSparkSettledTransferId(
      plan,
      recipient.legId
    )
    if (paid.transferId !== originalId) {
      if (!generationBinding) invalid()
      if ("plan" in generationBinding) {
        const state =
          restoreCheckoutSparkSettledReconciliation(generationBinding)
        const leg = state.legs.find((item) => item.legId === recipient.legId)
        if (
          state.plan.planDigest !== plan.planDigest ||
          !leg?.intent ||
          leg.intent.transferId !== paid.transferId ||
          leg.allocationSats !== paid.allocationSats ||
          (paid.transferId !== originalId &&
            getCheckoutSparkSettledLegGeneration(leg) !== 1)
        )
          invalid()
      } else {
        const summary =
          restoreCheckoutSparkRetiredSettlementSummary(generationBinding)
        validateCheckoutSparkRetiredSettlementRecord(summary, settlement)
        const leg = summary.legs.find((item) => item.legId === recipient.legId)
        if (
          summary.planDigest !== plan.planDigest ||
          summary.checkoutId !== plan.checkoutId ||
          summary.merchantPubkey !== plan.merchantPubkey ||
          !leg ||
          leg.transferId !== paid.transferId ||
          (paid.transferId !== originalId && leg.generation !== 1)
        )
          invalid()
      }
      if (
        paid.transferId !== originalId &&
        paid.transferId !==
          deriveCheckoutSparkSettledRenewalTransferId(plan, recipient.legId)
      )
        invalid()
    }
    const notification = {
      merchantPubkey: plan.merchantPubkey,
      supplierPubkey: recipient.recipientId,
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      legId: recipient.legId,
      amountSats: paid.finalDebitSats - paid.finalFeeSats,
      // Stable across provider re-observation and cold Merchant recovery. The
      // notice is attached to the order's time, never an invented settlement time.
      createdAt: Math.floor(plan.createdAt / 1_000),
    }
    return [{ ...notification, notificationId: notificationId(notification) }]
  })
}

export function buildCheckoutSparkSupplierNotificationRumor(
  notification: CheckoutSparkSupplierNotification
): NDKEvent {
  if (
    !notification ||
    Object.keys(notification).length !== 8 ||
    [
      notification.merchantPubkey,
      notification.supplierPubkey,
      notification.planDigest,
      notification.legId,
      notification.notificationId,
    ].some((value) => !HEX_64.test(value)) ||
    notification.merchantPubkey === notification.supplierPubkey ||
    !notification.checkoutId ||
    notification.checkoutId.length > 512 ||
    notification.checkoutId.trim() !== notification.checkoutId ||
    notification.notificationId !== notificationId(notification) ||
    !Number.isSafeInteger(notification.amountSats) ||
    notification.amountSats <= 0 ||
    !Number.isSafeInteger(notification.createdAt) ||
    notification.createdAt < 0
  )
    invalid()
  return buildDirectMessageRumor({
    senderPubkey: notification.merchantPubkey,
    recipientPubkey: notification.supplierPubkey,
    appId: "merchant",
    subject: "Conduit revenue share",
    createdAt: notification.createdAt,
    content: `Your revenue share of ${notification.amountSats} sats has been paid for a Conduit order. Reference: ${notification.notificationId.slice(0, 16)}. Check your wallet for the payment.`,
  })
}

export function restoreCheckoutSparkSupplierNotificationRecord(
  value: CheckoutSparkSupplierNotificationRecord
): CheckoutSparkSupplierNotificationRecord {
  if (!value || Object.keys(value).length !== 4) invalid()
  const rumor = buildCheckoutSparkSupplierNotificationRumor(value.notification)
  if (rumor.id !== value.rumorId) invalid()
  const validWrap = (wrap: SignedPublicNostrEvent, recipient: string) => {
    if (!isValidSignedPublicNostrEvent(wrap) || wrap.kind !== 1059) invalid()
    const tags = wrap.tags.filter((tag) => tag[0] === "p")
    if (
      tags.length !== 1 ||
      tags[0]?.length !== 2 ||
      tags[0]?.[1] !== recipient ||
      wrap.tags.some((tag) => tag[0] === "expiration")
    )
      invalid()
    return { ...wrap, tags: wrap.tags.map((tag) => [...tag]) }
  }
  return {
    notification: { ...value.notification },
    rumorId: value.rumorId,
    signedRecipientWrap: validWrap(
      value.signedRecipientWrap,
      value.notification.supplierPubkey
    ),
    signedSenderWrap:
      value.signedSenderWrap === null
        ? null
        : validWrap(value.signedSenderWrap, value.notification.merchantPubkey),
  }
}

function boundStored(
  value: StoredCheckoutSparkSupplierNotification,
  notification: CheckoutSparkSupplierNotification
): StoredCheckoutSparkSupplierNotification {
  const record = restoreCheckoutSparkSupplierNotificationRecord(value.record)
  if (
    JSON.stringify(record.notification) !== JSON.stringify(notification) ||
    typeof value.recipientAccepted !== "boolean" ||
    typeof value.senderAccepted !== "boolean"
  )
    invalid()
  return {
    record,
    recipientAccepted: value.recipientAccepted,
    senderAccepted: value.senderAccepted,
  }
}

export interface PublishCheckoutSparkSupplierNotificationInput {
  plan: CheckoutSparkSettledPlan
  settlement: CheckoutSparkMerchantSettlementRecord
  generationBinding?: CheckoutSparkSupplierNotificationGenerationBinding
  supplierLegId: string
  signer: NostrKeySigner
  store: CheckoutSparkSupplierNotificationStore
  shouldContinue: () => boolean
  transport?: CheckoutSparkSupplierNotificationTransport
}

class NotificationStaged extends Error {}

/**
 * A messaging-only operation: no wallet/provider/payment callback is accepted.
 * Delivery failure leaves exact ciphertext retryable and never replays payment.
 */
export async function publishCheckoutSparkSupplierPaymentNotification(
  input: PublishCheckoutSparkSupplierNotificationInput
): Promise<"not_eligible" | "pending" | "relay_accepted"> {
  const notification = getCheckoutSparkSupplierNotifications(
    input.plan,
    input.settlement,
    input.generationBinding
  ).find((item) => item.legId === input.supplierLegId)
  if (!notification) return "not_eligible"
  return publishRetainedCheckoutSparkSupplierNotification({
    ...input,
    notification,
  })
}

/** A retained verified intent can be wrapped for the first time after retirement. */
export async function publishRetainedCheckoutSparkSupplierNotification(input: {
  notification: CheckoutSparkSupplierNotification
  signer: NostrKeySigner
  store: CheckoutSparkSupplierNotificationStore
  shouldContinue: () => boolean
  transport?: CheckoutSparkSupplierNotificationTransport
  plan?: CheckoutSparkSettledPlan
}): Promise<"pending" | "relay_accepted"> {
  const notification = input.notification
  buildCheckoutSparkSupplierNotificationRumor(notification)
  const assertCurrent = () => {
    if (input.shouldContinue() !== true)
      throw new Error("Supplier notification session changed.")
  }
  assertCurrent()
  if (
    (await input.signer.getPublicKey()).toLowerCase() !==
    notification.merchantPubkey
  )
    invalid()
  assertCurrent()
  if (!(await input.store.loadIntent(notification))) invalid()
  assertCurrent()
  let stored = await input.store.load(notification)
  assertCurrent()
  if (!stored) {
    try {
      await publishPrivateMessage({
        ...input.transport,
        rumor: buildCheckoutSparkSupplierNotificationRumor(notification),
        senderPubkey: notification.merchantPubkey,
        recipientPubkey: notification.supplierPubkey,
        accountPubkey: notification.merchantPubkey,
        authenticatedPubkey: notification.merchantPubkey,
        signer: input.signer,
        rumorKind: 14,
        selfCopy: true,
        shouldContinue: input.shouldContinue,
        signerInteraction: "external",
        onWrapped: async (prepared) => {
          assertCurrent()
          stored = boundStored(
            await input.store.stage(
              {
                notification,
                rumorId: prepared.rumorId,
                signedRecipientWrap:
                  prepared.wrappedToRecipient.rawEvent() as SignedPublicNostrEvent,
                signedSenderWrap:
                  (prepared.wrappedToSelf?.rawEvent() as SignedPublicNostrEvent) ??
                  null,
              },
              assertCurrent,
              input.plan
            ),
            notification
          )
          assertCurrent()
          // Publish only the winner of the atomic outbox insertion, even when
          // two tabs independently wrapped the same deterministic rumor.
          throw new NotificationStaged()
        },
      })
    } catch (error) {
      if (!(error instanceof NotificationStaged)) throw error
    }
  }
  if (!stored) invalid()
  return retryCheckoutSparkSupplierNotification({
    record: stored.record,
    signer: input.signer,
    store: input.store,
    shouldContinue: input.shouldContinue,
    transport: input.transport,
  })
}

/** Replay only stored exact wraps; also works after the checkout wallet retires. */
export async function retryCheckoutSparkSupplierNotification(input: {
  record: CheckoutSparkSupplierNotificationRecord
  signer: NostrKeySigner
  store: CheckoutSparkSupplierNotificationStore
  shouldContinue: () => boolean
  transport?: CheckoutSparkSupplierNotificationTransport
}): Promise<"pending" | "relay_accepted"> {
  const record = restoreCheckoutSparkSupplierNotificationRecord(input.record)
  const notification = record.notification
  const assertCurrent = () => {
    if (input.shouldContinue() !== true)
      throw new Error("Supplier notification session changed.")
  }
  assertCurrent()
  if (
    (await input.signer.getPublicKey()).toLowerCase() !==
    notification.merchantPubkey
  )
    invalid()
  assertCurrent()
  const loaded = await input.store.load(notification)
  assertCurrent()
  if (!loaded) invalid()
  let stored = boundStored(loaded, notification)
  if (JSON.stringify(stored.record) !== JSON.stringify(record)) invalid()
  for (const copy of ["recipient", "sender"] as const) {
    const wrap =
      copy === "recipient"
        ? record.signedRecipientWrap
        : record.signedSenderWrap
    if (
      !wrap ||
      (copy === "recipient" ? stored.recipientAccepted : stored.senderAccepted)
    )
      continue
    try {
      assertCurrent()
      const recipient =
        copy === "recipient"
          ? notification.supplierPubkey
          : notification.merchantPubkey
      let relays =
        copy === "recipient"
          ? input.transport?.recipientInboxRelays
          : input.transport?.senderInboxRelays
      if (!relays && input.transport?.resolveInboxRelays)
        relays = await input.transport.resolveInboxRelays(recipient)
      if (!relays) {
        const declaration = await resolveInboxDeclaration(recipient, {
          requestingAccountPubkey: notification.merchantPubkey,
          authenticatedPubkey: notification.merchantPubkey,
          accountNetworkLocalStateRepository:
            input.transport?.accountNetworkLocalStateRepository,
          shouldContinue: input.shouldContinue,
        })
        assertCurrent()
        if (declaration.state !== "declared") continue
        relays = declaration.relayUrls
      }
      assertCurrent()
      const targets = normalizeSecureOrIsolatedE2eRelayUrls(relays).slice(
        0,
        MAX_DECLARED_INBOX_WRITE_RELAYS
      )
      if (!targets.length) continue
      let result
      try {
        result = await (input.transport?.publishFn ?? publishWithPlanner)(
          new NDKEvent(getNdk(), wrap),
          {
            intent: "recipient_event",
            authorPubkey: notification.merchantPubkey,
            authenticatedPubkey: notification.merchantPubkey,
            accountPubkey: notification.merchantPubkey,
            recipientPubkeys: [recipient],
            exclusiveRelayUrls: targets,
            independentRelayUrls: targets,
            appRelayUrls: [],
            personalRelayUrls: [],
            accountNetworkLocalStateRepository:
              input.transport?.accountNetworkLocalStateRepository,
            shouldContinue: input.shouldContinue,
            deliveryMode: "critical",
            ...(input.transport?.relayAuthMethod &&
            input.signer.authMethod === input.transport.relayAuthMethod
              ? {
                  relayAuthentication: {
                    expectedPubkey: notification.merchantPubkey,
                    signer: input.signer,
                    sessionScope: input.signer,
                    waitForSignerVisibility:
                      input.transport.waitForSignerVisibility ??
                      ((signal?: AbortSignal) =>
                        waitForVisibleDocument(undefined, signal)),
                  },
                }
              : {}),
          }
        )
      } catch (error) {
        if (!(error instanceof RelayPublishDiagnosticsError)) throw error
        result = error.diagnostics
      }
      assertCurrent()
      if (
        result.successfulRelayUrls.some(
          (url) =>
            targets.includes(url) && result.attemptedRelayUrls.includes(url)
        )
      ) {
        const accepted = boundStored(
          await input.store.markAccepted(notification, copy, assertCurrent),
          notification
        )
        if (JSON.stringify(accepted.record) !== JSON.stringify(record))
          invalid()
        assertCurrent()
        stored = accepted
      }
    } catch {
      // The other copy and the payment workflow remain independent. No private
      // provider, message, invoice, or key data escapes into diagnostics.
      assertCurrent()
    }
  }
  return stored.recipientAccepted ? "relay_accepted" : "pending"
}
