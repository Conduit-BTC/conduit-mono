import { afterEach, describe, expect, it, mock } from "bun:test"

import type {
  RegisteredWalletProvider,
  WalletPayInvoiceInput,
} from "../packages/core/src/wallets"
import { parseNwcUri } from "../packages/core/src/protocol/nwc"
import {
  __buyerNwcSessionTestInternals,
  closeBuyerNwcSession,
  getBuyerNwcSession,
} from "../apps/market/src/lib/buyer-nwc-session"
import {
  marketWalletProviderRegistry,
  WalletPaymentCoordinator,
  WalletProviderRegistry,
} from "../apps/market/src/lib/wallet-payment-coordinator"

const NWC_WALLET_ID = "coordinator-nwc-wallet"
const NWC_CONNECTION = parseNwcUri(
  `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Fwallet.example&secret=${"b".repeat(64)}`
)
const marketAdapterCoordinator = new WalletPaymentCoordinator(
  marketWalletProviderRegistry
)

class Nip47WalletError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

afterEach(() => {
  __buyerNwcSessionTestInternals.__setClientFactory(null)
  closeBuyerNwcSession(NWC_WALLET_ID)
})

function registeredProvider(
  providerId: string,
  payInvoice: (
    walletId: string,
    input: WalletPayInvoiceInput
  ) => Promise<{
    status: "paid"
    preimage: string
  }>
): RegisteredWalletProvider {
  return {
    providerId,
    payInvoice,
  }
}

describe("WalletPaymentCoordinator", () => {
  it("routes an exact wallet target only to its registered provider", async () => {
    const sparkPay = mock(async () => ({
      status: "paid" as const,
      preimage: "spark-preimage",
    }))
    const nwcPay = mock(async () => ({
      status: "paid" as const,
      preimage: "nwc-preimage",
    }))
    const coordinator = new WalletPaymentCoordinator(
      new WalletProviderRegistry([
        registeredProvider("spark", sparkPay),
        registeredProvider("nwc", nwcPay),
      ])
    )

    const result = await coordinator.payInvoice(
      { walletId: "spark-personal", providerId: "spark" },
      {
        invoice: "lnbc1invoice",
        amountMsats: 21_000,
        idempotencyKey: "attempt-1",
        timeoutMs: 30_000,
        appId: "market",
      }
    )

    expect(result).toEqual({
      status: "paid",
      preimage: "spark-preimage",
    })
    expect(sparkPay).toHaveBeenCalledWith(
      "spark-personal",
      expect.objectContaining({ idempotencyKey: "attempt-1" })
    )
    expect(nwcPay).toHaveBeenCalledTimes(0)
  })

  it("fails before publication when the exact provider is unavailable", async () => {
    const sparkPay = mock(async () => ({
      status: "paid" as const,
      preimage: "spark-preimage",
    }))
    const coordinator = new WalletPaymentCoordinator(
      new WalletProviderRegistry([registeredProvider("spark", sparkPay)])
    )

    const result = await coordinator.payInvoice(
      { walletId: "future-wallet", providerId: "wavelength" },
      {
        invoice: "lnbc1invoice",
        amountMsats: 21_000,
        idempotencyKey: "attempt-2",
        timeoutMs: 30_000,
        appId: "market",
      }
    )

    expect(result).toEqual({
      status: "failed",
      phase: "before_publish",
      reason: "The selected wallet provider is unavailable.",
    })
    expect(sparkPay).toHaveBeenCalledTimes(0)
  })

  it("fails before publication when persisted registration no longer admits the target", async () => {
    const sparkPay = mock(async () => ({
      status: "paid" as const,
      preimage: "spark-preimage",
    }))
    const isTargetEligible = mock(async () => false)
    const coordinator = new WalletPaymentCoordinator(
      new WalletProviderRegistry([registeredProvider("spark", sparkPay)]),
      { isTargetEligible }
    )

    await expect(
      coordinator.payInvoice(
        { walletId: "removed-wallet", providerId: "spark" },
        {
          invoice: "lnbc1invoice",
          amountMsats: 21_000,
          idempotencyKey: "attempt-removed",
          timeoutMs: 30_000,
          appId: "market",
        }
      )
    ).resolves.toEqual({
      status: "failed",
      phase: "before_publish",
      reason:
        "The selected wallet is no longer registered for payments on this device.",
    })
    expect(isTargetEligible).toHaveBeenCalledWith({
      walletId: "removed-wallet",
      providerId: "spark",
    })
    expect(sparkPay).toHaveBeenCalledTimes(0)
  })

  it("fails closed before publication when persisted registration cannot be checked", async () => {
    const sparkPay = mock(async () => ({
      status: "paid" as const,
      preimage: "spark-preimage",
    }))
    const coordinator = new WalletPaymentCoordinator(
      new WalletProviderRegistry([registeredProvider("spark", sparkPay)]),
      {
        isTargetEligible: async () => {
          throw new Error("IndexedDB unavailable")
        },
      }
    )

    await expect(
      coordinator.payInvoice(
        { walletId: "spark-personal", providerId: "spark" },
        {
          invoice: "lnbc1invoice",
          amountMsats: 21_000,
          idempotencyKey: "attempt-storage-failed",
          timeoutMs: 30_000,
          appId: "market",
        }
      )
    ).resolves.toEqual({
      status: "failed",
      phase: "before_publish",
      reason: "The selected wallet registration could not be verified.",
    })
    expect(sparkPay).toHaveBeenCalledTimes(0)
  })

  it("rejects duplicate provider registrations instead of shadowing adapters", () => {
    const provider = registeredProvider("spark", async () => ({
      status: "paid",
      preimage: "preimage",
    }))
    expect(() => new WalletProviderRegistry([provider, provider])).toThrow(
      'Wallet provider "spark" is already registered.'
    )
  })

  it("resolves the selected NWC wallet's keyed session inside its provider adapter", async () => {
    const payInvoice = mock(async () => ({
      preimage: "nwc-preimage",
      fees_paid: 3,
    }))
    __buyerNwcSessionTestInternals.__setClientFactory(
      () =>
        ({
          getInfo: async () => ({
            methods: ["pay_invoice"],
            network: "mainnet",
          }),
          getBalance: async () => ({ balance: 0 }),
          payInvoice,
          close: () => undefined,
          pool: {
            ensureRelay: async () => undefined,
          },
        }) as never
    )
    const session = getBuyerNwcSession(NWC_WALLET_ID)
    session.setConnection(NWC_CONNECTION)
    await session.warm()

    const result = await marketAdapterCoordinator.payInvoice(
      { walletId: NWC_WALLET_ID, providerId: "nwc" },
      {
        invoice: "lnbc1test",
        amountMsats: 1_000,
        idempotencyKey: "attempt-nwc",
        timeoutMs: 1_000,
        appId: "market",
      }
    )

    expect(result).toEqual({
      status: "paid",
      preimage: "nwc-preimage",
      paymentHash: undefined,
      feeMsats: 3,
    })
    expect(payInvoice).toHaveBeenCalledTimes(1)
  })

  it("fails before publication when live NWC info reports a different network", async () => {
    const payInvoice = mock(async () => ({
      preimage: "wrong-network-preimage",
      fees_paid: 3,
    }))
    __buyerNwcSessionTestInternals.__setClientFactory(
      () =>
        ({
          getInfo: async () => ({
            methods: ["pay_invoice"],
            network: "testnet",
          }),
          getBalance: async () => ({ balance: 0 }),
          payInvoice,
          close: () => undefined,
          pool: {
            ensureRelay: async () => undefined,
          },
        }) as never
    )
    const session = getBuyerNwcSession(NWC_WALLET_ID)
    session.setConnection(NWC_CONNECTION)
    await session.warm()

    const result = await marketAdapterCoordinator.payInvoice(
      { walletId: NWC_WALLET_ID, providerId: "nwc" },
      {
        invoice: "lnbc1test",
        amountMsats: 1_000,
        idempotencyKey: "attempt-wrong-network",
        timeoutMs: 1_000,
        appId: "market",
      }
    )

    expect(result).toEqual({
      status: "failed",
      phase: "before_publish",
      reason:
        "This Connected Wallet uses testnet, but Market is using mainnet.",
    })
    expect(payInvoice).toHaveBeenCalledTimes(0)
  })

  it("fails before publication until live NWC info is available", async () => {
    const payInvoice = mock(async () => ({
      preimage: "unverified-preimage",
      fees_paid: 3,
    }))
    __buyerNwcSessionTestInternals.__setClientFactory(
      () =>
        ({
          getInfo: async () => ({
            methods: ["pay_invoice"],
            network: "mainnet",
          }),
          getBalance: async () => ({ balance: 0 }),
          payInvoice,
          close: () => undefined,
          pool: {
            ensureRelay: async () => undefined,
          },
        }) as never
    )
    getBuyerNwcSession(NWC_WALLET_ID).setConnection(NWC_CONNECTION)

    const result = await marketAdapterCoordinator.payInvoice(
      { walletId: NWC_WALLET_ID, providerId: "nwc" },
      {
        invoice: "lnbc1test",
        amountMsats: 1_000,
        idempotencyKey: "attempt-before-live-info",
        timeoutMs: 1_000,
        appId: "market",
      }
    )

    expect(result).toEqual({
      status: "failed",
      phase: "before_publish",
      reason:
        "Live Connected Wallet information is unavailable. Reconnect it before paying.",
    })
    expect(payInvoice).toHaveBeenCalledTimes(0)
  })

  it("fails before publication when live NWC info lacks pay_invoice", async () => {
    const payInvoice = mock(async () => ({
      preimage: "unsupported-preimage",
      fees_paid: 3,
    }))
    __buyerNwcSessionTestInternals.__setClientFactory(
      () =>
        ({
          getInfo: async () => ({
            methods: ["get_balance"],
            network: "mainnet",
          }),
          getBalance: async () => ({ balance: 0 }),
          payInvoice,
          close: () => undefined,
          pool: {
            ensureRelay: async () => undefined,
          },
        }) as never
    )
    const session = getBuyerNwcSession(NWC_WALLET_ID)
    session.setConnection(NWC_CONNECTION)
    await session.warm()

    const result = await marketAdapterCoordinator.payInvoice(
      { walletId: NWC_WALLET_ID, providerId: "nwc" },
      {
        invoice: "lnbc1test",
        amountMsats: 1_000,
        idempotencyKey: "attempt-unsupported",
        timeoutMs: 1_000,
        appId: "market",
      }
    )

    expect(result).toEqual({
      status: "failed",
      phase: "before_publish",
      reason:
        "This Connected Wallet does not support outgoing payments via NWC.",
    })
    expect(payInvoice).toHaveBeenCalledTimes(0)
  })

  it("keeps an unclassified post-publication NWC rejection ambiguous", async () => {
    __buyerNwcSessionTestInternals.__setClientFactory(
      () =>
        ({
          getInfo: async () => ({
            methods: ["pay_invoice"],
            network: "mainnet",
          }),
          getBalance: async () => ({ balance: 0 }),
          payInvoice: async () => {
            throw new Nip47WalletError("Unclassified wallet response", "OTHER")
          },
          close: () => undefined,
          pool: {
            ensureRelay: async () => undefined,
          },
        }) as never
    )
    const session = getBuyerNwcSession(NWC_WALLET_ID)
    session.setConnection(NWC_CONNECTION)
    await session.warm()

    const result = await marketAdapterCoordinator.payInvoice(
      { walletId: NWC_WALLET_ID, providerId: "nwc" },
      {
        invoice: "lnbc1test",
        amountMsats: 1_000,
        idempotencyKey: "attempt-ambiguous",
        timeoutMs: 1_000,
        appId: "market",
      }
    )

    expect(result).toMatchObject({
      status: "ambiguous",
      reason: "OTHER: Unclassified wallet response",
    })
  })

  it("keeps PAYMENT_FAILED ambiguous even when its message looks like a refusal", async () => {
    __buyerNwcSessionTestInternals.__setClientFactory(
      () =>
        ({
          getInfo: async () => ({
            methods: ["pay_invoice"],
            network: "mainnet",
          }),
          getBalance: async () => ({ balance: 0 }),
          payInvoice: async () => {
            throw new Nip47WalletError(
              "insufficient capacity on all routes",
              "PAYMENT_FAILED"
            )
          },
          close: () => undefined,
          pool: {
            ensureRelay: async () => undefined,
          },
        }) as never
    )
    const session = getBuyerNwcSession(NWC_WALLET_ID)
    session.setConnection(NWC_CONNECTION)
    await session.warm()

    await expect(
      marketAdapterCoordinator.payInvoice(
        { walletId: NWC_WALLET_ID, providerId: "nwc" },
        {
          invoice: "lnbc1test",
          amountMsats: 1_000,
          idempotencyKey: "attempt-payment-failed",
          timeoutMs: 1_000,
          appId: "market",
        }
      )
    ).resolves.toMatchObject({
      status: "ambiguous",
      reason: "PAYMENT_FAILED: insufficient capacity on all routes",
    })
  })

  it("keeps a documented NWC refusal retryable", async () => {
    __buyerNwcSessionTestInternals.__setClientFactory(
      () =>
        ({
          getInfo: async () => ({
            methods: ["pay_invoice"],
            network: "mainnet",
          }),
          getBalance: async () => ({ balance: 0 }),
          payInvoice: async () => {
            throw new Nip47WalletError("budget exceeded", "QUOTA_EXCEEDED")
          },
          close: () => undefined,
          pool: {
            ensureRelay: async () => undefined,
          },
        }) as never
    )
    const session = getBuyerNwcSession(NWC_WALLET_ID)
    session.setConnection(NWC_CONNECTION)
    await session.warm()

    await expect(
      marketAdapterCoordinator.payInvoice(
        { walletId: NWC_WALLET_ID, providerId: "nwc" },
        {
          invoice: "lnbc1test",
          amountMsats: 1_000,
          idempotencyKey: "attempt-quota-exceeded",
          timeoutMs: 1_000,
          appId: "market",
        }
      )
    ).resolves.toMatchObject({
      status: "failed",
      phase: "after_publish",
      reason: "QUOTA_EXCEEDED: budget exceeded",
    })
  })
})
