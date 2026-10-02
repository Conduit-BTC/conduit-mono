import {
  DexieCheckoutSparkSettledRepository,
  classifyCheckoutSparkSettledExactOutgoingHistory,
  collectCheckoutSparkNativeRetirementEvidence,
  getOrderLifecycle,
  isGuestOrderDataExpired,
  requireCheckoutSparkSettledExactOutgoingRequest,
  type CheckoutSparkBuyerOrderBinding,
  type CheckoutSparkSettledOutgoingTarget,
  type OrderLifecycle,
} from "@conduit/core"
import type { AdvanceCheckoutSparkSettledShopperInput } from "./checkout-spark-settled-shopper-advance"
import { isCurrentGuestOrderSigningIdentity } from "./guest-order-identity"
import { getSparkWalletManager } from "./spark-sdk"
import type { SparkWalletManager } from "./spark-wallet"

export type RetireCheckoutSparkSettledShopperInput = Pick<
  AdvanceCheckoutSparkSettledShopperInput,
  | "checkoutId"
  | "planDigest"
  | "orderId"
  | "merchantPubkey"
  | "network"
  | "buyerPubkey"
  | "currentBuyerPubkey"
  | "guestIdentity"
  | "currentGuestIdentity"
  | "shouldContinue"
>

export type RetireCheckoutSparkSettledShopperResult = {
  status: "retired" | "retirement_pending" | "unavailable"
}

export interface RetireCheckoutSparkSettledShopperDependencies {
  repository?: Pick<
    DexieCheckoutSparkSettledRepository,
    | "load"
    | "loadBuyerSettlement"
    | "assertLocalInvoiceOrigin"
    | "recordMerchantCredit"
    | "recordMerchantPayout"
    | "retire"
  >
  readOrder?: (orderId: string) => Promise<OrderLifecycle | undefined>
  sparkManager?: () => Pick<
    SparkWalletManager,
    | "isOpen"
    | "attestCheckoutReceiveCredit"
    | "reconcileInvoiceAttempt"
    | "openCheckoutRetirementReader"
  > | null
  now?: () => number
}

async function readWithTimeout<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Checkout Spark retirement read timed out.")),
          5_000
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Read-only provider inspection followed by the existing atomic tombstone write. */
export async function retireCheckoutSparkSettledShopper(
  input: RetireCheckoutSparkSettledShopperInput,
  dependencies: RetireCheckoutSparkSettledShopperDependencies = {}
): Promise<RetireCheckoutSparkSettledShopperResult> {
  input = {
    ...input,
    guestIdentity: input.guestIdentity ? { ...input.guestIdentity } : null,
  }
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const readOrder = dependencies.readOrder ?? getOrderLifecycle
  const now = dependencies.now ?? Date.now
  const guest = input.guestIdentity
  const scope = {
    orderId: input.orderId,
    merchantPubkey: input.merchantPubkey,
    pubkey: input.buyerPubkey,
  }
  function assertSession(): void {
    const currentGuest = input.currentGuestIdentity?.() ?? null
    const time = now()
    if (
      !input.shouldContinue() ||
      !Number.isSafeInteger(time) ||
      time < 0 ||
      !/^[0-9a-f]{64}$/.test(input.buyerPubkey) ||
      (guest
        ? !isCurrentGuestOrderSigningIdentity(guest, scope, time) ||
          !isCurrentGuestOrderSigningIdentity(currentGuest, scope, time) ||
          currentGuest.createdAt !== guest.createdAt ||
          currentGuest.expiresAt !== guest.expiresAt
        : input.currentBuyerPubkey() !== input.buyerPubkey)
    )
      throw new Error("Checkout Spark buyer retirement session changed.")
  }
  async function assertOrder(
    binding: CheckoutSparkBuyerOrderBinding
  ): Promise<void> {
    assertSession()
    const order = await readOrder(input.orderId)
    assertSession()
    const router = order?.checkoutSparkRouterBinding
    if (
      !order ||
      order.buyerPubkey !== input.buyerPubkey ||
      order.buyerIdentityKind !== (guest ? "guest_ephemeral" : "signed_in") ||
      (guest &&
        (order.guestSessionExpiresAt !== guest.expiresAt ||
          !Number.isSafeInteger(order.createdAt) ||
          order.createdAt < guest.createdAt ||
          order.createdAt > now() ||
          isGuestOrderDataExpired(order, now()) ||
          order.shippingAddress !== undefined ||
          order.contactNote !== undefined ||
          order.guestContact !== undefined)) ||
      order.orderId !== input.orderId ||
      order.merchantPubkey !== input.merchantPubkey ||
      order.checkoutMode !== "private_checkout" ||
      order.orderDeliveryStatus !== "sent" ||
      order.phase === "cancelled" ||
      order.currency !== "SATS" ||
      order.totalSats !== binding.commerceTotalSats ||
      router?.checkoutId !== input.checkoutId ||
      router.planDigest !== input.planDigest ||
      router.walletId !== binding.walletId ||
      binding.buyerPubkey !== input.buyerPubkey ||
      binding.checkoutId !== input.checkoutId ||
      binding.planDigest !== input.planDigest ||
      binding.orderId !== input.orderId ||
      binding.merchantPubkey !== input.merchantPubkey
    )
      throw new Error("Checkout Spark buyer retirement order changed.")
    // Paid/completed order presentation does not disable safe wallet cleanup.
  }

  try {
    assertSession()
    const buyer = await repository.loadBuyerSettlement(
      input.checkoutId,
      input.planDigest,
      input.buyerPubkey
    )
    assertSession()
    if (buyer.status === "absent" || !buyer.buyerBinding)
      return { status: "unavailable" }
    const binding = buyer.buyerBinding
    await assertOrder(binding)
    // A retained exact tombstone is idempotent even when the wallet is closed.
    if (buyer.status === "retired") return { status: "retired" }
    const snapshot = await repository.load(input.checkoutId, input.planDigest)
    assertSession()
    if (snapshot.status !== "active") return { status: "unavailable" }
    const { state } = snapshot
    const { plan } = state
    if (
      plan.schemaVersion !== 3 ||
      plan.checkoutId !== input.checkoutId ||
      plan.planDigest !== input.planDigest ||
      plan.orderId !== input.orderId ||
      plan.merchantPubkey !== input.merchantPubkey ||
      plan.walletId !== binding.walletId ||
      plan.network !== input.network ||
      plan.commerceQuote.commerceTotalSats !== binding.commerceTotalSats
    )
      return { status: "unavailable" }
    if (
      !state.credit ||
      state.legs.some((leg) => leg.status !== "paid" || !leg.intent)
    ) {
      return { status: "retirement_pending" }
    }
    const manager = (dependencies.sparkManager ?? getSparkWalletManager)()
    if (!manager) return { status: "unavailable" }
    function assertActive(): void {
      assertSession()
      const time = now()
      if (
        time < plan.createdAt ||
        time >= plan.takeoverAt ||
        !manager!.isOpen(plan.walletId)
      ) {
        throw new Error("Checkout Spark buyer retirement authority changed.")
      }
    }
    async function assertAuthority(): Promise<void> {
      assertActive()
      await assertOrder(binding)
      assertActive()
    }
    await assertAuthority()
    const credit = await readWithTimeout(
      manager.attestCheckoutReceiveCredit(plan.walletId, {
        walletId: plan.walletId,
        network: plan.network,
        id: plan.funding.requestId,
        paymentRequest: plan.funding.paymentRequest,
        paymentHash: plan.funding.paymentHash,
        providerStatus: "PERSISTED",
        requiredNetSats: plan.funding.grossFundingSats,
        grossFundingSats: plan.funding.grossFundingSats,
        expirySecs: (plan.funding.expiresAt - plan.funding.createdAt) / 1_000,
        createdAt: plan.funding.createdAt,
        expiresAt: plan.funding.expiresAt,
        receiveSettledPolicy: "ordinary-exact-credit-v3",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      })
    )
    await assertAuthority()
    if (
      !credit ||
      credit.transferId !== state.credit.transferId ||
      credit.creditedSats !== state.credit.creditedSats
    ) {
      return { status: "retirement_pending" }
    }
    await repository.recordMerchantCredit(plan, credit, now(), assertActive)
    await assertAuthority()
    const expectedTransferIds = [credit.transferId]
    for (const leg of state.legs) {
      const recipient = plan.recipients.find(
        (candidate) => candidate.legId === leg.legId
      )
      if (!recipient || !leg.intent || leg.allocationSats === null)
        return { status: "unavailable" }
      const target: CheckoutSparkSettledOutgoingTarget = {
        walletId: plan.walletId,
        network: plan.network,
        legId: leg.legId,
        recipientId: recipient.recipientId,
        allocationSats: leg.allocationSats,
        unpaidAllocationSats: leg.allocationSats,
        intent: leg.intent,
      }
      await repository.assertLocalInvoiceOrigin(plan, target, assertActive)
      await assertAuthority()
      const request = requireCheckoutSparkSettledExactOutgoingRequest(
        plan,
        target
      )
      const history = await readWithTimeout(
        manager.reconcileInvoiceAttempt(plan.walletId, {
          schemaVersion: 1,
          walletId: plan.walletId,
          ...request,
          createdAt: leg.intent.preparedAt,
        })
      )
      await assertAuthority()
      const observation =
        await classifyCheckoutSparkSettledExactOutgoingHistory(target, history)
      await assertAuthority()
      if (
        observation.status !== "paid" ||
        observation.finalFeeSats !== leg.finalFeeSats ||
        observation.finalDebitSats !== leg.finalDebitSats
      ) {
        return { status: "retirement_pending" }
      }
      await repository.recordMerchantPayout(
        plan,
        target,
        observation,
        now(),
        assertActive
      )
      await assertAuthority()
      expectedTransferIds.push(leg.intent.transferId)
    }
    const session = await manager.openCheckoutRetirementReader(plan.walletId, {
      network: plan.network,
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    })
    let evidence: Awaited<
      ReturnType<typeof collectCheckoutSparkNativeRetirementEvidence>
    >
    try {
      await assertAuthority()
      evidence = await collectCheckoutSparkNativeRetirementEvidence({
        authenticatedReader: session.reader,
        sparkAddress: session.sparkAddress,
        walletId: plan.walletId,
        network: plan.network,
        stateUpdatedAt: state.updatedAt,
        expectedTransferIds,
        now,
        assertCurrent: assertActive,
      })
    } finally {
      // Close the inspection handle before any irreversible retirement write.
      await session.cleanup()
    }
    await assertAuthority()
    if (!evidence) return { status: "retirement_pending" }
    await repository.retire({
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      expectedRevision: snapshot.revision,
      evidence,
      assertCurrent: assertActive,
    })
    return { status: "retired" }
  } catch {
    // Missing authority or unconfirmed inspection never permits retirement.
    return { status: "unavailable" }
  }
}
