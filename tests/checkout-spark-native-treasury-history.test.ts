import { describe, expect, it } from "bun:test"
import {
  collectCheckoutSparkNativeRetirementEvidence,
  proveCheckoutSparkNativeTreasuryHistory,
  type CheckoutSparkNativeRetirementReader,
} from "@conduit/core"

const NOW = 1_800_000_000_000
const amount = (value: number) => ({
  originalValue: value,
  originalUnit: "SATOSHI",
})
function swapRequest(
  primary: string,
  counter: string,
  value: number,
  leaf: string,
  index: number
) {
  return {
    typename: "LeavesSwapRequest",
    id: `swap-request-${index}`,
    status: "SUCCEEDED",
    network: "MAINNET",
    totalAmount: amount(value),
    fee: amount(0),
    outboundTransfer: { sparkId: primary, totalAmount: amount(value) },
    inboundTransfer: { sparkId: counter, totalAmount: amount(value) },
    swapLeaves: [{ leafId: leaf }],
  }
}
function transfer(id: string) {
  return { id, type: 0, status: 5, network: 1, totalValue: 100 }
}
function fixture() {
  const transfers: Awaited<
    ReturnType<CheckoutSparkNativeRetirementReader["getTransfers"]>
  >["transfers"] = [
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

function internalSwapFixture() {
  const f = fixture()
  f.transfers.push(transfer("verified-supplier"))
  f.input.expectedTransferIds.push("verified-supplier")
  const wallet = `02${"11".repeat(32)}`
  const ssp = `03${"22".repeat(32)}`
  const bytes = (key: string) => Uint8Array.from(Buffer.from(key, "hex"))
  const requests = new Map<
    string,
    {
      sparkId: string
      totalAmount: ReturnType<typeof amount>
      userRequest: ReturnType<typeof swapRequest>
    }
  >()
  for (const index of [1, 2]) {
    const primary = `swap-out-${index}`
    const counter = `swap-in-${index}`
    const value = index * 400
    const leaf = `returned-leaf-${index}`
    const request = swapRequest(primary, counter, value, leaf, index)
    for (const [id, type, sender, receiver, leafId] of [
      [primary, 4, wallet, ssp, `sent-leaf-${index}`],
      [counter, 5, ssp, wallet, leaf],
    ] as const) {
      f.transfers.push({
        ...transfer(id),
        type,
        totalValue: value,
        senders: [{ id: `${id}-sender`, identityPublicKey: bytes(sender) }],
        receivers: [
          {
            id: `${id}-receiver`,
            identityPublicKey: bytes(receiver),
            amountSats: value,
            status: 6,
          },
        ],
        leaves: [
          {
            leaf: { id: leafId, value },
            transferSenderId: `${id}-sender`,
            transferReceiverId: `${id}-receiver`,
          },
        ],
      })
      requests.set(id, {
        sparkId: id,
        totalAmount: amount(value),
        userRequest: request,
      })
    }
  }
  f.reader.getInternalSwapEvidence = async ({ sparkAddress, transferId }) => {
    expect(sparkAddress).toBe(f.input.sparkAddress)
    return {
      walletIdentityPublicKey: wallet,
      sspIdentityPublicKey: ssp,
      transfer: structuredClone(requests.get(transferId)),
    }
  }
  return { ...f, wallet, ssp, requests }
}

describe("native treasury exact checkout history scope", () => {
  it("continues after three verified payments and two completed internal denomination swaps", async () => {
    const f = internalSwapFixture()
    expect(f.transfers).toHaveLength(7)
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(true)
  })
  it("uses the same positive pair proof before retiring an exact v4 zero-funds wallet", async () => {
    const f = internalSwapFixture()
    f.transfers.push({ ...transfer("verified-native-treasury"), type: 2 })
    f.input.expectedTransferIds.push("verified-native-treasury")
    f.reader.getAvailableBalance = async () => 0n
    f.reader.getOwnedBalance = async () => 0n
    expect(
      await collectCheckoutSparkNativeRetirementEvidence({
        ...f.input,
        requireExactHistoryScope: true,
      })
    ).not.toBeNull()
    f.requests.get("swap-out-1")!.userRequest.fee = amount(1)
    expect(
      await collectCheckoutSparkNativeRetirementEvidence({
        ...f.input,
        requireExactHistoryScope: true,
      })
    ).toBeNull()
  })
  it("fails closed when fresh exact swap metadata is unavailable", async () => {
    const f = internalSwapFixture()
    delete f.reader.getInternalSwapEvidence
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
    f.reader.getInternalSwapEvidence = async () => null
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
  })
  it.each([
    [
      "fee",
      (request: ReturnType<typeof swapRequest>) => {
        request.fee = amount(1)
      },
    ],
    [
      "unknown request",
      (request: ReturnType<typeof swapRequest>) => {
        request.typename = "LightningSendRequest"
      },
    ],
    [
      "pending request",
      (request: ReturnType<typeof swapRequest>) => {
        request.status = "INBOUND_TRANSFER_CLAIMED"
      },
    ],
    [
      "wrong network",
      (request: ReturnType<typeof swapRequest>) => {
        request.network = "REGTEST"
      },
    ],
    [
      "wrong unit",
      (request: ReturnType<typeof swapRequest>) => {
        request.totalAmount.originalUnit = "MILLISATOSHI"
      },
    ],
    [
      "extra input value",
      (request: ReturnType<typeof swapRequest>) => {
        request.outboundTransfer.totalAmount = amount(401)
      },
    ],
    [
      "partial return",
      (request: ReturnType<typeof swapRequest>) => {
        request.inboundTransfer.totalAmount = amount(399)
      },
    ],
    [
      "expected ID overlap",
      (request: ReturnType<typeof swapRequest>) => {
        request.outboundTransfer.sparkId = "verified-commerce"
      },
    ],
    [
      "missing exact pair",
      (request: ReturnType<typeof swapRequest>) => {
        request.inboundTransfer.sparkId = "unobserved-counter"
      },
    ],
    [
      "same ID twice",
      (request: ReturnType<typeof swapRequest>) => {
        request.inboundTransfer.sparkId = request.outboundTransfer.sparkId
      },
    ],
    [
      "foreign returned leaf",
      (request: ReturnType<typeof swapRequest>) => {
        request.swapLeaves[0]!.leafId = "unrelated-leaf"
      },
    ],
    [
      "duplicated returned leaf",
      (request: ReturnType<typeof swapRequest>) => {
        request.swapLeaves.push(request.swapLeaves[0]!)
      },
    ],
  ] as const)(
    "rejects completed swaps with %s evidence",
    async (_label, mutate) => {
      const f = internalSwapFixture()
      mutate(f.requests.get("swap-out-1")!.userRequest)
      expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
    }
  )
  it("never pairs swaps solely by equal amounts or unrelated IDs", async () => {
    const f = internalSwapFixture()
    f.transfers.find(({ id }) => id === "swap-in-1")!.id =
      "equal-value-but-unrelated"
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
    const g = internalSwapFixture()
    g.requests.get("swap-in-1")!.userRequest = structuredClone(
      g.requests.get("swap-in-1")!.userRequest
    )
    g.requests.get("swap-in-1")!.userRequest.id =
      "different-request-same-values"
    expect(await proveCheckoutSparkNativeTreasuryHistory(g.input)).toBe(false)
  })
  it.each([
    { type: 2 },
    { type: 30 },
    { status: 2 },
    { network: 2 },
    { totalValue: 401 },
    { senders: [] },
    { receivers: [] },
    { leaves: [] },
  ])("rejects incompatible authenticated swap rows %j", async (change) => {
    const f = internalSwapFixture()
    Object.assign(
      f.transfers.find(({ id }) => id === "swap-out-1")!,
      change
    )
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
  })
  it("requires exact terminal single-party identities and leaf edge membership", async () => {
    for (const mode of [
      "receiver",
      "pending",
      "multiparty",
      "leaf-edge",
      "leaf-value",
      "duplicate-leaf",
    ] as const) {
      const f = internalSwapFixture()
      const row = f.transfers.find(({ id }) => id === "swap-in-1")!
      const receivers = row.receivers as {
        id: string
        identityPublicKey: Uint8Array
        status: number
        amountSats: number
      }[]
      const leaves = row.leaves as {
        leaf: { id: string; value: number }
        transferReceiverId: string
      }[]
      if (mode === "receiver") receivers[0]!.identityPublicKey[1] = 9
      if (mode === "pending") receivers[0]!.status = 5
      if (mode === "multiparty") receivers.push(structuredClone(receivers[0]!))
      if (mode === "leaf-edge")
        leaves[0]!.transferReceiverId = "another-receiver"
      if (mode === "leaf-value") leaves[0]!.leaf.value = 399
      if (mode === "duplicate-leaf") leaves.push(structuredClone(leaves[0]!))
      expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
    }
  })
  it("accepts only matching legacy swap pairs with the same positive proof", async () => {
    const f = internalSwapFixture()
    for (const row of f.transfers) {
      if (row.type === 4) row.type = 30
      else if (row.type === 5) row.type = 40
    }
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(true)
  })
  it("snapshots exact request facts before a provider mutates an earlier response", async () => {
    const f = internalSwapFixture()
    let reads = 0
    f.reader.getInternalSwapEvidence = async ({ transferId }) => {
      if (++reads === 5)
        f.requests.get("swap-out-1")!.userRequest.id =
          "changed-after-first-scan"
      return {
        walletIdentityPublicKey: f.wallet,
        sspIdentityPublicKey: f.ssp,
        transfer: f.requests.get(transferId),
      }
    }
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
  })
  it("snapshots historical leaf facts before a provider mutates its shared buffers", async () => {
    const f = internalSwapFixture()
    let scans = 0
    f.reader.getTransfers = async () => {
      if (++scans === 2) {
        const counter = f.transfers.find(({ id }) => id === "swap-in-1")!
        const leaves = counter.leaves as { leaf: { id: string } }[]
        leaves[0]!.leaf.id = "changed-returned-leaf"
        f.requests.get("swap-in-1")!.userRequest.swapLeaves[0]!.leafId =
          "changed-returned-leaf"
      }
      return { transfers: f.transfers, offset: -1 }
    }
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(false)
  })
  it("accepts stable multiple-leaf sums without depending on leaf ordering", async () => {
    const f = internalSwapFixture()
    for (const row of f.transfers.filter(
      ({ type }) => type === 4 || type === 5
    )) {
      const leaves = row.leaves as { leaf: { id: string; value: number } }[]
      const first = leaves[0]!
      first.leaf.value = row.totalValue / 2
      const second = structuredClone(first)
      second.leaf.id = `${first.leaf.id}-second`
      leaves.push(second)
      if (row.type === 5)
        f.requests
          .get(row.id)!
          .userRequest.swapLeaves.push({ leafId: second.leaf.id })
    }
    let scans = 0
    f.reader.getTransfers = async () => {
      if (++scans === 2) {
        for (const row of f.transfers)
          if (Array.isArray(row.leaves)) row.leaves.reverse()
        for (const request of f.requests.values())
          request.userRequest.swapLeaves.reverse()
      }
      return { transfers: structuredClone(f.transfers), offset: -1 }
    }
    expect(await proveCheckoutSparkNativeTreasuryHistory(f.input)).toBe(true)
  })
  it("retains unrelated-activity, balance, pending and authority guards even with proven swaps", async () => {
    const unknown = internalSwapFixture()
    unknown.transfers.push(transfer("unrelated-deposit"))
    expect(await proveCheckoutSparkNativeTreasuryHistory(unknown.input)).toBe(
      false
    )
    const extra = internalSwapFixture()
    extra.reader.getAvailableBalance = async () => 113n
    expect(await proveCheckoutSparkNativeTreasuryHistory(extra.input)).toBe(
      false
    )
    const pending = internalSwapFixture()
    pending.reader.getPendingTransfers = async () => [
      { ...transfer("pending-transfer"), status: 2 },
    ]
    expect(await proveCheckoutSparkNativeTreasuryHistory(pending.input)).toBe(
      false
    )
    const revoked = internalSwapFixture()
    let active = true
    const readEvidence = revoked.reader.getInternalSwapEvidence!
    revoked.reader.getInternalSwapEvidence = async (input) => {
      active = false
      return readEvidence(input)
    }
    expect(
      await proveCheckoutSparkNativeTreasuryHistory({
        ...revoked.input,
        assertCurrent: () => {
          if (!active) throw new Error("Revoked")
        },
      })
    ).toBe(false)
  })
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
