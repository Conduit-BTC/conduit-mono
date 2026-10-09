import { describe, expect, it } from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import type { NDKSigner } from "@nostr-dev-kit/ndk"
import { ConduitDB } from "@conduit/core/db"
import {
  DexieCheckoutSparkSettledRepository,
  deriveCheckoutSparkNativeTreasuryInvoiceId,
  prepareCheckoutSparkNativeTreasury,
  projectCheckoutSparkMerchantSettlement,
  type CheckoutSparkMerchantSettlementRecord,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingTarget,
} from "@conduit/core"

import {
  createCheckoutSparkSettledReconciliation,
  deriveCheckoutSparkSettledTransferId,
  freezeCheckoutSparkSettledPlan,
  freezeCheckoutSparkSettledTreasuryPlan,
  prepareCheckoutSparkSettledLeg,
  recordCheckoutSparkSettledCredit,
  recordCheckoutSparkSettledLegStatus,
} from "../packages/core/src/protocol/checkout-spark-settled-router"
import { CONDUIT_CHECKOUT_FEE_RECIPIENT } from "../packages/core/src/protocol/checkout-spark-router-obligations"
import type { OrderLifecycle } from "../packages/core/src/db"
import {
  assessCheckoutSparkSettledOrderControl,
  readCurrentCheckoutSparkSettledOrderControl,
  matchesCheckoutSparkSettledOrderControl,
} from "../apps/market/src/lib/checkout-spark-settled-order-control"
import { advanceCheckoutSparkSettledShopper } from "../apps/market/src/lib/checkout-spark-settled-shopper-advance"
import {
  GUEST_ORDER_SESSION_TTL_MS,
  type GuestOrderSigningIdentity,
} from "../apps/market/src/lib/guest-order-identity"
import type {
  AdvanceCheckoutSparkSettledShopperDependencies,
  AdvanceCheckoutSparkSettledShopperInput,
} from "../apps/market/src/lib/checkout-spark-settled-shopper-advance"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"

const NOW = 1_800_000_000_000
const BUYER = "a".repeat(64)
const MERCHANT = "b".repeat(64)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function guestIdentity(): GuestOrderSigningIdentity {
  return {
    kind: "guest_ephemeral",
    orderId: "order-1",
    merchantPubkey: MERCHANT,
    pubkey: BUYER,
    createdAt: NOW,
    expiresAt: NOW + GUEST_ORDER_SESSION_TTL_MS,
    signer: { pubkey: BUYER } as NDKSigner,
  }
}

function invoice(
  amountSats: number,
  byte: number,
  createdAt = NOW / 1_000
): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(byte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function fixture(takeoverAt = NOW + 60_000) {
  const plan = freezeCheckoutSparkSettledPlan({
    checkoutId: "checkout-1",
    orderId: "order-1",
    merchantPubkey: MERCHANT,
    walletId: "wallet-1",
    network: "mainnet",
    createdAt: NOW,
    takeoverAt,
    commerceQuote: {
      commerceTotalSats: 1_000,
      lines: [
        {
          productCoordinate: `30402:${MERCHANT}:item`,
          productEventId: "c".repeat(64),
          merchantPubkey: MERCHANT,
          quantity: 1,
          unitMerchandiseSats: 1_000,
          unitShippingSats: 0,
        },
      ],
    },
    funding: {
      requestId: "receive-1",
      paymentRequest: invoice(1_113, 3),
      paymentHash: "03".repeat(32),
      receiverIdentityPublicKey: `02${"c".repeat(64)}`,
      grossFundingSats: 1_113,
      createdAt: NOW,
      expiresAt: NOW + 3_600_000,
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
  const lifecycle = {
    orderId: plan.orderId,
    merchantPubkey: MERCHANT,
    buyerPubkey: BUYER,
    buyerIdentityKind: "signed_in",
    orderDeliveryStatus: "sent",
    phase: "placed",
    paymentStatus: "unpaid",
    currency: "SATS",
    totalSats: 1_000,
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId: plan.walletId,
    },
  } as OrderLifecycle
  const preparation = {
    schemaVersion: 3 as const,
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    recoveryHandoffId: "handoff-1",
    fundingInvoiceExposedAt: NOW + 1,
    fundingSubmissionState: "not_started" as const,
    savedAt: NOW + 1,
  }
  const state = createCheckoutSparkSettledReconciliation(plan)
  const input = {
    lifecycle,
    preparation,
    snapshot: { status: "active" as const, revision: 1, state },
    buyerPubkey: BUYER,
    initialRecoverySenderPubkey: BUYER,
    initialRecoveryAcked: true,
    now: NOW + 2,
    routerWalletOpen: true,
  }
  return { plan, input }
}

function nativeFixture(takeoverAt = NOW + 60_000) {
  const ordinary = fixture(takeoverAt)
  const nativeTreasuryIdentity = `03${"e".repeat(64)}`
  const nativeTreasuryBase = {
    schemaVersion: 1 as const,
    sparkAddress: "spark-treasury.fixture",
    receiverIdentityPublicKey: nativeTreasuryIdentity,
    senderIdentityPublicKey: ordinary.plan.funding.receiverIdentityPublicKey,
    invoiceRequest: "spark-invoice.fixture",
    feePolicy: "zero_required" as const,
    residualPolicy: "unused_commerce_reserves" as const,
  }
  const plan = freezeCheckoutSparkSettledTreasuryPlan({
    checkoutId: ordinary.plan.checkoutId,
    orderId: ordinary.plan.orderId,
    merchantPubkey: ordinary.plan.merchantPubkey,
    walletId: ordinary.plan.walletId,
    network: ordinary.plan.network,
    createdAt: ordinary.plan.createdAt,
    takeoverAt: ordinary.plan.takeoverAt,
    commerceQuote: ordinary.plan.commerceQuote,
    funding: ordinary.plan.funding,
    recipients: ordinary.plan.recipients.map((recipient) => ({
      kind: recipient.kind,
      recipientId: recipient.recipientId,
      destination: recipient.destination,
      weightSats: recipient.weightSats,
    })),
    nativeTreasury: {
      ...nativeTreasuryBase,
      invoiceId: deriveCheckoutSparkNativeTreasuryInvoiceId({
        checkoutId: ordinary.plan.checkoutId,
        orderId: ordinary.plan.orderId,
        walletId: ordinary.plan.walletId,
        network: ordinary.plan.network,
        createdAt: ordinary.plan.createdAt,
        sparkAddress: nativeTreasuryBase.sparkAddress,
        receiverIdentityPublicKey: nativeTreasuryIdentity,
        senderIdentityPublicKey:
          ordinary.plan.funding.receiverIdentityPublicKey,
      }),
    },
  })
  const lifecycle = {
    ...ordinary.input.lifecycle,
    checkoutSparkRouterBinding: {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      walletId: plan.walletId,
    },
  }
  const preparation = {
    ...ordinary.input.preparation,
    planDigest: plan.planDigest,
  }
  const state = createCheckoutSparkSettledReconciliation(plan)
  return {
    plan,
    input: {
      ...ordinary.input,
      lifecycle,
      preparation,
      snapshot: { status: "active" as const, revision: 1, state },
    },
  }
}

describe("current saved checkout presentation reads", () => {
  it("reads the bound order without granting or requiring execution", async () => {
    const { input } = fixture()
    expect(
      await readCurrentCheckoutSparkSettledOrderControl({
        read: async () => input,
        isCurrent: () => true,
      })
    ).toEqual(assessCheckoutSparkSettledOrderControl(input))
  })

  it.each(["identity", "order", "abort"] as const)(
    "rejects a late local read after %s revocation",
    async (revocation) => {
      const { input } = fixture()
      const waiting = deferred()
      const abort = new AbortController()
      let current = true
      let selectedOrderId = input.lifecycle.orderId
      const originalOrderId = selectedOrderId
      const pending = readCurrentCheckoutSparkSettledOrderControl({
        read: async () => {
          await waiting.promise
          return input
        },
        isCurrent: () => current && selectedOrderId === originalOrderId,
        signal: abort.signal,
      })
      void pending.catch(() => undefined)
      if (revocation === "identity") current = false
      else if (revocation === "order") selectedOrderId = "different-order"
      else abort.abort()
      waiting.resolve()
      await expect(pending).rejects.toThrow("read cancelled")
    }
  )
})

describe("funding availability is independent of buyer payout takeover", () => {
  it("keeps exact funding available after takeover only while the original wallet remains open", () => {
    const { input } = fixture(NOW + 120_000)
    const late = { ...input, now: NOW + 180_000 }
    expect(assessCheckoutSparkSettledOrderControl(late)).toMatchObject({
      status: "pay_funding",
      externalFundingAvailable: true,
    })
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...late,
        routerWalletOpen: false,
      }).status
    ).toBe("blocked")
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...late,
        initialRecoveryAcked: false,
      }).status
    ).toBe("blocked")
  })
  it("offers only exact saved possible-send inspection after takeover, never preparation or dispatch", () => {
    const { plan, input } = fixture(NOW + 120_000)
    const credited = recordCheckoutSparkSettledCredit(input.snapshot.state, {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: NOW + 2,
    })
    const legId = plan.recipients[0]!.legId
    const prepared = prepareCheckoutSparkSettledLeg(credited, {
      legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
      paymentRequest: invoice(995, 4),
      paymentHash: "04".repeat(32),
      invoiceAmountSats: 995,
      maxFeeSats: 5,
      preparedAt: NOW + 3,
    })
    const assess = (state: typeof prepared) =>
      assessCheckoutSparkSettledOrderControl({
        ...input,
        now: plan.takeoverAt,
        snapshot: { ...input.snapshot, state },
      })
    expect(assess(credited).status).toBe("blocked")
    expect(assess(prepared).status).toBe("blocked")
    for (const status of [
      "submitted",
      "ambiguous",
      "lookup_unavailable",
    ] as const) {
      const possible = recordCheckoutSparkSettledLegStatus(prepared, {
        legId,
        transferId: prepared.legs[0]!.intent!.transferId,
        paymentHash: "04".repeat(32),
        status,
        observedAt: NOW + 4,
      })
      expect(assess(possible)).toMatchObject({ status: "check_payout", legId })
    }
    for (const status of [
      "terminal_failure",
      "conflicting_evidence",
    ] as const) {
      expect(
        assess(
          recordCheckoutSparkSettledLegStatus(prepared, {
            legId,
            transferId: prepared.legs[0]!.intent!.transferId,
            paymentHash: "04".repeat(32),
            status,
            observedAt: NOW + 4,
          })
        ).status
      ).toBe("blocked")
    }
  })
})

function preparedNativeFixture() {
  const { plan, input } = nativeFixture()
  let state = recordCheckoutSparkSettledCredit(input.snapshot.state, {
    requestId: plan.funding.requestId,
    paymentHash: plan.funding.paymentHash,
    transferId: "native-funding-transfer",
    receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
    grossSats: 1_113,
    creditedSats: 1_111,
    observedAt: NOW + 2,
  })
  const merchant = plan.recipients.find(
    (recipient) => recipient.kind === "merchant"
  )!
  const transferId = deriveCheckoutSparkSettledTransferId(plan, merchant.legId)
  state = prepareCheckoutSparkSettledLeg(state, {
    legId: merchant.legId,
    transferId,
    paymentRequest: invoice(995, 4),
    paymentHash: "04".repeat(32),
    invoiceAmountSats: 995,
    maxFeeSats: 5,
    preparedAt: NOW + 3,
  })
  state = recordCheckoutSparkSettledLegStatus(state, {
    legId: merchant.legId,
    transferId,
    paymentHash: "04".repeat(32),
    status: "paid",
    finalFeeSats: 1,
    finalDebitSats: 996,
    observedAt: NOW + 4,
  })
  const settlement = {
    schemaVersion: 2 as const,
    nativeTreasury: null,
    merchantPubkey: plan.merchantPubkey,
    orderId: plan.orderId,
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    merchantLegId: merchant.legId,
    requiredCommerceLegIds: [merchant.legId],
    feeLegId: plan.recipients.find((recipient) => recipient.kind === "conduit")!
      .legId,
    credit: {
      transferId: state.credit!.transferId,
      creditedSats: state.credit!.creditedSats,
      observedAt: state.credit!.observedAt,
    },
    paidLegs: [
      {
        legId: merchant.legId,
        transferId,
        allocationSats: state.legs[0]!.allocationSats!,
        finalDebitSats: 996,
        finalFeeSats: 1,
        observedAt: NOW + 4,
        recipientVerified: true as const,
      },
    ],
  } satisfies CheckoutSparkMerchantSettlementRecord
  const commercePaidState = state
  state = prepareCheckoutSparkNativeTreasury(state, {
    settlement,
    preparedAt: NOW + 5,
  })
  return {
    plan,
    input: {
      ...input,
      lifecycle: {
        ...input.lifecycle,
        paymentStatus: "paid" as const,
      },
      now: NOW + 6,
      snapshot: { ...input.snapshot, state },
    },
    commercePaidInput: {
      ...input,
      lifecycle: {
        ...input.lifecycle,
        paymentStatus: "paid" as const,
      },
      now: NOW + 5,
      snapshot: { ...input.snapshot, state: commercePaidState },
    },
  }
}

function externalFundingActionFixture() {
  const { plan, input } = fixture()
  const authority = {
    buyer: BUYER,
    active: true,
    now: NOW + 2,
    lifecycle: input.lifecycle,
    acknowledged: true,
  }
  const calls = { funding: 0, beforeSend: 0, disclosures: 0, payouts: 0 }
  const hooks: {
    beforeDisclosure?: () => Promise<void>
    beforeReturn?: () => Promise<void>
    beforeSend?: () => Promise<void>
  } = {}
  const received: Array<
    AdvanceCheckoutSparkSettledShopperInput["fundingPayment"]
  > = []
  const externalInvoice = Object.freeze({
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    orderId: plan.orderId,
    buyerPubkey: BUYER,
    invoice: plan.funding.paymentRequest,
    amountSats: plan.funding.grossFundingSats,
    expiresAt: plan.funding.expiresAt,
    takeoverAt: plan.takeoverAt,
    exposedAt: NOW + 2,
  })
  const action = {
    checkoutId: plan.checkoutId,
    planDigest: plan.planDigest,
    orderId: plan.orderId,
    merchantPubkey: plan.merchantPubkey,
    network: plan.network,
    buyerPubkey: BUYER,
    currentBuyerPubkey: () => authority.buyer,
    shouldContinue: () => authority.active,
    legId: null,
    fundingPayment: {
      buyerPubkey: BUYER,
      shouldContinue: () => authority.active,
      paymentTarget: { type: "manual" as const },
      exposeExternalInvoice: true,
      inspectionOnly: false,
      timeoutMs: 60_000,
      appId: "market" as const,
      beforeSend: async () => {
        calls.beforeSend += 1
        await hooks.beforeSend?.()
      },
    },
    acknowledgeRecoverySnapshot: async () => {
      throw new Error("external funding must not prepare a payout")
    },
  } satisfies AdvanceCheckoutSparkSettledShopperInput
  const dependencies = {
    readOrder: async () => authority.lifecycle,
    readPreparation: () => input.preparation,
    readInitialRecovery: () =>
      ({
        record: { senderPubkey: BUYER },
        deliveryProgress: {
          acknowledgedRelayRefs: authority.acknowledged ? ["relay"] : [],
        },
      }) as ReturnType<
        NonNullable<
          AdvanceCheckoutSparkSettledShopperDependencies["readInitialRecovery"]
        >
      >,
    loadAuthorized: async () =>
      ({
        plan,
        state: input.snapshot.state,
        recoveryHandoffId: input.preparation.recoveryHandoffId,
      }) as Awaited<
        ReturnType<
          NonNullable<
            AdvanceCheckoutSparkSettledShopperDependencies["loadAuthorized"]
          >
        >
      >,
    repository: {
      async load() {
        return input.snapshot
      },
    } as AdvanceCheckoutSparkSettledShopperDependencies["repository"],
    sparkConfiguration: () =>
      ({ status: "ready", network: "mainnet" }) as ReturnType<
        NonNullable<
          AdvanceCheckoutSparkSettledShopperDependencies["sparkConfiguration"]
        >
      >,
    sparkManager: () =>
      ({ isOpen: () => true }) as ReturnType<
        NonNullable<
          AdvanceCheckoutSparkSettledShopperDependencies["sparkManager"]
        >
      >,
    fundingBridge: () =>
      ({
        async fund(payment) {
          calls.funding += 1
          received.push(payment)
          await hooks.beforeDisclosure?.()
          await payment.beforeSend?.()
          calls.disclosures += 1
          await hooks.beforeReturn?.()
          return {
            status: "external_ready",
            externalInvoice,
            reconciliation: input.snapshot.state,
          }
        },
      }) as ReturnType<
        NonNullable<
          AdvanceCheckoutSparkSettledShopperDependencies["fundingBridge"]
        >
      >,
    outgoingStep: async () => {
      calls.payouts += 1
      throw new Error("external funding must not send a payout")
    },
    now: () => authority.now,
  } satisfies AdvanceCheckoutSparkSettledShopperDependencies
  return {
    plan,
    action,
    dependencies,
    authority,
    calls,
    hooks,
    received,
    externalInvoice,
  }
}

function guestFundingActionFixture() {
  const harness = externalFundingActionFixture()
  const identity = guestIdentity()
  const session: { current: GuestOrderSigningIdentity | null } = {
    current: identity,
  }
  harness.authority.lifecycle.buyerIdentityKind = "guest_ephemeral"
  harness.authority.lifecycle.guestSessionExpiresAt = identity.expiresAt
  const action: AdvanceCheckoutSparkSettledShopperInput = {
    ...harness.action,
    guestIdentity: identity,
    currentGuestIdentity: () => session.current,
    currentBuyerPubkey: () => null,
  }
  return { ...harness, action, identity, session }
}

describe("settled Spark guest buyer authority", () => {
  it("offers funding only for the exact active guest session, without account authority", () => {
    const { input } = fixture()
    input.lifecycle.buyerIdentityKind = "guest_ephemeral"
    const guest = guestIdentity()
    input.lifecycle.guestSessionExpiresAt = guest.expiresAt
    expect(
      assessCheckoutSparkSettledOrderControl({ ...input, guestIdentity: guest })
        .status
    ).toBe("pay_funding")
    for (const candidate of [
      null,
      { ...guest, orderId: "other-order" },
      { ...guest, merchantPubkey: BUYER },
      { ...guest, pubkey: MERCHANT },
      { ...guest, createdAt: NOW + 3 },
      { ...guest, expiresAt: NOW + 1 },
      { ...guest, signer: { pubkey: MERCHANT } as NDKSigner },
    ]) {
      expect(
        assessCheckoutSparkSettledOrderControl({
          ...input,
          guestIdentity: candidate,
        }).status
      ).toBe("blocked")
    }
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...input,
        guestIdentity: guest,
        initialRecoverySenderPubkey: MERCHANT,
      }).status
    ).toBe("blocked")
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...input,
        guestIdentity: guest,
        now: guest.expiresAt,
      }).status
    ).toBe("blocked")
    for (const guestSessionExpiresAt of [undefined, guest.expiresAt + 1]) {
      expect(
        assessCheckoutSparkSettledOrderControl({
          ...input,
          lifecycle: { ...input.lifecycle, guestSessionExpiresAt },
          guestIdentity: guest,
        }).status
      ).toBe("blocked")
    }
  })

  it("permits external funding for a same-key restored guest and keeps funding isolated from payouts", async () => {
    const harness = guestFundingActionFixture()
    harness.session.current = {
      ...harness.identity,
      signer: { pubkey: BUYER } as NDKSigner,
    }
    const result = await advanceCheckoutSparkSettledShopper(
      harness.action,
      harness.dependencies
    )
    expect(result.status).toBe("funding")
    expect(harness.calls.disclosures).toBe(1)
    expect(harness.calls.payouts).toBe(0)
    expect(harness.received[0]?.buyerPubkey).toBe(BUYER)
    expect(harness.received[0]?.shouldContinue()).toBe(true)
    harness.session.current = null
    expect(harness.received[0]?.shouldContinue()).toBe(false)
  })

  it.each([
    "missing_callback",
    "missing_session",
    "wrong_key",
    "wrong_order",
    "wrong_merchant",
    "renewed_lifetime",
    "expired",
  ] as const)("rejects %s before funding or wallet access", async (change) => {
    const harness = guestFundingActionFixture()
    let managerReads = 0
    if (change === "missing_callback")
      harness.action.currentGuestIdentity = undefined
    else if (change === "missing_session") harness.session.current = null
    else if (change === "wrong_key")
      harness.session.current = {
        ...harness.identity,
        pubkey: MERCHANT,
        signer: { pubkey: MERCHANT } as NDKSigner,
      }
    else if (change === "wrong_order")
      harness.session.current = { ...harness.identity, orderId: "other-order" }
    else if (change === "wrong_merchant")
      harness.session.current = { ...harness.identity, merchantPubkey: BUYER }
    else if (change === "renewed_lifetime")
      harness.session.current = {
        ...harness.identity,
        createdAt: NOW + 1,
        expiresAt: harness.identity.expiresAt + 1,
      }
    else harness.authority.now = harness.identity.expiresAt
    await expect(
      advanceCheckoutSparkSettledShopper(harness.action, {
        ...harness.dependencies,
        sparkManager: () => {
          managerReads += 1
          return harness.dependencies.sparkManager()
        },
      })
    ).rejects.toThrow("shopper session changed")
    expect(managerReads).toBe(0)
    expect(harness.calls.funding).toBe(0)
  })

  it.each(["beforeDisclosure", "beforeReturn", "beforeSend"] as const)(
    "rejects guest session removal during %s, without another funding attempt",
    async (stage) => {
      const harness = guestFundingActionFixture()
      harness.hooks[stage] = async () => {
        harness.session.current = null
      }
      await expect(
        advanceCheckoutSparkSettledShopper(harness.action, harness.dependencies)
      ).rejects.toThrow("shopper session changed")
      expect(harness.calls.funding).toBe(1)
      expect(harness.calls.disclosures).toBe(stage === "beforeReturn" ? 1 : 0)
      expect(harness.calls.payouts).toBe(0)
    }
  )

  it.each(["load_authorized", "read_order", "load_snapshot"] as const)(
    "rechecks the current guest registry after %s before entering the funding bridge",
    async (stage) => {
      const harness = guestFundingActionFixture()
      const dependencies: AdvanceCheckoutSparkSettledShopperDependencies = {
        ...harness.dependencies,
      }
      if (stage === "load_authorized")
        dependencies.loadAuthorized = async () => {
          const value = await harness.dependencies.loadAuthorized()
          harness.session.current = null
          return value
        }
      else if (stage === "read_order")
        dependencies.readOrder = async () => {
          const value = await harness.dependencies.readOrder()
          harness.session.current = null
          return value
        }
      else
        dependencies.repository = {
          ...harness.dependencies.repository!,
          load: async () => {
            const value = await harness.dependencies.repository!.load(
              harness.plan.checkoutId,
              harness.plan.planDigest
            )
            harness.session.current = null
            return value
          },
        }
      await expect(
        advanceCheckoutSparkSettledShopper(harness.action, dependencies)
      ).rejects.toThrow("shopper session changed")
      expect(harness.calls.funding).toBe(0)
    }
  )

  it("does not accept a guest lifecycle using only a buyer pubkey or another funding buyer", async () => {
    const harness = guestFundingActionFixture()
    await expect(
      advanceCheckoutSparkSettledShopper(
        {
          ...harness.action,
          guestIdentity: null,
          currentBuyerPubkey: () => BUYER,
        },
        harness.dependencies
      )
    ).rejects.toThrow("order authority changed")
    await expect(
      advanceCheckoutSparkSettledShopper(
        {
          ...harness.action,
          fundingPayment: {
            ...harness.action.fundingPayment,
            buyerPubkey: MERCHANT,
          },
        },
        harness.dependencies
      )
    ).rejects.toThrow("funding buyer changed")
    expect(harness.calls.funding).toBe(0)
  })

  it.each([undefined, NOW + GUEST_ORDER_SESSION_TTL_MS + 1])(
    "rejects a missing or mismatched saved guest lifetime: %s",
    async (guestSessionExpiresAt) => {
      const harness = guestFundingActionFixture()
      harness.authority.lifecycle.guestSessionExpiresAt = guestSessionExpiresAt
      await expect(
        advanceCheckoutSparkSettledShopper(harness.action, harness.dependencies)
      ).rejects.toThrow("order authority changed")
      expect(harness.calls.funding).toBe(0)
    }
  )
})

describe("settled Spark buyer order control", () => {
  it("projects the saved buyer price without disclosing recipient identities or splits", () => {
    const { input } = fixture()
    const control = assessCheckoutSparkSettledOrderControl(input)
    if (control.status !== "pay_funding")
      throw new Error("Expected funding review")
    expect(control.priceSummary).toEqual({
      itemSubtotalSats: 1_000,
      shippingSubtotalSats: 0,
      commerceTotalSats: 1_000,
      conduitFeeSats: 111,
      networkAllowanceSats: 2,
      coordinationFeeSats: 113,
      totalSats: 1_113,
      minimumApplies: true,
    })
    expect(JSON.stringify(control.priceSummary)).not.toContain(
      "merchant@example.test"
    )
    expect(control.grossFundingSats).toBe(1_113)
  })

  it("reviews the approved native treasury policy before funding without exposing provider material", () => {
    const { input } = nativeFixture()
    const control = assessCheckoutSparkSettledOrderControl(input)
    if (control.status !== "pay_funding")
      throw new Error("Expected native funding review")
    expect(control).toMatchObject({
      nativeTreasury: {
        estimatedBaseConduitAllocationSats: 111,
        fixedCheckoutTotalSats: 1_113,
        prepared: null,
      },
    })
    expect(JSON.stringify(control)).not.toContain("spark-treasury.fixture")
    expect(JSON.stringify(control)).not.toContain("spark-invoice.fixture")
  })

  it("routes the prepared native final leg without Lightning review or expiry", () => {
    const { plan, input } = preparedNativeFixture()
    const control = assessCheckoutSparkSettledOrderControl(input)
    expect(control).toMatchObject({
      status: "route_payout",
      recipientKind: "conduit",
      payoutReview: null,
      sendWindowEndsAt: null,
      nativeTreasury: {
        estimatedBaseConduitAllocationSats: 111,
        fixedCheckoutTotalSats: 1_113,
        prepared: {
          baseConduitAllocationSats: 111,
          unusedCommerceReserveSats: 4,
          totalSats: 115,
          sparkFeeCapSats: 0,
        },
      },
    })
    if (control.status !== "route_payout")
      throw new Error("Expected native treasury routing")
    expect(
      control.nativeTreasury!.prepared!.unusedCommerceReserveSats
    ).toBeGreaterThan(control.priceSummary.networkAllowanceSats)
    expect(control.nativeTreasury!.prepared!.totalSats).toBeGreaterThan(
      control.priceSummary.coordinationFeeSats
    )
    expect(control.nativeTreasury!.prepared!.baseConduitAllocationSats).toBe(
      control.nativeTreasury!.estimatedBaseConduitAllocationSats
    )
    expect(control.intentFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(
      matchesCheckoutSparkSettledOrderControl({
        displayed: control,
        current: control,
        bindingPlanDigest: plan.planDigest,
      })
    ).toBe(true)
  })

  it("prepares the native final leg after paid commerce without requiring a Lightning invoice", () => {
    const { commercePaidInput } = preparedNativeFixture()
    expect(
      assessCheckoutSparkSettledOrderControl(commercePaidInput)
    ).toMatchObject({
      status: "prepare_payout",
      recipientKind: "conduit",
      payoutReview: null,
      sendWindowEndsAt: null,
      nativeTreasury: {
        prepared: null,
      },
    })
  })

  it("keeps only the exact native final leg actionable after commerce completes the order lifecycle", () => {
    const { plan, commercePaidInput } = preparedNativeFixture()
    const completed = {
      ...commercePaidInput,
      lifecycle: {
        ...commercePaidInput.lifecycle,
        phase: "completed" as const,
        paymentStatus: "paid" as const,
      },
    }
    expect(assessCheckoutSparkSettledOrderControl(completed)).toMatchObject({
      status: "prepare_payout",
      recipientKind: "conduit",
      paidLegs: 1,
      totalLegs: 2,
      nativeTreasury: { prepared: null },
    })
    for (const candidate of [
      {
        ...completed,
        lifecycle: { ...completed.lifecycle, phase: "cancelled" as const },
      },
      { ...completed, now: plan.takeoverAt },
      { ...completed, routerWalletOpen: false },
    ]) {
      expect(assessCheckoutSparkSettledOrderControl(candidate).status).toBe(
        "blocked"
      )
    }
  })

  it("shows exact retired state without restoring a wallet or claiming payout proof", () => {
    const { plan, input } = fixture()
    const current = assessCheckoutSparkSettledOrderControl({
      ...input,
      lifecycle: {
        ...input.lifecycle,
        phase: "completed",
        paymentStatus: "paid",
      },
      preparation: null,
      initialRecoverySenderPubkey: null,
      initialRecoveryAcked: false,
      routerWalletOpen: false,
      now: NOW + 20,
      snapshot: {
        status: "retired",
        planDigest: plan.planDigest,
        retiredAt: NOW + 10,
      },
    })
    expect(current).toEqual({ status: "retired" })
    expect(
      matchesCheckoutSparkSettledOrderControl({
        displayed: current,
        current,
        bindingPlanDigest: plan.planDigest,
      })
    ).toBe(false)
  })

  it("does not expose a mismatched tombstone or an expired buyer session as retired", () => {
    const { plan, input } = fixture()
    const snapshot = {
      status: "retired" as const,
      planDigest: plan.planDigest,
      retiredAt: NOW + 10,
    }
    const retiredInput = { ...input, snapshot, now: NOW + 20 }
    for (const candidate of [
      { ...retiredInput, buyerPubkey: MERCHANT },
      { ...retiredInput, now: Number.NaN },
      { ...retiredInput, now: NOW + 9 },
      { ...retiredInput, snapshot: { ...snapshot, retiredAt: -1 } },
      {
        ...retiredInput,
        snapshot: { ...snapshot, planDigest: "f".repeat(64) },
      },
      {
        ...retiredInput,
        lifecycle: { ...input.lifecycle, phase: "cancelled" as const },
      },
    ]) {
      expect(assessCheckoutSparkSettledOrderControl(candidate).status).toBe(
        "blocked"
      )
    }
    const guest = guestIdentity()
    const guestInput = {
      ...retiredInput,
      lifecycle: {
        ...input.lifecycle,
        buyerIdentityKind: "guest_ephemeral" as const,
        guestSessionExpiresAt: guest.expiresAt,
      },
      guestIdentity: guest,
    }
    expect(assessCheckoutSparkSettledOrderControl(guestInput)).toEqual({
      status: "retired",
    })
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...guestInput,
        now: guest.expiresAt,
      }).status
    ).toBe("blocked")
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...guestInput,
        guestIdentity: null,
      }).status
    ).toBe("blocked")
  })

  it("offers inspection-only cleanup after every payout is recorded paid", () => {
    const { plan, input } = fixture()
    let state = recordCheckoutSparkSettledCredit(input.snapshot.state, {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: NOW + 2,
    })
    for (const [index, recipient] of plan.recipients.entries()) {
      const amount = state.legs[index]!.allocationSats! - 1
      const hash = (index + 5).toString(16).padStart(2, "0").repeat(32)
      const transferId = deriveCheckoutSparkSettledTransferId(
        plan,
        recipient.legId
      )
      state = prepareCheckoutSparkSettledLeg(state, {
        legId: recipient.legId,
        transferId,
        paymentRequest: invoice(amount, index + 5),
        paymentHash: hash,
        invoiceAmountSats: amount,
        maxFeeSats: 1,
        preparedAt: NOW + 3 + index * 2,
      })
      state = recordCheckoutSparkSettledLegStatus(state, {
        legId: recipient.legId,
        transferId,
        paymentHash: hash,
        status: "paid",
        finalFeeSats: 1,
        finalDebitSats: amount + 1,
        observedAt: NOW + 4 + index * 2,
      })
    }
    const result = assessCheckoutSparkSettledOrderControl({
      ...input,
      now: NOW + 10,
      snapshot: { ...input.snapshot, state },
    })
    expect(result).toMatchObject({
      status: "complete",
      paidLegs: 2,
      totalLegs: 2,
      retirement: {
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        network: plan.network,
      },
    })
    expect(
      matchesCheckoutSparkSettledOrderControl({
        displayed: result,
        current: result,
        bindingPlanDigest: plan.planDigest,
      })
    ).toBe(false)
    for (const phase of ["placed", "completed"] as const) {
      expect(
        assessCheckoutSparkSettledOrderControl({
          ...input,
          lifecycle: { ...input.lifecycle, phase, paymentStatus: "paid" },
          now: NOW + 10,
          snapshot: { ...input.snapshot, state },
        })
      ).toEqual(result)
    }
    for (const change of [
      { routerWalletOpen: false },
      { now: plan.takeoverAt },
    ]) {
      expect(
        assessCheckoutSparkSettledOrderControl({
          ...input,
          now: NOW + 10,
          snapshot: { ...input.snapshot, state },
          ...change,
        })
      ).toEqual({
        status: "complete",
        paidLegs: 2,
        totalLegs: 2,
        priceSummary:
          "priceSummary" in result ? result.priceSummary : undefined,
        nativeTreasury: null,
        retirement: null,
      })
    }
    for (const change of [
      { initialRecoveryAcked: false },
      { lifecycle: { ...input.lifecycle, phase: "cancelled" as const } },
    ]) {
      expect(
        assessCheckoutSparkSettledOrderControl({
          ...input,
          now: NOW + 10,
          snapshot: { ...input.snapshot, state },
          ...change,
        }).status
      ).toBe("blocked")
    }
  })

  it("offers one funding action only for the exact signed buyer and order", () => {
    const { input } = fixture()
    expect(assessCheckoutSparkSettledOrderControl(input).status).toBe(
      "pay_funding"
    )
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...input,
        initialRecoverySenderPubkey: MERCHANT,
      }).status
    ).toBe("blocked")
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...input,
        initialRecoveryAcked: false,
      }).status
    ).toBe("blocked")
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...input,
        lifecycle: {
          ...input.lifecycle,
          orderDeliveryStatus: "pending",
        },
      }).status
    ).toBe("blocked")
  })

  it("replaces an expired funding action with exact-credit inspection", () => {
    const { plan, input } = fixture(NOW + 3_600_001)
    const beforeExpiry = assessCheckoutSparkSettledOrderControl({
      ...input,
      now: plan.funding.expiresAt - 1,
    })
    expect(beforeExpiry.status).toBe("pay_funding")
    if (beforeExpiry.status !== "pay_funding") return
    expect(beforeExpiry.fundingExpiresAt).toBe(plan.funding.expiresAt)

    const afterExpiry = assessCheckoutSparkSettledOrderControl({
      ...input,
      now: plan.funding.expiresAt,
    })
    expect(afterExpiry.status).toBe("check_funding")
    if (afterExpiry.status !== "check_funding") return
    expect(afterExpiry.checkoutId).toBe(plan.checkoutId)
    expect(afterExpiry.fundingExpiresAt).toBe(plan.funding.expiresAt)
    expect(afterExpiry.legId).toBeNull()
    expect(afterExpiry.payoutReview).toBeNull()
  })

  it("checks provisional funding without offering a second payment", () => {
    const { input } = fixture()
    expect(
      assessCheckoutSparkSettledOrderControl({
        ...input,
        preparation: {
          ...input.preparation,
          fundingSubmissionState: "provisional",
        },
      }).status
    ).toBe("check_funding")
  })

  it("offers external funding only before a send or for its own saved disclosure", () => {
    const { input } = fixture()
    const fresh = assessCheckoutSparkSettledOrderControl(input)
    expect(fresh.status).toBe("pay_funding")
    expect(
      "externalFundingAvailable" in fresh && fresh.externalFundingAvailable
    ).toBe(true)
    const automaticProvisional = assessCheckoutSparkSettledOrderControl({
      ...input,
      preparation: {
        ...input.preparation,
        fundingSubmissionState: "provisional",
      },
    })
    expect(automaticProvisional.status).toBe("check_funding")
    expect(
      "externalFundingAvailable" in automaticProvisional &&
        automaticProvisional.externalFundingAvailable
    ).toBe(false)
    const externalProvisional = assessCheckoutSparkSettledOrderControl({
      ...input,
      preparation: {
        ...input.preparation,
        fundingSubmissionState: "provisional",
        externalFundingExposedAt: NOW + 2,
        savedAt: NOW + 2,
      },
    })
    expect(externalProvisional.status).toBe("check_funding")
    expect(
      "externalFundingAvailable" in externalProvisional &&
        externalProvisional.externalFundingAvailable
    ).toBe(true)
  })

  it("removes external funding at invoice expiry or exact receive credit, independently of takeover", () => {
    const { plan, input } = fixture(NOW + 3_600_001)
    const preparation = {
      ...input.preparation,
      fundingSubmissionState: "provisional" as const,
      externalFundingExposedAt: NOW + 2,
      savedAt: NOW + 2,
    }
    const expired = assessCheckoutSparkSettledOrderControl({
      ...input,
      preparation,
      now: plan.funding.expiresAt,
    })
    expect(expired.status).toBe("check_funding")
    expect(
      "externalFundingAvailable" in expired && expired.externalFundingAvailable
    ).toBe(false)
    const takeover = assessCheckoutSparkSettledOrderControl({
      ...input,
      preparation,
      now: plan.takeoverAt,
    })
    expect(takeover.status).toBe("check_funding")
    expect(
      "externalFundingAvailable" in takeover &&
        takeover.externalFundingAvailable
    ).toBe(false)
    const credited = recordCheckoutSparkSettledCredit(input.snapshot.state, {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: NOW + 2,
    })
    const funded = assessCheckoutSparkSettledOrderControl({
      ...input,
      preparation,
      snapshot: { ...input.snapshot, state: credited },
    })
    expect(funded.status).toBe("prepare_payout")
    expect(
      "externalFundingAvailable" in funded && funded.externalFundingAvailable
    ).toBe(false)
  })

  it.each(["signed_in", "guest_ephemeral"] as const)(
    "separates exact credit, invoice preparation, payout, and uncertain read for %s",
    (identityKind) => {
      const { plan, input } = fixture()
      input.lifecycle.buyerIdentityKind = identityKind
      if (identityKind === "guest_ephemeral")
        input.lifecycle.guestSessionExpiresAt = guestIdentity().expiresAt
      const credited = recordCheckoutSparkSettledCredit(input.snapshot.state, {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: "funding-transfer",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: 1_113,
        creditedSats: 1_111,
        observedAt: NOW + 2,
      })
      const withCredit = {
        ...input,
        guestIdentity:
          identityKind === "guest_ephemeral" ? guestIdentity() : null,
        snapshot: { ...input.snapshot, state: credited },
      }
      expect(assessCheckoutSparkSettledOrderControl(withCredit).status).toBe(
        "prepare_payout"
      )
      const legId = plan.recipients[0]!.legId
      const prepared = prepareCheckoutSparkSettledLeg(credited, {
        legId,
        transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
        paymentRequest: invoice(995, 4),
        paymentHash: "04".repeat(32),
        invoiceAmountSats: 995,
        maxFeeSats: 5,
        preparedAt: NOW + 3,
      })
      const routeControl = assessCheckoutSparkSettledOrderControl({
        ...withCredit,
        snapshot: { ...input.snapshot, state: prepared },
      })
      expect(routeControl.status).toBe("route_payout")
      if (routeControl.status === "route_payout") {
        expect(routeControl.payoutReview).toEqual({
          recipientKind: "merchant",
          sourceLabel: "Signed recipient profile",
          destinationLabel: "Frozen Lightning destination",
          lightningDestination: "merchant@example.test",
          invoiceAmountSats: 995,
          maxFeeSats: 5,
          allocationSats: 1_000,
        })
        expect(routeControl.intentFingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(
          matchesCheckoutSparkSettledOrderControl({
            displayed: routeControl,
            current: routeControl,
            bindingPlanDigest: plan.planDigest,
          })
        ).toBe(true)
        for (const changedReview of [
          { ...routeControl.payoutReview!, maxFeeSats: 6 },
          {
            ...routeControl.payoutReview!,
            lightningDestination: "changed@example.test",
          },
        ]) {
          expect(
            matchesCheckoutSparkSettledOrderControl({
              displayed: routeControl,
              current: { ...routeControl, payoutReview: changedReview },
              bindingPlanDigest: plan.planDigest,
            })
          ).toBe(false)
        }
        expect(
          matchesCheckoutSparkSettledOrderControl({
            displayed: routeControl,
            current: { ...routeControl, intentFingerprint: "0".repeat(64) },
            bindingPlanDigest: plan.planDigest,
          })
        ).toBe(false)
      }
      const uncertain = recordCheckoutSparkSettledLegStatus(prepared, {
        legId,
        transferId: prepared.legs[0]!.intent!.transferId,
        paymentHash: "04".repeat(32),
        status: "submitted",
        observedAt: NOW + 4,
      })
      expect(
        assessCheckoutSparkSettledOrderControl({
          ...withCredit,
          snapshot: { ...input.snapshot, state: uncertain },
        }).status
      ).toBe("check_payout")
    }
  )

  it("rejects a replaced invoice even when displayed amount and fee match", () => {
    const { plan, input } = fixture()
    const credited = recordCheckoutSparkSettledCredit(input.snapshot.state, {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: NOW + 2,
    })
    const legId = plan.recipients[0]!.legId
    const controlForInvoice = (hashByte: number) => {
      const prepared = prepareCheckoutSparkSettledLeg(credited, {
        legId,
        transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
        paymentRequest: invoice(995, hashByte),
        paymentHash: hashByte.toString(16).padStart(2, "0").repeat(32),
        invoiceAmountSats: 995,
        maxFeeSats: 5,
        preparedAt: NOW + 3,
      })
      return assessCheckoutSparkSettledOrderControl({
        ...input,
        snapshot: { ...input.snapshot, state: prepared },
      })
    }
    const displayed = controlForInvoice(4)
    const replaced = controlForInvoice(5)
    expect(displayed.status).toBe("route_payout")
    expect(replaced.status).toBe("route_payout")
    if (displayed.status !== "route_payout") return
    if (replaced.status !== "route_payout") return
    expect(displayed.payoutReview).toEqual(replaced.payoutReview)
    expect(displayed.intentFingerprint).not.toBe(replaced.intentFingerprint)
    expect(
      matchesCheckoutSparkSettledOrderControl({
        displayed,
        current: replaced,
        bindingPlanDigest: plan.planDigest,
      })
    ).toBe(false)
    expect(
      matchesCheckoutSparkSettledOrderControl({
        displayed,
        current: displayed,
        bindingPlanDigest: "different-plan",
      })
    ).toBe(false)
  })

  it("shows an expired payout as check-only while preserving submitted state", () => {
    const { plan, input } = fixture()
    const credited = recordCheckoutSparkSettledCredit(input.snapshot.state, {
      requestId: plan.funding.requestId,
      paymentHash: plan.funding.paymentHash,
      transferId: "funding-transfer",
      receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
      grossSats: 1_113,
      creditedSats: 1_111,
      observedAt: NOW + 2,
    })
    const legId = plan.recipients[0]!.legId
    const expiry = NOW + 59_000
    const cutoff = expiry
    const prepared = prepareCheckoutSparkSettledLeg(credited, {
      legId,
      transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
      paymentRequest: invoice(995, 4, expiry / 1_000 - 3_600),
      paymentHash: "04".repeat(32),
      invoiceAmountSats: 995,
      maxFeeSats: 5,
      preparedAt: NOW + 3,
    })
    const assessAt = (now: number, state = prepared) =>
      assessCheckoutSparkSettledOrderControl({
        ...input,
        now,
        snapshot: { ...input.snapshot, state },
      }).status

    expect(assessAt(NOW + 4)).toBe("route_payout")
    expect(assessAt(cutoff - 1)).toBe("route_payout")
    expect(assessAt(cutoff)).toBe("payout_window_insufficient")
    const beforeCutoff = assessCheckoutSparkSettledOrderControl({
      ...input,
      now: cutoff - 1,
      snapshot: { ...input.snapshot, state: prepared },
    })
    expect(
      beforeCutoff.status !== "blocked" &&
        beforeCutoff.status !== "complete" &&
        beforeCutoff.status !== "retired" &&
        beforeCutoff.sendWindowEndsAt
    ).toBe(cutoff)

    const submitted = recordCheckoutSparkSettledLegStatus(prepared, {
      legId,
      transferId: prepared.legs[0]!.intent!.transferId,
      paymentHash: "04".repeat(32),
      status: "submitted",
      observedAt: NOW + 4,
    })
    expect(assessAt(cutoff, submitted)).toBe("check_payout")
  })

  it.each([
    "submitted",
    "ambiguous",
    "lookup_unavailable",
    "conflicting_evidence",
  ] as const)(
    "shows a healthy prepared payout as check-only while a sibling is %s",
    (siblingStatus) => {
      const { plan, input } = fixture()
      const credited = recordCheckoutSparkSettledCredit(input.snapshot.state, {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: "funding-transfer",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: 1_113,
        creditedSats: 1_111,
        observedAt: NOW + 2,
      })
      const merchantLegId = plan.recipients[0]!.legId
      const conduitLegId = plan.recipients[1]!.legId
      const withMerchant = prepareCheckoutSparkSettledLeg(credited, {
        legId: merchantLegId,
        transferId: deriveCheckoutSparkSettledTransferId(plan, merchantLegId),
        paymentRequest: invoice(995, 4),
        paymentHash: "04".repeat(32),
        invoiceAmountSats: 995,
        maxFeeSats: 5,
        preparedAt: NOW + 3,
      })
      const bothPrepared = prepareCheckoutSparkSettledLeg(withMerchant, {
        legId: conduitLegId,
        transferId: deriveCheckoutSparkSettledTransferId(plan, conduitLegId),
        paymentRequest: invoice(110, 6),
        paymentHash: "06".repeat(32),
        invoiceAmountSats: 110,
        maxFeeSats: 1,
        preparedAt: NOW + 4,
      })
      const assess = (state: typeof bothPrepared) =>
        assessCheckoutSparkSettledOrderControl({
          ...input,
          now: NOW + 6,
          snapshot: { ...input.snapshot, state },
        })
      expect(assess(bothPrepared).status).toBe("route_payout")

      const uncertain = recordCheckoutSparkSettledLegStatus(bothPrepared, {
        legId: conduitLegId,
        transferId: bothPrepared.legs[1]!.intent!.transferId,
        paymentHash: "06".repeat(32),
        status: siblingStatus,
        observedAt: NOW + 5,
      })
      const control = assess(uncertain)
      expect(control.status).toBe("check_payout")
      if (control.status === "check_payout") {
        expect(control.legId).toBe(merchantLegId)
      }
    }
  )
})

describe("settled Spark buyer action", () => {
  it("returns the authorized external invoice without preparing or sending a payout", async () => {
    const harness = externalFundingActionFixture()
    const result = await advanceCheckoutSparkSettledShopper(
      harness.action,
      harness.dependencies
    )
    expect(result.status).toBe("funding")
    if (result.status !== "funding") return
    expect(result.funding.status).toBe("external_ready")
    if (result.funding.status !== "external_ready") return
    expect(result.funding.externalInvoice === harness.externalInvoice).toBe(
      true
    )
    expect(harness.received[0]?.paymentTarget.type).toBe("manual")
    expect(harness.received[0]?.exposeExternalInvoice).toBe(true)
    expect(harness.received[0]?.inspectionOnly).toBe(false)
    expect(harness.calls).toEqual({
      funding: 1,
      beforeSend: 1,
      disclosures: 1,
      payouts: 0,
    })
  })

  it.each([
    "signout",
    "generation",
    "cancelled",
    "binding",
    "recovery_ack",
    "funding_expiry",
  ] as const)(
    "rejects external disclosure after %s across either bridge await",
    async (change) => {
      for (const stage of ["beforeDisclosure", "beforeReturn"] as const) {
        const harness = externalFundingActionFixture()
        const entered = deferred()
        const release = deferred()
        harness.hooks[stage] = async () => {
          entered.resolve()
          await release.promise
        }
        const advancing = advanceCheckoutSparkSettledShopper(
          harness.action,
          harness.dependencies
        )
        await entered.promise
        if (change === "signout") harness.authority.buyer = MERCHANT
        else if (change === "generation") harness.authority.active = false
        else if (change === "cancelled") {
          harness.authority.lifecycle = {
            ...harness.authority.lifecycle,
            phase: "cancelled",
          }
        } else if (change === "binding") {
          harness.authority.lifecycle = {
            ...harness.authority.lifecycle,
            checkoutSparkRouterBinding: {
              ...harness.authority.lifecycle.checkoutSparkRouterBinding!,
              planDigest: "e".repeat(64),
            },
          }
        } else if (change === "recovery_ack") {
          harness.authority.acknowledged = false
        } else harness.authority.now = harness.plan.funding.expiresAt
        release.resolve()
        await expect(advancing).rejects.toThrow(
          change === "signout" || change === "generation"
            ? "shopper session changed"
            : "order authority changed"
        )
        expect(harness.calls.funding).toBe(1)
        expect(harness.calls.disclosures).toBe(
          stage === "beforeDisclosure" ? 0 : 1
        )
        expect(harness.calls.payouts).toBe(0)
      }
    }
  )

  it("rechecks authority after the caller's awaited external-disclosure guard", async () => {
    const harness = externalFundingActionFixture()
    const entered = deferred()
    const release = deferred()
    harness.hooks.beforeSend = async () => {
      entered.resolve()
      await release.promise
    }
    const advancing = advanceCheckoutSparkSettledShopper(
      harness.action,
      harness.dependencies
    )
    await entered.promise
    harness.authority.active = false
    release.resolve()
    await expect(advancing).rejects.toThrow("shopper session changed")
    expect(harness.calls.beforeSend).toBe(1)
    expect(harness.calls.disclosures).toBe(0)
    expect(harness.calls.payouts).toBe(0)
  })

  it.each(["fact_write_failure", "session_revoked"] as const)(
    "reconciles a paid provider result after %s without a second send",
    async (faultMode) => {
      const database = new ConduitDB(`shopper-facts-${crypto.randomUUID()}`, {
        indexedDB,
        IDBKeyRange,
      })
      try {
        const { plan, input } = fixture()
        const legId = plan.recipients[0]!.legId
        const credited = recordCheckoutSparkSettledCredit(
          input.snapshot.state,
          {
            requestId: plan.funding.requestId,
            paymentHash: plan.funding.paymentHash,
            transferId: "funding-transfer",
            receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
            grossSats: 1_113,
            creditedSats: 1_111,
            observedAt: NOW + 2,
          }
        )
        const prepared = prepareCheckoutSparkSettledLeg(credited, {
          legId,
          transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
          paymentRequest: invoice(995, 4),
          paymentHash: "04".repeat(32),
          invoiceAmountSats: 995,
          maxFeeSats: 5,
          preparedAt: NOW + 3,
        })
        const stored = new DexieCheckoutSparkSettledRepository(database)
        await stored.create(plan)
        const resolved = await resolveCheckoutSparkFixtureInvoice(
          {
            lud16: plan.recipients[0]!.destination.value,
            network: plan.network,
            amountSats: 995,
            nowSeconds: NOW / 1_000,
            shouldContinue: () => true,
          },
          prepared.legs[0]!.intent!.paymentRequest
        )
        await stored.savePreparedWithInvoiceOrigin(prepared, 1, {
          legId,
          origin: resolved.origin!,
        })
        // Imported credit state alone is not provider verification.
        expect(
          await stored.loadMerchantSettlement(
            MERCHANT,
            plan.checkoutId,
            plan.planDigest
          )
        ).toBeNull()
        await stored.recordMerchantCredit(
          plan,
          {
            mode: "ordinary_v3",
            requestId: plan.funding.requestId,
            transferId: "funding-transfer",
            receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
            grossSats: 1_113,
            creditedSats: 1_111,
          },
          NOW + 2
        )

        let sendCalls = 0
        let failFactWrite = faultMode === "fact_write_failure"
        let currentBuyer = BUYER
        const paid = (
          target: CheckoutSparkSettledOutgoingTarget
        ): CheckoutSparkSettledOutgoingObservation => ({
          legId: target.legId,
          transferId: target.intent.transferId,
          paymentRequest: target.intent.paymentRequest,
          paymentHash: target.intent.paymentHash,
          invoiceAmountSats: target.intent.invoiceAmountSats,
          maxFeeSats: target.intent.maxFeeSats,
          status: "paid",
          finalFeeSats: 1,
          finalDebitSats: target.intent.invoiceAmountSats + 1,
        })
        const repository = {
          create: stored.create.bind(stored),
          load: stored.load.bind(stored),
          save: stored.save.bind(stored),
          savePreparedWithInvoiceOrigin:
            stored.savePreparedWithInvoiceOrigin.bind(stored),
          assertLocalInvoiceOrigin:
            stored.assertLocalInvoiceOrigin.bind(stored),
          recordMerchantPayout: async (
            ...args: Parameters<
              DexieCheckoutSparkSettledRepository["recordMerchantPayout"]
            >
          ) => {
            if (failFactWrite)
              throw new Error("simulated local fact write failure")
            return stored.recordMerchantPayout(...args)
          },
        }
        const action = {
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          orderId: plan.orderId,
          merchantPubkey: plan.merchantPubkey,
          network: plan.network,
          buyerPubkey: BUYER,
          currentBuyerPubkey: () => currentBuyer,
          shouldContinue: () => true,
          legId,
          fundingPayment: {
            buyerPubkey: BUYER,
            shouldContinue: () => true,
            paymentTarget: { type: "manual" as const },
            timeoutMs: 60_000,
            appId: "market" as const,
          },
          acknowledgeRecoverySnapshot: async () => {},
        }
        const dependencies = {
          readOrder: async () => input.lifecycle,
          readPreparation: () => input.preparation,
          readInitialRecovery: () =>
            ({
              record: { senderPubkey: BUYER },
              deliveryProgress: { acknowledgedRelayRefs: ["relay"] },
            }) as ReturnType<
              NonNullable<
                AdvanceCheckoutSparkSettledShopperDependencies["readInitialRecovery"]
              >
            >,
          loadAuthorized: async () =>
            ({
              plan,
              state: prepared,
              recoveryHandoffId: input.preparation.recoveryHandoffId,
            }) as Awaited<
              ReturnType<
                NonNullable<
                  AdvanceCheckoutSparkSettledShopperDependencies["loadAuthorized"]
                >
              >
            >,
          repository,
          sparkConfiguration: () =>
            ({ status: "ready", network: "mainnet" }) as ReturnType<
              NonNullable<
                AdvanceCheckoutSparkSettledShopperDependencies["sparkConfiguration"]
              >
            >,
          sparkManager: () =>
            ({ isOpen: () => true }) as ReturnType<
              NonNullable<
                AdvanceCheckoutSparkSettledShopperDependencies["sparkManager"]
              >
            >,
          outgoingProvider: () => ({
            reconcile: async (target: CheckoutSparkSettledOutgoingTarget) =>
              sendCalls === 0
                ? ({
                    legId: target.legId,
                    transferId: target.intent.transferId,
                    paymentRequest: target.intent.paymentRequest,
                    paymentHash: target.intent.paymentHash,
                    invoiceAmountSats: target.intent.invoiceAmountSats,
                    maxFeeSats: target.intent.maxFeeSats,
                    status: "not_found" as const,
                  } satisfies CheckoutSparkSettledOutgoingObservation)
                : paid(target),
            preflight: async () => "ready" as const,
            send: async (target: CheckoutSparkSettledOutgoingTarget) => {
              sendCalls += 1
              if (faultMode === "session_revoked") currentBuyer = MERCHANT
              return paid(target)
            },
          }),
          now: () => NOW + 4,
        } satisfies AdvanceCheckoutSparkSettledShopperDependencies

        if (faultMode === "session_revoked") {
          await expect(
            advanceCheckoutSparkSettledShopper(action, dependencies)
          ).rejects.toThrow("shopper session changed")
        } else {
          const first = await advanceCheckoutSparkSettledShopper(
            action,
            dependencies
          )
          expect(first.status).toBe("outgoing_step")
          if (first.status !== "outgoing_step") return
          expect(first.step.outcome).toBe("send_ambiguous")
          expect(first.step.state.legs[0]?.status).toBe("submitted")
        }
        const afterFirst = await stored.load(plan.checkoutId, plan.planDigest)
        expect(afterFirst.status).toBe("active")
        if (afterFirst.status === "active") {
          expect(afterFirst.state.legs[0]?.status).toBe("submitted")
        }
        expect(sendCalls).toBe(1)
        expect(
          projectCheckoutSparkMerchantSettlement(
            (await stored.loadMerchantSettlement(
              MERCHANT,
              plan.checkoutId,
              plan.planDigest
            ))!
          ).commerceVerified
        ).toBe(false)

        failFactWrite = false
        currentBuyer = BUYER
        const second = await advanceCheckoutSparkSettledShopper(
          action,
          dependencies
        )
        expect(second.status).toBe("outgoing_step")
        if (second.status !== "outgoing_step") return
        expect(second.step.outcome).toBe("already_paid")
        expect(second.step.sendAttempted).toBe(false)
        expect(sendCalls).toBe(1)
        expect(
          projectCheckoutSparkMerchantSettlement(
            (await stored.loadMerchantSettlement(
              MERCHANT,
              plan.checkoutId,
              plan.planDigest
            ))!
          ).commerceVerified
        ).toBe(true)
      } finally {
        database.close()
        await database.delete()
      }
    }
  )

  it("requires delivered exact buyer authority and never cascades funding into payout", async () => {
    const { plan, input } = fixture()
    let fundingCalls = 0
    let payoutCalls = 0
    let sender = BUYER
    const fundingInspectionModes: Array<boolean | undefined> = []
    const dependencies = {
      readOrder: async () => input.lifecycle,
      readPreparation: () => input.preparation,
      readInitialRecovery: () =>
        ({
          record: { senderPubkey: sender },
          deliveryProgress: { acknowledgedRelayRefs: ["relay"] },
        }) as ReturnType<
          NonNullable<
            AdvanceCheckoutSparkSettledShopperDependencies["readInitialRecovery"]
          >
        >,
      loadAuthorized: async () =>
        ({
          plan,
          state: input.snapshot.state,
          recoveryHandoffId: input.preparation.recoveryHandoffId,
        }) as Awaited<
          ReturnType<
            NonNullable<
              AdvanceCheckoutSparkSettledShopperDependencies["loadAuthorized"]
            >
          >
        >,
      repository: {
        async load() {
          return input.snapshot
        },
      } as AdvanceCheckoutSparkSettledShopperDependencies["repository"],
      sparkConfiguration: () =>
        ({ status: "ready", network: "mainnet" }) as ReturnType<
          NonNullable<
            AdvanceCheckoutSparkSettledShopperDependencies["sparkConfiguration"]
          >
        >,
      sparkManager: () =>
        ({ isOpen: () => true }) as ReturnType<
          NonNullable<
            AdvanceCheckoutSparkSettledShopperDependencies["sparkManager"]
          >
        >,
      fundingBridge: () =>
        ({
          async fund(payment) {
            fundingCalls += 1
            fundingInspectionModes.push(payment.inspectionOnly)
            return { status: "funded", reconciliation: input.snapshot.state }
          },
        }) as ReturnType<
          NonNullable<
            AdvanceCheckoutSparkSettledShopperDependencies["fundingBridge"]
          >
        >,
      outgoingStep: async () => {
        payoutCalls += 1
        throw new Error("should not route")
      },
      now: () => NOW + 2,
    } satisfies AdvanceCheckoutSparkSettledShopperDependencies
    const action = {
      checkoutId: plan.checkoutId,
      planDigest: plan.planDigest,
      orderId: plan.orderId,
      merchantPubkey: plan.merchantPubkey,
      network: plan.network,
      buyerPubkey: BUYER,
      currentBuyerPubkey: () => BUYER,
      shouldContinue: () => true,
      legId: null,
      fundingPayment: {
        buyerPubkey: BUYER,
        shouldContinue: () => true,
        paymentTarget: { type: "manual" as const },
        timeoutMs: 60_000,
        appId: "market" as const,
      },
      acknowledgeRecoverySnapshot: async () => {
        throw new Error("should not ACK a payout")
      },
    }
    expect(
      (await advanceCheckoutSparkSettledShopper(action, dependencies)).status
    ).toBe("funding")
    expect(fundingCalls).toBe(1)
    expect(payoutCalls).toBe(0)
    expect(
      (
        await advanceCheckoutSparkSettledShopper(
          {
            ...action,
            fundingPayment: { ...action.fundingPayment, inspectionOnly: true },
          },
          dependencies
        )
      ).status
    ).toBe("funding")
    expect(fundingInspectionModes).toEqual([undefined, true])
    expect(payoutCalls).toBe(0)
    sender = MERCHANT
    await expect(
      advanceCheckoutSparkSettledShopper(action, dependencies)
    ).rejects.toThrow("order authority changed")
    expect(fundingCalls).toBe(2)
  })

  it.each(["signed_in", "guest_ephemeral"] as const)(
    "cannot turn a failed recovery ACK into a send and needs a second click after preparation for %s",
    async (identityKind) => {
      const { plan, input } = fixture()
      input.lifecycle.buyerIdentityKind = identityKind
      const guest = identityKind === "guest_ephemeral" ? guestIdentity() : null
      if (guest) input.lifecycle.guestSessionExpiresAt = guest.expiresAt
      let state = recordCheckoutSparkSettledCredit(input.snapshot.state, {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: "funding-transfer",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: 1_113,
        creditedSats: 1_111,
        observedAt: NOW + 2,
      })
      const legId = plan.recipients[0]!.legId
      let acknowledgements = 0
      let failAcknowledgement = true
      let outgoingCalls = 0
      const inspectionModes: Array<boolean | undefined> = []
      const action = {
        guestIdentity: guest,
        currentGuestIdentity: () => guest,
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        orderId: plan.orderId,
        merchantPubkey: plan.merchantPubkey,
        network: plan.network,
        buyerPubkey: BUYER,
        currentBuyerPubkey: () => BUYER,
        shouldContinue: () => true,
        legId,
        fundingPayment: {
          buyerPubkey: BUYER,
          shouldContinue: () => true,
          paymentTarget: { type: "manual" as const },
          timeoutMs: 60_000,
          appId: "market" as const,
        },
        acknowledgeRecoverySnapshot: async () => {
          acknowledgements += 1
          if (failAcknowledgement) throw new Error("no exact relay ACK")
        },
      }
      const dependencies = {
        readOrder: async () => input.lifecycle,
        readPreparation: () => input.preparation,
        readInitialRecovery: () =>
          ({
            record: { senderPubkey: BUYER },
            deliveryProgress: { acknowledgedRelayRefs: ["relay"] },
          }) as ReturnType<
            NonNullable<
              AdvanceCheckoutSparkSettledShopperDependencies["readInitialRecovery"]
            >
          >,
        loadAuthorized: async () =>
          ({
            plan,
            state,
            recoveryHandoffId: input.preparation.recoveryHandoffId,
          }) as Awaited<
            ReturnType<
              NonNullable<
                AdvanceCheckoutSparkSettledShopperDependencies["loadAuthorized"]
              >
            >
          >,
        repository: {
          async load() {
            return { status: "active" as const, revision: 1, state }
          },
        } as AdvanceCheckoutSparkSettledShopperDependencies["repository"],
        sparkConfiguration: () =>
          ({ status: "ready", network: "mainnet" }) as ReturnType<
            NonNullable<
              AdvanceCheckoutSparkSettledShopperDependencies["sparkConfiguration"]
            >
          >,
        sparkManager: () =>
          ({ isOpen: () => true }) as ReturnType<
            NonNullable<
              AdvanceCheckoutSparkSettledShopperDependencies["sparkManager"]
            >
          >,
        prepareLeg: async (
          _request: unknown,
          prepDependencies: {
            acknowledgeRecoverySnapshot: (next: typeof state) => Promise<void>
          }
        ) => {
          await prepDependencies.acknowledgeRecoverySnapshot(state)
          state = prepareCheckoutSparkSettledLeg(state, {
            legId,
            transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
            paymentRequest: invoice(995, 4),
            paymentHash: "04".repeat(32),
            invoiceAmountSats: 995,
            maxFeeSats: 5,
            preparedAt: NOW + 3,
          })
          return { status: "active" as const, revision: 2, state }
        },
        outgoingProvider: () => ({
          reconcile: async (target) => ({
            legId: target.legId,
            transferId: target.intent.transferId,
            paymentRequest: target.intent.paymentRequest,
            paymentHash: target.intent.paymentHash,
            invoiceAmountSats: target.intent.invoiceAmountSats,
            maxFeeSats: target.intent.maxFeeSats,
            status: "not_found" as const,
          }),
          preflight: async () => "ready" as const,
          send: async () => ({ status: "not_sent" as const }),
        }),
        outgoingStep: async ({ inspectionOnly }) => {
          outgoingCalls += 1
          inspectionModes.push(inspectionOnly)
          return {
            state,
            outcome: "wait" as const,
            reason: "prior_possible_send" as const,
            sendAttempted: false,
          }
        },
        now: () => NOW + 4,
      } as AdvanceCheckoutSparkSettledShopperDependencies
      await expect(
        advanceCheckoutSparkSettledShopper(action, dependencies)
      ).rejects.toThrow("no exact relay ACK")
      expect(outgoingCalls).toBe(0)
      const inspection = await advanceCheckoutSparkSettledShopper(
        { ...action, inspectionOnly: true },
        dependencies
      )
      expect(inspection.status).toBe("outgoing_step")
      if (inspection.status !== "outgoing_step")
        throw new Error("Expected invoice-less read-only result")
      expect(inspection.step).toMatchObject({
        outcome: "invoice_needed",
        sendAttempted: false,
      })
      expect(outgoingCalls).toBe(0)
      failAcknowledgement = false
      expect(
        (await advanceCheckoutSparkSettledShopper(action, dependencies)).status
      ).toBe("payout_prepared")
      expect(outgoingCalls).toBe(0)
      expect(
        (
          await advanceCheckoutSparkSettledShopper(
            { ...action, inspectionOnly: true },
            dependencies
          )
        ).status
      ).toBe("outgoing_step")
      expect(outgoingCalls).toBe(1)
      expect(inspectionModes).toEqual([true])
      expect(
        (await advanceCheckoutSparkSettledShopper(action, dependencies)).status
      ).toBe("outgoing_step")
      expect(inspectionModes).toEqual([true, undefined])
      expect(acknowledgements).toBe(2)
    }
  )

  it.each(["signout", "takeover", "guest_removed", "guest_expired"] as const)(
    "rechecks %s after an in-flight SDK read before sending",
    async (change) => {
      const { plan, input } = fixture()
      const guest = change.startsWith("guest_") ? guestIdentity() : null
      let currentGuest = guest
      if (guest) input.lifecycle.buyerIdentityKind = "guest_ephemeral"
      if (guest) input.lifecycle.guestSessionExpiresAt = guest.expiresAt
      const credited = recordCheckoutSparkSettledCredit(input.snapshot.state, {
        requestId: plan.funding.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: "funding-transfer",
        receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
        grossSats: 1_113,
        creditedSats: 1_111,
        observedAt: NOW + 2,
      })
      const legId = plan.recipients[0]!.legId
      const prepared = prepareCheckoutSparkSettledLeg(credited, {
        legId,
        transferId: deriveCheckoutSparkSettledTransferId(plan, legId),
        paymentRequest: invoice(995, 4),
        paymentHash: "04".repeat(32),
        invoiceAmountSats: 995,
        maxFeeSats: 5,
        preparedAt: NOW + 3,
      })
      const entered = deferred()
      const release = deferred()
      let currentBuyer = BUYER
      let clock = NOW + 4
      let irreversibleSends = 0
      const action = {
        guestIdentity: guest,
        currentGuestIdentity: () => currentGuest,
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        orderId: plan.orderId,
        merchantPubkey: plan.merchantPubkey,
        network: plan.network,
        buyerPubkey: BUYER,
        currentBuyerPubkey: () => currentBuyer,
        shouldContinue: () => true,
        legId,
        fundingPayment: {
          buyerPubkey: BUYER,
          shouldContinue: () => true,
          paymentTarget: { type: "manual" as const },
          timeoutMs: 60_000,
          appId: "market" as const,
        },
        acknowledgeRecoverySnapshot: async () => {},
      }
      const dependencies = {
        readOrder: async () => input.lifecycle,
        readPreparation: () => input.preparation,
        readInitialRecovery: () =>
          ({
            record: { senderPubkey: BUYER },
            deliveryProgress: { acknowledgedRelayRefs: ["relay"] },
          }) as ReturnType<
            NonNullable<
              AdvanceCheckoutSparkSettledShopperDependencies["readInitialRecovery"]
            >
          >,
        loadAuthorized: async () =>
          ({
            plan,
            state: prepared,
            recoveryHandoffId: input.preparation.recoveryHandoffId,
          }) as Awaited<
            ReturnType<
              NonNullable<
                AdvanceCheckoutSparkSettledShopperDependencies["loadAuthorized"]
              >
            >
          >,
        repository: {
          async load() {
            return { status: "active" as const, revision: 3, state: prepared }
          },
        } as AdvanceCheckoutSparkSettledShopperDependencies["repository"],
        sparkConfiguration: () =>
          ({ status: "ready", network: "mainnet" }) as ReturnType<
            NonNullable<
              AdvanceCheckoutSparkSettledShopperDependencies["sparkConfiguration"]
            >
          >,
        sparkManager: () =>
          ({ isOpen: () => true }) as ReturnType<
            NonNullable<
              AdvanceCheckoutSparkSettledShopperDependencies["sparkManager"]
            >
          >,
        outgoingProvider: ({ assertBeforeSend }) => ({
          reconcile: async (target) => ({
            legId: target.legId,
            transferId: target.intent.transferId,
            paymentRequest: target.intent.paymentRequest,
            paymentHash: target.intent.paymentHash,
            invoiceAmountSats: target.intent.invoiceAmountSats,
            maxFeeSats: target.intent.maxFeeSats,
            status: "not_found" as const,
          }),
          preflight: async () => {
            throw new Error("not used")
          },
          send: async (target) => {
            entered.resolve()
            await release.promise
            await assertBeforeSend(target)
            irreversibleSends += 1
            return { status: "not_sent" as const }
          },
        }),
        outgoingStep: async ({ provider }) => {
          await provider.send({
            walletId: plan.walletId,
            network: plan.network,
            legId,
            recipientId: MERCHANT,
            allocationSats: 1_000,
            unpaidAllocationSats: 1_111,
            intent: prepared.legs[0]!.intent!,
          })
          throw new Error("unexpected send completion")
        },
        now: () => clock,
      } satisfies AdvanceCheckoutSparkSettledShopperDependencies
      const advancing = advanceCheckoutSparkSettledShopper(action, dependencies)
      await entered.promise
      if (change === "signout") currentBuyer = MERCHANT
      else if (change === "guest_removed") currentGuest = null
      else if (change === "guest_expired") clock = guest!.expiresAt
      else clock = plan.takeoverAt
      release.resolve()
      await expect(advancing).rejects.toThrow(
        change !== "takeover"
          ? "shopper session changed"
          : "order authority changed"
      )
      expect(irreversibleSends).toBe(0)
    }
  )
})
