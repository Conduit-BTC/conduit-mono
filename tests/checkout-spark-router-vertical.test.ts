import { describe, expect, it, mock } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { openCheckoutSparkRecoveryDelivery } from "@conduit/core"

import {
  getCheckoutSparkRecoveryDelivery,
  publishCheckoutSparkRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import { createCheckoutSparkRouterFundingBridge } from "../apps/market/src/lib/checkout-spark-router-funding"
import {
  getCheckoutSparkRouterPreparation,
  prepareCheckoutSparkRouterFunding,
  retryCheckoutSparkRouterRecoveryAndResumeFunding,
} from "../apps/market/src/lib/checkout-spark-router-preparation"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const CREATED_AT = 1_800_000_000_000
const RELAY = "wss://merchant.inbox.relay.dev"
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
const BUYER = NDKPrivateKeySigner.generate()
const MERCHANT = NDKPrivateKeySigner.generate()

class MemoryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function invoice(amountSats: number, paymentHashByte: number): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt: CREATED_AT / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(paymentHashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

function input(storage: MemoryStorage) {
  return {
    checkoutId: "checkout-router-vertical-1",
    orderId: "order-router-vertical-1",
    merchantPubkey: MERCHANT.pubkey,
    network: "mainnet" as const,
    takeoverAt: CREATED_AT + 120_000,
    grossFundingSats: 1_240,
    fundingExpirySecs: 600,
    identity: {
      kind: "guest_ephemeral" as const,
      orderId: "order-router-vertical-1",
      merchantPubkey: MERCHANT.pubkey,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 120_000,
      pubkey: BUYER.pubkey,
      signer: BUYER,
    },
    routerObligationInputs: {
      commerceTotalSats: 1_000,
      commerce: [
        {
          kind: "merchant" as const,
          recipientId: MERCHANT.pubkey,
          paymentRequest: invoice(1_000, 1),
          amountSats: 1_000,
          maxFeeSats: 100,
        },
      ],
      conduit: {
        paymentRequest: invoice(111, 2),
        maxFeeSats: 24,
      },
    },
    storage,
  }
}

function fundingReceive() {
  return {
    walletId: "spark-router-vertical-wallet-1",
    network: "mainnet" as const,
    id: "spark-router-vertical-receive-1",
    paymentRequest: "lnbc-router-vertical-funding",
    paymentHash: "c".repeat(64),
    providerStatus: "PENDING",
    requiredNetSats: 1_235,
    grossFundingSats: 1_240,
    expirySecs: 600,
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + 600_000,
  }
}

function relayDelivery(success: boolean) {
  return {
    attemptedRelayUrls: [RELAY],
    successfulRelayUrls: success ? [RELAY] : [],
    failedRelayUrls: success ? [] : [RELAY],
    relayFailureMessages: success ? {} : { [RELAY]: "No acknowledgement" },
  }
}

describe("checkout Spark router unfunded vertical flow", () => {
  it("binds the frozen plan, encrypted merchant recovery, ACK, one payer submission and exact Spark receive", async () => {
    const storage = new MemoryStorage()
    const checkoutId = input(storage).checkoutId
    let recoveryWasDurableBeforePublish = false

    const prepared = await prepareCheckoutSparkRouterFunding(input(storage), {
      now: () => CREATED_AT + 1_000,
      createWalletMaterial: () => ({
        walletId: fundingReceive().walletId,
        mnemonic: MNEMONIC,
        accountNumber: 0,
        network: "mainnet",
      }),
      openWallet: async () => undefined,
      createFundingReceive: async () => fundingReceive(),
      publishRecoveryHandoff: (handoff) =>
        publishCheckoutSparkRecoveryHandoff({
          ...handoff,
          storage,
          now: () => CREATED_AT + 1_000,
          transport: {
            recipientInboxRelays: [RELAY],
            publishFn: (async () => {
              const frozen = getCheckoutSparkRouterPreparation(
                checkoutId,
                storage
              )
              recoveryWasDurableBeforePublish =
                frozen?.recoveryHandoffId !== null &&
                frozen?.fundingInvoiceExposedAt === null &&
                getCheckoutSparkRecoveryDelivery(
                  frozen?.recoveryHandoffId ?? "",
                  storage
                ) !== null
              return relayDelivery(true)
            }) as never,
          },
        }),
    })

    expect(recoveryWasDurableBeforePublish).toBe(true)
    expect(
      getCheckoutSparkRouterPreparation(checkoutId, storage)
        ?.fundingInvoiceExposedAt
    ).toBe(CREATED_AT + 1_000)
    const storedRecovery = getCheckoutSparkRecoveryDelivery(
      prepared.recoveryHandoffId,
      storage
    )
    expect(storedRecovery).not.toBeNull()
    const opened = await openCheckoutSparkRecoveryDelivery({
      record: storedRecovery!.record,
      signer: MERCHANT,
    })
    expect(opened.plan.planDigest).toBe(prepared.plan.planDigest)
    expect(opened.wallet.walletId).toBe(prepared.plan.walletId)
    expect(Array.from(storage.values.values()).join("")).not.toContain(MNEMONIC)

    let reconcileCalls = 0
    const payInvoice = mock(async () => ({
      status: "paid" as const,
      rail: "wallet" as const,
      preimage: "fixture-payer-proof",
    }))
    const reconcileCheckoutReceive = mock(async () => {
      reconcileCalls += 1
      return reconcileCalls === 1
        ? {
            state: "pending" as const,
            providerStatus: "PENDING",
            failureReason: null,
            funds: {
              availableSats: 0,
              ownedSats: 0,
              incomingSats: 0,
              observedAt: CREATED_AT + 2_000,
            },
          }
        : {
            state: "spendable" as const,
            providerStatus: "SETTLED",
            failureReason: null,
            funds: {
              availableSats: 1_235,
              ownedSats: 1_240,
              incomingSats: 0,
              observedAt: CREATED_AT + 3_000,
            },
          }
    })
    const bridge = createCheckoutSparkRouterFundingBridge(prepared, {
      storage,
      now: () => CREATED_AT + 3_000,
      payInvoice,
      reconcileCheckoutReceive,
    })
    const paymentInput = {
      grossFundingSats: 1_240,
      paymentTarget: {
        type: "wallet" as const,
        walletId: "fixture-payer-wallet",
        providerId: "nwc",
      },
      walletPaymentAttemptId: "fixture-router-attempt",
      timeoutMs: 60_000,
      appId: "market" as const,
    }

    const result = await bridge.fund(paymentInput)
    expect(result.status).toBe("funded")
    expect(payInvoice).toHaveBeenCalledTimes(1)
    expect(payInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: prepared.plan.funding.paymentRequest,
        amountMsats: 1_240_000,
      })
    )
    expect(
      getCheckoutSparkRouterPreparation(checkoutId, storage)
        ?.fundingSubmissionState
    ).toBe("provisional")

    const reopened = createCheckoutSparkRouterFundingBridge(prepared, {
      storage,
      now: () => CREATED_AT + 4_000,
      payInvoice,
      reconcileCheckoutReceive,
    })
    expect((await reopened.fund(paymentInput)).status).toBe("funded")
    expect(payInvoice).toHaveBeenCalledTimes(1)
  })

  it("keeps the invoice hidden on zero ACK and retries the exact signed wrap", async () => {
    const storage = new MemoryStorage()
    await expect(
      prepareCheckoutSparkRouterFunding(input(storage), {
        now: () => CREATED_AT + 1_000,
        createWalletMaterial: () => ({
          walletId: fundingReceive().walletId,
          mnemonic: MNEMONIC,
          accountNumber: 0,
          network: "mainnet",
        }),
        openWallet: async () => undefined,
        createFundingReceive: async () => fundingReceive(),
        publishRecoveryHandoff: (handoff) =>
          publishCheckoutSparkRecoveryHandoff({
            ...handoff,
            storage,
            now: () => CREATED_AT + 1_000,
            transport: {
              recipientInboxRelays: [RELAY],
              publishFn: (async () => relayDelivery(false)) as never,
            },
          }),
      })
    ).rejects.toThrow("relay ACK")

    const stored = getCheckoutSparkRouterPreparation(
      input(storage).checkoutId,
      storage
    )
    expect(stored?.recoveryHandoffId).not.toBeNull()
    expect(stored?.fundingInvoiceExposedAt).toBeNull()
    const exactWrap = getCheckoutSparkRecoveryDelivery(
      stored!.recoveryHandoffId!,
      storage
    )!.record.signedRecipientWrap
    const unsafePublish = mock(async () => relayDelivery(true))
    await expect(
      retryCheckoutSparkRouterRecoveryAndResumeFunding({
        checkoutId: input(storage).checkoutId,
        storage,
        now: () => input(storage).takeoverAt,
        recipientInboxRelays: [RELAY],
        publishFn: unsafePublish as never,
      })
    ).rejects.toThrow("no longer safe to expose")
    expect(unsafePublish).toHaveBeenCalledTimes(0)
    expect(
      getCheckoutSparkRouterPreparation(input(storage).checkoutId, storage)
        ?.fundingInvoiceExposedAt
    ).toBeNull()

    const resumed = await retryCheckoutSparkRouterRecoveryAndResumeFunding({
      checkoutId: input(storage).checkoutId,
      storage,
      now: () => CREATED_AT + 2_000,
      recipientInboxRelays: [RELAY],
      publishFn: (async (event) => {
        expect(event.id).toBe(exactWrap.id)
        return relayDelivery(true)
      }) as never,
    })
    expect(resumed.fundingInvoice).toBe(fundingReceive().paymentRequest)
    expect(resumed.fundingReceive).toEqual(fundingReceive())
    expect(
      getCheckoutSparkRouterPreparation(input(storage).checkoutId, storage)
        ?.fundingInvoiceExposedAt
    ).toBe(CREATED_AT + 2_000)

    const latePublish = mock(async () => relayDelivery(true))
    await expect(
      retryCheckoutSparkRouterRecoveryAndResumeFunding({
        checkoutId: input(storage).checkoutId,
        storage,
        now: () => fundingReceive().expiresAt,
        recipientInboxRelays: [RELAY],
        publishFn: latePublish as never,
      })
    ).rejects.toThrow("no longer safe to expose")
    expect(latePublish).toHaveBeenCalledTimes(0)
  })
})
