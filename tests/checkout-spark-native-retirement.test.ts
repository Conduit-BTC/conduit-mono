import { describe, expect, it } from "bun:test"
import {
  collectCheckoutSparkNativeRetirementEvidence,
  type CheckoutSparkNativeRetirementReader,
} from "../packages/core/src/protocol/checkout-spark-native-retirement"

const NOW = 1_800_000_000_000
const TRANSFER_IDS = ["funding-transfer", "merchant-transfer", "fee-transfer"]
const TYPES = [0, 1, 2, 3, 4, 5, 30, 40]

function transfer(id: string, type = 0) {
  return { id, type, status: 5, network: 1, totalValue: 100 }
}

function fixture() {
  const calls: string[] = []
  const transfers = TRANSFER_IDS.map((id) => transfer(id))
  const reader: CheckoutSparkNativeRetirementReader = {
    async getTransfers(request) {
      expect(request.sparkAddress).toBe("synthetic-checkout-address")
      expect([...request.types].sort((a, b) => a - b)).toEqual(TYPES)
      calls.push("history")
      return { transfers: structuredClone(transfers), offset: -1 }
    },
    async getAvailableBalance() {
      calls.push("available")
      return 0n
    },
    async getOwnedBalance() {
      calls.push("owned")
      return 0n
    },
    async getPendingTransfers() {
      calls.push("pending")
      return []
    },
  }
  const input = {
    authenticatedReader: reader,
    walletId: "checkout-wallet",
    network: "mainnet" as const,
    sparkAddress: "synthetic-checkout-address",
    stateUpdatedAt: NOW - 1,
    expectedTransferIds: [...TRANSFER_IDS],
    now: () => NOW,
  }
  return { input, reader, calls, transfers }
}

describe("authenticated native successful-retirement evidence", () => {
  it("returns minimal terminal evidence only after native success history and fresh zero funds", async () => {
    const f = fixture()
    expect(await collectCheckoutSparkNativeRetirementEvidence(f.input)).toEqual(
      {
        walletId: "checkout-wallet",
        network: "mainnet",
        observedAt: NOW,
        availableSats: 0,
        ownedSats: 0,
        incomingSats: 0,
        fundingReceiveTerminal: true,
        sendHistoryTerminal: true,
        claimsTerminal: true,
        refundsTerminal: true,
      }
    )
    expect(f.calls.indexOf("available")).toBeGreaterThan(
      f.calls.lastIndexOf("history")
    )
    expect(f.calls.indexOf("owned")).toBeGreaterThan(
      f.calls.lastIndexOf("history")
    )
    expect(f.calls.indexOf("pending")).toBeGreaterThan(
      f.calls.lastIndexOf("history")
    )
  })

  it("retains recovery when a known successful transfer is absent from authenticated history", async () => {
    const f = fixture()
    f.transfers.pop()
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).toBeNull()
  })

  it.each([-1, 0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 99])(
    "retains recovery for native transfer status %i even when known payouts are complete",
    async (status) => {
      const f = fixture()
      f.transfers.push({ ...transfer("other-transfer", 40), status })
      expect(
        await collectCheckoutSparkNativeRetirementEvidence(f.input)
      ).toBeNull()
    }
  )

  it("reads through a complete authenticated multi-page history before checking funds", async () => {
    const f = fixture()
    f.reader.getTransfers = async ({ offset }) => ({
      transfers: offset === 0 ? f.transfers.slice(0, 1) : f.transfers.slice(1),
      offset: offset === 0 ? 1 : -1,
    })
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).not.toBeNull()
  })

  it("retains recovery on duplicated or conflicting transfer records across pages", async () => {
    const f = fixture()
    f.reader.getTransfers = async ({ offset }) => ({
      transfers: offset === 0 ? f.transfers : [transfer(TRANSFER_IDS[0]!, 2)],
      offset: offset === 0 ? 3 : -1,
    })
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).toBeNull()
  })

  it("retains recovery when history changes between complete scans", async () => {
    const f = fixture()
    let reads = 0
    f.reader.getTransfers = async () => ({
      transfers: [
        ...f.transfers,
        ...(reads++ === 0 ? [] : [transfer("new-transfer")]),
      ],
      offset: -1,
    })
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).toBeNull()
  })

  it.each([NaN, Infinity, 0.5])(
    "retains recovery on malformed pagination cursor %s",
    async (offset) => {
      const f = fixture()
      f.reader.getTransfers = async () => ({ transfers: f.transfers, offset })
      expect(
        await collectCheckoutSparkNativeRetirementEvidence(f.input)
      ).toBeNull()
    }
  )

  it.each([
    { type: 99 },
    { type: -1 },
    { network: 2 },
    { network: 0 },
    { id: "" },
    { id: " padded " },
    { totalValue: -1 },
    { totalValue: NaN },
    { totalValue: 0.5 },
    { totalValue: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    "retains recovery on unsupported or malformed native transfer %j",
    async (change) => {
      const f = fixture()
      f.transfers.push({ ...transfer("additional-transfer"), ...change })
      expect(
        await collectCheckoutSparkNativeRetirementEvidence(f.input)
      ).toBeNull()
    }
  )

  it.each([[], [TRANSFER_IDS[0]!], [TRANSFER_IDS[0]!, TRANSFER_IDS[0]!]])(
    "does not produce funding-and-payout completion from an incomplete expected set %j",
    async (expectedTransferIds) => {
      const f = fixture()
      expect(
        await collectCheckoutSparkNativeRetirementEvidence({
          ...f.input,
          expectedTransferIds,
        })
      ).toBeNull()
    }
  )

  it("retains recovery when the final observation is not newer than persisted settlement state", async () => {
    const f = fixture()
    f.input.now = () => f.input.stateUpdatedAt
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).toBeNull()
  })

  it.each([
    "getTransfers",
    "getAvailableBalance",
    "getOwnedBalance",
    "getPendingTransfers",
  ] as const)(
    "returns no evidence when %s fails without exposing provider diagnostics",
    async (method) => {
      const f = fixture()
      f.reader[method] = async () => {
        throw new Error("Synthetic private provider detail")
      }
      expect(
        await collectCheckoutSparkNativeRetirementEvidence(f.input)
      ).toBeNull()
    }
  )

  it("retains recovery if actor authority changes during a provider read", async () => {
    const f = fixture()
    let active = true
    f.reader.getOwnedBalance = async () => {
      active = false
      return 0n
    }
    expect(
      await collectCheckoutSparkNativeRetirementEvidence({
        ...f.input,
        assertCurrent: () => {
          if (!active) throw new Error("Session changed")
        },
      })
    ).toBeNull()
  })

  it("pins the exact wallet, network, required transfers and freshness bound before reading", async () => {
    const f = fixture()
    const expectedWallet = f.input.walletId
    const read = f.reader.getTransfers
    f.reader.getTransfers = async (request) => {
      const result = await read(request)
      f.input.walletId = "changed-wallet"
      f.input.expectedTransferIds.splice(0)
      f.input.stateUpdatedAt = 0
      return result
    }
    const evidence = await collectCheckoutSparkNativeRetirementEvidence(f.input)
    expect(evidence?.walletId).toBe(expectedWallet)
  })

  it("retains recovery on oversized history pages or malformed pending results", async () => {
    const oversized = fixture()
    oversized.transfers.push(
      ...Array.from({ length: 100 }, (_, index) => transfer(`extra-${index}`))
    )
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(oversized.input)
    ).toBeNull()
    const malformed = fixture()
    malformed.reader.getPendingTransfers = async () =>
      ({ length: 0 }) as unknown as Awaited<
        ReturnType<CheckoutSparkNativeRetirementReader["getPendingTransfers"]>
      >
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(malformed.input)
    ).toBeNull()
  })

  it("retains recovery if the clock rolls backward during native observations", async () => {
    const f = fixture()
    let reads = 0
    f.input.now = () => (reads++ === 0 ? NOW + 10 : NOW)
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).toBeNull()
  })

  it("accepts all eight completed native types on the exact regtest network", async () => {
    const f = fixture()
    f.transfers.push(...TYPES.map((type) => transfer(`internal-${type}`, type)))
    for (const record of f.transfers) record.network = 2
    expect(
      await collectCheckoutSparkNativeRetirementEvidence({
        ...f.input,
        network: "regtest",
      })
    ).toMatchObject({ network: "regtest" })
  })

  it("uses opaque forward cursors and the SDK's negative end-of-history convention", async () => {
    const f = fixture()
    f.reader.getTransfers = async ({ offset }) => ({
      transfers: offset === 0 ? f.transfers.slice(0, 1) : f.transfers.slice(1),
      offset: offset === 0 ? 50 : -2,
    })
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).not.toBeNull()
  })

  it.each(["repeated", "backward", "truncated"] as const)(
    "retains recovery on %s history pagination",
    async (mode) => {
      const f = fixture()
      let pages = 0
      f.reader.getTransfers = async ({ offset }) => {
        pages++
        return {
          transfers: offset === 0 ? f.transfers : [transfer(`extra-${offset}`)],
          offset:
            mode === "repeated"
              ? offset
              : mode === "backward" && offset > 0
                ? 0
                : offset + 1,
        }
      }
      expect(
        await collectCheckoutSparkNativeRetirementEvidence(f.input)
      ).toBeNull()
      expect(pages).toBeLessThanOrEqual(20)
      expect(f.calls).not.toContain("available")
    }
  )

  it.each([1n, -1n, 0, NaN, undefined])(
    "retains recovery on nonzero or malformed available/owned funds %s",
    async (amount) => {
      for (const method of [
        "getAvailableBalance",
        "getOwnedBalance",
      ] as const) {
        const f = fixture()
        f.reader[method] = async () => amount as bigint
        expect(
          await collectCheckoutSparkNativeRetirementEvidence(f.input)
        ).toBeNull()
      }
    }
  )

  it("retains recovery for pending inbound transfers observed after zero-funds reads", async () => {
    const f = fixture()
    f.reader.getPendingTransfers = async () => [
      { ...transfer("late-inbound"), status: 2 },
    ]
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).toBeNull()
    expect(f.calls).toContain("available")
    expect(f.calls).toContain("owned")
  })

  it.each(["walletId", "sparkAddress"] as const)(
    "rejects missing %s before calling a provider",
    async (field) => {
      const f = fixture()
      expect(
        await collectCheckoutSparkNativeRetirementEvidence({
          ...f.input,
          [field]: "",
        })
      ).toBeNull()
      expect(f.calls).toEqual([])
    }
  )

  it.each([NaN, Infinity, -1, 0.5])(
    "retains recovery for invalid state observation time %s",
    async (stateUpdatedAt) => {
      const f = fixture()
      expect(
        await collectCheckoutSparkNativeRetirementEvidence({
          ...f.input,
          stateUpdatedAt,
        })
      ).toBeNull()
      expect(f.calls).toEqual([])
    }
  )

  it("does not let a provider mutate an earlier history snapshot to hide a change", async () => {
    const f = fixture()
    let reads = 0
    f.reader.getTransfers = async () => {
      if (reads++ > 0) f.transfers[0]!.totalValue += 1
      return { transfers: f.transfers, offset: -1 }
    }
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(f.input)
    ).toBeNull()
  })
})
