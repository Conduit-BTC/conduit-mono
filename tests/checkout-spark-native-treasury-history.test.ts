import { describe, expect, it } from "bun:test"
import {
  collectCheckoutSparkNativeRetirementEvidence,
  proveCheckoutSparkNativeTreasuryHistory,
  type CheckoutSparkNativeRetirementReader,
} from "@conduit/core"

const NOW = 1_800_000_000_000
function transfer(id: string) {
  return { id, type: 0, status: 5, network: 1, totalValue: 100 }
}
function fixture() {
  const transfers = [
    transfer("attributed-credit"),
    transfer("verified-commerce"),
  ]
  const reader: CheckoutSparkNativeRetirementReader = {
    getTransfers: async () => ({
      transfers: structuredClone(transfers),
      offset: -1,
    }),
    getAvailableBalance: async () => 112n,
    getOwnedBalance: async () => 112n,
    getPendingTransfers: async () => [],
  }
  const input = {
    authenticatedReader: reader,
    walletId: "isolated-checkout-wallet",
    network: "mainnet" as const,
    sparkAddress: "synthetic-checkout-address",
    stateUpdatedAt: NOW - 1,
    expectedTransferIds: transfers.map(({ id }) => id),
    authorizedDebitSats: 112,
    now: () => NOW,
  }
  return { input, reader, transfers }
}

describe("native treasury exact checkout history scope", () => {
  it("proves only the exact attributed remainder with stable complete history", async () => {
    const f = fixture()
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(true)
  })
  it.each([111n, 113n, 0n, 112, undefined])(
    "rejects short, extra or malformed funds: %s",
    async (amount) => {
      const f = fixture()
      f.reader.getAvailableBalance = async () => amount as bigint
      expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
    }
  )
  it("rejects owned/incoming reserves not represented by the available remainder", async () => {
    const f = fixture()
    f.reader.getOwnedBalance = async () => 113n
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
  })
  it("rejects any unknown completed transfer even when balance matches", async () => {
    const f = fixture()
    f.transfers.push(transfer("unattributed-extra-deposit"))
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
  })
  it("rejects pending or changed provider history", async () => {
    const f = fixture()
    f.reader.getPendingTransfers = async () => [
      { ...transfer("late-inbound"), status: 2 },
    ]
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
    f.reader.getPendingTransfers = async () => []
    let reads = 0
    f.reader.getTransfers = async () => ({
      transfers: f.transfers.map((item) => ({
        ...item,
        totalValue: item.totalValue + reads++,
      })),
      offset: -1,
    })
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
  })
  it("pins caller scope against mutation while reading", async () => {
    const f = fixture()
    f.reader.getTransfers = async () => {
      f.input.expectedTransferIds.splice(0)
      f.input.authorizedDebitSats = 113
      return { transfers: structuredClone(f.transfers), offset: -1 }
    }
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(true)
  })
  it("requires the known funding and commerce IDs and preserves authority", async () => {
    const f = fixture()
    f.transfers.pop()
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
    const g = fixture()
    let active = true
    g.reader.getAvailableBalance = async () => {
      active = false
      return 112n
    }
    expect(
      await proveCheckoutSparkNativeTreasuryHistory({
        ...g.input,
        assertCurrent: () => {
          if (!active) throw new Error("Revoked")
        },
      })
    ).toBe(false)
  })
  it("tightens only v4 retirement scope while preserving legacy zero-balance behavior", async () => {
    const f = fixture()
    f.transfers.push(transfer("unknown-completed-transfer"))
    f.reader.getAvailableBalance = async () => 0n
    f.reader.getOwnedBalance = async () => 0n
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).not.toBeNull()
    expect(
      await collectCheckoutSparkNativeRetirementEvidence({
        ...f.input,
        requireExactHistoryScope: true,
      })
    ).toBeNull()
  })
})
