import { describe, expect, it } from "bun:test"
import { decodeLightningInvoicePaymentHash } from "@conduit/core"
import type { NwcLookupInvoiceResult } from "@conduit/core/protocol/nwc"
import { generateSparkMnemonic } from "@conduit/core/wallets/spark-recovery"
import {
  SparkWalletManager,
  type SparkSdkClient,
} from "@conduit/core/wallets/spark-wallet"
import { makeSignedBolt11Fixture } from "./support/signed-bolt11-fixture"

async function fixture() {
  const invoice = makeSignedBolt11Fixture({
    hrp: "lnbc400u",
    createdAt: Math.floor(Date.now() / 1000),
  })
  let fee = 3n
  let releaseReceive: (() => void) | undefined
  let receiveBarrier: Promise<void> | undefined
  let observation: NwcLookupInvoiceResult = {
    type: "incoming",
    state: "pending",
    invoice,
    paymentHash: decodeLightningInvoicePaymentHash(invoice)!,
    amountMsats: 40_000_000,
  }
  const calls: Array<{ invoice: string; requestId?: string }> = []
  const client = {
    async disconnect() {},
    async getInfo() {
      return { balanceSats: 0 }
    },
    async listPayments() {
      return { payments: [] }
    },
    async receivePayment() {
      if (receiveBarrier) await receiveBarrier
      return { paymentRequest: invoice, fee, requestId: "request-1" }
    },
    async lookupReceivingInvoice(invoice: string, requestId?: string) {
      calls.push({ invoice, requestId })
      return observation
    },
  } as SparkSdkClient
  const manager = new SparkWalletManager(
    {
      network: "mainnet",
      async open() {
        return client
      },
    },
    async () => ({ async release() {} })
  )
  await manager.openWithMnemonic({
    walletId: "selected-wallet",
    mnemonic: generateSparkMnemonic(),
    accountNumber: 1,
  })
  return {
    manager,
    calls,
    invoice,
    setFee(next: bigint) {
      fee = next
    },
    observe(next: Partial<NwcLookupInvoiceResult>) {
      observation = { ...observation, ...next }
    },
    delayReceive() {
      receiveBarrier = new Promise<void>((resolve) => {
        releaseReceive = resolve
      })
    },
    releaseReceive() {
      releaseReceive?.()
    },
  }
}

describe("Cash App wallet receive evidence", () => {
  it("retains the provider request and fee and checks the selected wallet's exact invoice", async () => {
    const f = await fixture()
    try {
      const request = await f.manager.receiveLightning("selected-wallet", {
        description: "Receive",
        amountSats: 40_000,
      })
      expect(request).toEqual({
        paymentRequest: f.invoice,
        feeSats: 3,
        requestId: "request-1",
      })
      expect(
        await f.manager.checkLightningReceive("selected-wallet", request)
      ).toBe("pending")
      expect(f.calls).toEqual([{ invoice: f.invoice, requestId: "request-1" }])
      f.observe({ state: "settled", settledAt: Math.floor(Date.now() / 1000) })
      expect(
        await f.manager.checkLightningReceive("selected-wallet", request)
      ).toBe("received")
      await expect(
        f.manager.checkLightningReceive("other-wallet", request)
      ).rejects.toThrow()
    } finally {
      await f.manager.close("selected-wallet")
    }
  })
  for (const change of [
    { type: "outgoing" },
    { invoice: "another-invoice" },
    { paymentHash: "different-hash" },
    { amountMsats: 39_000_000 },
    { settledAt: undefined },
    { settledAt: 1 },
  ] as Array<Partial<NwcLookupInvoiceResult>>) {
    it(`rejects conflicting settlement field ${Object.keys(change)[0]}`, async () => {
      const f = await fixture()
      try {
        const request = await f.manager.receiveLightning("selected-wallet", {
          description: "Receive",
          amountSats: 40_000,
        })
        f.observe({
          state: "settled",
          settledAt: Math.floor(Date.now() / 1000),
          ...change,
        })
        await expect(
          f.manager.checkLightningReceive("selected-wallet", request)
        ).rejects.toThrow()
      } finally {
        await f.manager.close("selected-wallet")
      }
    })
  }
  it("preserves failed status and rejects invalid fees", async () => {
    const f = await fixture()
    try {
      const request = await f.manager.receiveLightning("selected-wallet", {
        description: "Receive",
        amountSats: 40_000,
      })
      f.observe({ state: "failed" })
      expect(
        await f.manager.checkLightningReceive("selected-wallet", request)
      ).toBe("failed")
      for (const fee of [-1n, 9007199254740992n]) {
        f.setFee(fee)
        await expect(
          f.manager.receiveLightning("selected-wallet", {
            description: "Receive",
            amountSats: 40_000,
          })
        ).rejects.toThrow("invalid receive fee")
      }
    } finally {
      await f.manager.close("selected-wallet")
    }
  })
  it("discards an invoice returned after the wallet session closes", async () => {
    const f = await fixture()
    f.delayReceive()
    const result = f.manager.receiveLightning("selected-wallet", {
      description: "Receive",
      amountSats: 40_000,
    })
    const rejected = result.then(
      () => false,
      () => true
    )
    await f.manager.close("selected-wallet")
    f.releaseReceive()
    expect(await rejected).toBe(true)
  })
})
