import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"
import { checkoutSparkQuoteFixture } from "./support/checkout-spark-quote-fixture"
import { withMockRouterInvoiceWitnesses } from "./support/checkout-spark-invoice-witness-fixture"

import {
  getCheckoutSparkRouterPreparation,
  prepareCheckoutSparkRouterFunding,
} from "../apps/market/src/lib/checkout-spark-router-preparation"

const CREATED_AT = 1_800_000_000_000
const MERCHANT = getPublicKey(generateSecretKey())
const BUYER = NDKPrivateKeySigner.generate()
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

function invoice(
  amountSats: number,
  paymentHashByte: number,
  createdAt = CREATED_AT / 1_000
): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbc${amountSats * 10}n`,
    createdAt,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(paymentHashByte)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
    ],
  })
}

class MemoryStorage {
  readonly values = new Map<string, string>()
  failWrites = false

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("storage unavailable")
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function preparationInput() {
  return {
    checkoutId: "checkout-router-preparation-1",
    orderId: "order-router-preparation-1",
    merchantPubkey: MERCHANT,
    network: "mainnet" as const,
    takeoverAt: CREATED_AT + 120_000,
    grossFundingSats: 1_240,
    fundingExpirySecs: 600,
    identity: {
      kind: "signed_in" as const,
      pubkey: BUYER.pubkey,
      signer: BUYER,
    },
    quoteAuthority: checkoutSparkQuoteFixture(MERCHANT),
    routerObligationInputs: {
      commerceTotalSats: 1_000,
      commerce: [
        {
          kind: "merchant",
          recipientId: MERCHANT,
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
    invoiceWitnesses: [],
  }
}

async function readyInput(checkoutId = preparationInput().checkoutId) {
  return withMockRouterInvoiceWitnesses(
    { ...preparationInput(), checkoutId },
    CREATED_AT / 1_000
  )
}

function walletMaterial() {
  return {
    walletId: "spark-checkout-wallet-preparation-1",
    mnemonic: MNEMONIC,
    accountNumber: 1,
    network: "mainnet" as const,
  }
}

function fundingReceive() {
  return {
    walletId: walletMaterial().walletId,
    network: "mainnet" as const,
    id: "receive-router-preparation-1",
    paymentRequest: "lnbc-hidden-router-funding",
    paymentHash: "c".repeat(64),
    providerStatus: "PENDING",
    requiredNetSats: 1_235,
    grossFundingSats: 1_240,
    expirySecs: 600,
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + 600_000,
  }
}

describe("checkout Spark router preparation", () => {
  it("rejects an outgoing invoice that expires at the anticipated deadline before wallet creation", async () => {
    let walletCreateCalls = 0
    const input = preparationInput()
    await expect(
      prepareCheckoutSparkRouterFunding(
        {
          ...input,
          routerObligationInputs: {
            ...input.routerObligationInputs,
            commerce: [
              {
                ...input.routerObligationInputs.commerce[0]!,
                paymentRequest: invoice(1_000, 1, CREATED_AT / 1_000 - 2_700),
              },
            ],
          },
        },
        {
          now: () => CREATED_AT,
          createWalletMaterial: () => {
            walletCreateCalls += 1
            return walletMaterial()
          },
        }
      )
    ).rejects.toThrow("outgoing invoice lifetime is insufficient")
    expect(walletCreateCalls).toBe(0)
  })

  it("rejects a delayed actual receive deadline before recovery publication", async () => {
    let closeCalls = 0
    let publishCalls = 0
    const input = preparationInput()
    const delayedInput = {
      ...input,
      routerObligationInputs: {
        ...input.routerObligationInputs,
        commerce: [
          {
            ...input.routerObligationInputs.commerce[0]!,
            paymentRequest: invoice(1_000, 1, CREATED_AT / 1_000 - 2_650),
          },
        ],
      },
    }
    await expect(
      prepareCheckoutSparkRouterFunding(
        {
          ...(await withMockRouterInvoiceWitnesses(
            delayedInput,
            CREATED_AT / 1_000
          )),
          storage: new MemoryStorage(),
        },
        {
          now: () => CREATED_AT,
          createWalletMaterial: () => walletMaterial(),
          openWallet: async () => undefined,
          createFundingReceive: async () => ({
            ...fundingReceive(),
            createdAt: CREATED_AT + 100_000,
            expiresAt: CREATED_AT + 700_000,
          }),
          publishRecoveryHandoff: async () => {
            publishCalls += 1
            throw new Error("must not publish")
          },
          closeWallet: async () => {
            closeCalls += 1
          },
        }
      )
    ).rejects.toThrow("outgoing invoice lifetime is insufficient")
    expect(publishCalls).toBe(0)
    expect(closeCalls).toBe(1)
  })

  it("keeps the persisted recovery handoff and hides funding when ACK arrives after expiry", async () => {
    const storage = new MemoryStorage()
    let currentTime = CREATED_AT
    let closeCalls = 0
    await expect(
      prepareCheckoutSparkRouterFunding(
        { ...(await readyInput()), storage },
        {
          now: () => currentTime,
          createWalletMaterial: () => walletMaterial(),
          openWallet: async () => undefined,
          createFundingReceive: async () => fundingReceive(),
          publishRecoveryHandoff: async (input) => {
            await input.onPersisted("handoff-delayed-ack")
            currentTime = CREATED_AT + 600_000
            return {
              handoffId: "handoff-delayed-ack",
              canExposeFundingInvoice: true as const,
            }
          },
          closeWallet: async () => {
            closeCalls += 1
          },
        }
      )
    ).rejects.toThrow("funding is no longer safe to expose")
    const stored = getCheckoutSparkRouterPreparation(
      preparationInput().checkoutId,
      storage
    )
    expect(stored?.recoveryHandoffId).toBe("handoff-delayed-ack")
    expect(stored?.fundingInvoiceExposedAt).toBeNull()
    expect(closeCalls).toBe(0)
  })

  it("rejects invalid economics before creating a wallet", async () => {
    let walletCreateCalls = 0

    await expect(
      prepareCheckoutSparkRouterFunding(
        {
          ...preparationInput(),
          routerObligationInputs: {
            ...preparationInput().routerObligationInputs,
            commerceTotalSats: 999,
          },
        },
        {
          createWalletMaterial: () => {
            walletCreateCalls += 1
            return walletMaterial()
          },
        }
      )
    ).rejects.toThrow("commerce obligations do not match")

    expect(walletCreateCalls).toBe(0)
  })

  it("rejects a quote whose signed commerce total differs before wallet creation", async () => {
    let walletCreateCalls = 0
    const input = preparationInput()
    await expect(
      prepareCheckoutSparkRouterFunding(
        {
          ...input,
          quoteAuthority: {
            ...input.quoteAuthority,
            pricing: {
              ...input.quoteAuthority.pricing,
              totalSats: 999,
            },
          },
        },
        {
          createWalletMaterial: () => {
            walletCreateCalls += 1
            return walletMaterial()
          },
        }
      )
    ).rejects.toThrow()
    expect(walletCreateCalls).toBe(0)
  })

  it("blocks valid same-amount invoice substitutions before creating a wallet", async () => {
    let walletCreateCalls = 0
    const dependencies = {
      now: () => CREATED_AT,
      createWalletMaterial: () => {
        walletCreateCalls += 1
        return walletMaterial()
      },
    }

    const merchantInput = await readyInput()
    await expect(
      prepareCheckoutSparkRouterFunding(
        {
          ...merchantInput,
          routerObligationInputs: {
            ...merchantInput.routerObligationInputs,
            commerce: [
              {
                ...merchantInput.routerObligationInputs.commerce[0]!,
                paymentRequest: invoice(1_000, 3),
              },
            ],
          },
        },
        dependencies
      )
    ).rejects.toThrow("witnesses do not match")

    const conduitInput = await readyInput()
    await expect(
      prepareCheckoutSparkRouterFunding(
        {
          ...conduitInput,
          routerObligationInputs: {
            ...conduitInput.routerObligationInputs,
            conduit: {
              ...conduitInput.routerObligationInputs.conduit,
              paymentRequest: invoice(111, 3),
            },
          },
        },
        dependencies
      )
    ).rejects.toThrow("witnesses do not match")

    expect(walletCreateCalls).toBe(0)
  })

  it("persists the frozen plan and exact recovery handoff before exposing funding", async () => {
    const storage = new MemoryStorage()
    const calls: string[] = []

    const result = await prepareCheckoutSparkRouterFunding(
      { ...(await readyInput()), storage },
      {
        now: () => CREATED_AT,
        createWalletMaterial: () => walletMaterial(),
        openWallet: async () => calls.push("open-wallet"),
        createFundingReceive: async () => {
          calls.push("create-hidden-invoice")
          return fundingReceive()
        },
        publishRecoveryHandoff: async (input) => {
          const frozen = getCheckoutSparkRouterPreparation(
            preparationInput().checkoutId,
            storage
          )
          expect(frozen?.reconciliation.plan.planDigest).toBe(
            input.plan.planDigest
          )
          expect(frozen?.recoveryHandoffId).toBeNull()
          expect(frozen?.fundingInvoiceExposedAt).toBeNull()

          await input.onPersisted("handoff-router-preparation-1")
          const persisted = getCheckoutSparkRouterPreparation(
            preparationInput().checkoutId,
            storage
          )
          expect(persisted?.recoveryHandoffId).toBe(
            "handoff-router-preparation-1"
          )
          expect(persisted?.fundingInvoiceExposedAt).toBeNull()
          calls.push("publish-recovery")
          return {
            handoffId: "handoff-router-preparation-1",
            canExposeFundingInvoice: true as const,
          }
        },
        closeWallet: async () => calls.push("close-wallet"),
      }
    )

    expect(calls).toEqual([
      "open-wallet",
      "create-hidden-invoice",
      "publish-recovery",
    ])
    expect(result.fundingInvoice).toBe("lnbc-hidden-router-funding")
    expect(result.plan.funding.paymentRequest).toBe(result.fundingInvoice)
    expect(result.plan.schemaVersion).toBe(2)
    expect(result.plan.commerceQuote?.commerceTotalSats).toBe(1_000)
    expect(result.fundingReceive).toEqual(fundingReceive())
    expect(Object.isFrozen(result.fundingReceive)).toBe(true)
    expect(result.fundingSubmissionState).toBe("not_started")
    expect(result).not.toHaveProperty("mnemonic")
    const stored = getCheckoutSparkRouterPreparation(
      result.plan.checkoutId,
      storage
    )
    expect(stored?.fundingInvoiceExposedAt).toBe(CREATED_AT)
    expect(stored?.fundingSubmissionState).toBe("not_started")
    expect(Array.from(storage.values.values()).join("")).not.toContain(MNEMONIC)
  })

  it("keeps the exact durable handoff retryable and the invoice hidden after zero ACK", async () => {
    const storage = new MemoryStorage()
    let closeCalls = 0

    await expect(
      prepareCheckoutSparkRouterFunding(
        { ...(await readyInput()), storage },
        {
          now: () => CREATED_AT,
          createWalletMaterial: () => walletMaterial(),
          openWallet: async () => undefined,
          createFundingReceive: async () => fundingReceive(),
          publishRecoveryHandoff: async (input) => {
            await input.onPersisted("handoff-zero-ack")
            throw new Error("Checkout Spark recovery received no relay ACK.")
          },
          closeWallet: async () => {
            closeCalls += 1
          },
        }
      )
    ).rejects.toThrow("no relay ACK")

    const stored = getCheckoutSparkRouterPreparation(
      preparationInput().checkoutId,
      storage
    )
    expect(stored?.recoveryHandoffId).toBe("handoff-zero-ack")
    expect(stored?.fundingInvoiceExposedAt).toBeNull()
    expect(closeCalls).toBe(0)
  })

  it("closes an unfunded wallet when the frozen plan cannot be persisted", async () => {
    const storage = new MemoryStorage()
    storage.failWrites = true
    let closeCalls = 0
    let publishCalls = 0

    await expect(
      prepareCheckoutSparkRouterFunding(
        { ...(await readyInput()), storage },
        {
          now: () => CREATED_AT,
          createWalletMaterial: () => walletMaterial(),
          openWallet: async () => undefined,
          createFundingReceive: async () => fundingReceive(),
          publishRecoveryHandoff: async () => {
            publishCalls += 1
            return {
              handoffId: "must-not-publish",
              canExposeFundingInvoice: true as const,
            }
          },
          closeWallet: async () => {
            closeCalls += 1
          },
        }
      )
    ).rejects.toThrow("storage unavailable")

    expect(closeCalls).toBe(1)
    expect(publishCalls).toBe(0)
  })

  it("binds the plan to the provider invoice time and rejects mismatched receive evidence", async () => {
    const storage = new MemoryStorage()
    const fractionalNow = CREATED_AT + 375
    const prepared = await prepareCheckoutSparkRouterFunding(
      {
        ...(await readyInput()),
        storage,
      },
      {
        now: () => fractionalNow,
        createWalletMaterial: () => walletMaterial(),
        openWallet: async () => undefined,
        createFundingReceive: async () => fundingReceive(),
        publishRecoveryHandoff: async (input) => {
          await input.onPersisted("handoff-provider-time")
          return {
            handoffId: "handoff-provider-time",
            canExposeFundingInvoice: true as const,
          }
        },
        closeWallet: async () => undefined,
      }
    )
    expect(prepared.plan.createdAt).toBe(CREATED_AT)

    await expect(
      prepareCheckoutSparkRouterFunding(
        {
          ...(await readyInput("checkout-mismatched-receive")),
          storage: new MemoryStorage(),
        },
        {
          now: () => CREATED_AT,
          createWalletMaterial: () => walletMaterial(),
          openWallet: async () => undefined,
          createFundingReceive: async () => ({
            ...fundingReceive(),
            walletId: "different-wallet",
          }),
          publishRecoveryHandoff: async () => {
            throw new Error("must not publish")
          },
          closeWallet: async () => undefined,
        }
      )
    ).rejects.toThrow("does not match its exact router terms")
  })
})
