import { afterEach, describe, expect, it } from "bun:test"

import { parseNwcUri } from "@conduit/core"
import {
  BuyerNwcSession,
  __buyerNwcSessionTestInternals,
} from "../apps/market/src/lib/buyer-nwc-session"

type FakeNwcClient = {
  getInfo: () => Promise<{
    methods: string[]
    alias?: string
    color?: string
    pubkey?: string
    network?: string
    block_height?: number
  }>
  payInvoice: (request: {
    invoice: string
    amount?: number
    metadata?: Record<string, unknown>
  }) => Promise<{
    preimage?: string
    fees_paid?: number
  }>
  close: () => void
  pool?: {
    maxWaitForConnection?: number
    ensureRelay?: (
      url: string,
      params?: { connectionTimeout?: number }
    ) => Promise<unknown>
  }
}

const VALID_NWC_URI =
  "nostr+walletconnect://" +
  "a".repeat(64) +
  "?relay=wss%3A%2F%2Fwallet.example&secret=" +
  "b".repeat(64)
const connection = parseNwcUri(VALID_NWC_URI)

afterEach(() => {
  __buyerNwcSessionTestInternals.__setClientFactory(null)
})

describe("BuyerNwcSession", () => {
  it("warms one client and reuses it for payment", async () => {
    const clients: FakeNwcClient[] = []
    let payCalls = 0

    __buyerNwcSessionTestInternals.__setClientFactory(() => {
      const client = fakeClient({
        getInfo: async () => ({ methods: ["pay_invoice"] }),
        payInvoice: async () => {
          payCalls += 1
          return { preimage: "paid-preimage", fees_paid: 3 }
        },
      })
      clients.push(client)
      return client
    })

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await expect(session.warm()).resolves.toMatchObject({
      status: "reachable",
    })
    await expect(
      session.payInvoice({
        invoice: "lnbc1test",
        amountMsats: 1_000,
        timeoutMs: 100,
        appId: "market",
      })
    ).resolves.toEqual({
      status: "paid",
      preimage: "paid-preimage",
      feeMsats: 3,
    })

    expect(clients.length).toBe(1)
    expect(payCalls).toBe(1)
  })

  it("notifies subscribers when another caller changes the wallet session", async () => {
    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        getInfo: async () => ({ methods: ["pay_invoice"] }),
      })
    )

    const session = new BuyerNwcSession()
    const statuses: string[] = []
    const unsubscribe = session.subscribe((snapshot) => {
      statuses.push(snapshot.status)
    })

    session.setConnection(connection)
    await session.warm()
    unsubscribe()
    session.close()

    expect(statuses).toEqual([
      "disconnected",
      "unreachable",
      "warming",
      "reachable",
    ])
  })

  it("stops notifying subscribers after unsubscribe", () => {
    const session = new BuyerNwcSession()
    const statuses: string[] = []
    const unsubscribe = session.subscribe((snapshot) => {
      statuses.push(snapshot.status)
    })

    unsubscribe()
    session.setConnection(connection)

    expect(statuses).toEqual(["disconnected"])
  })

  it("still attempts payment when warm probing failed", async () => {
    let payCalls = 0

    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        getInfo: async () => {
          throw new Error("relay cold")
        },
        payInvoice: async () => {
          payCalls += 1
          return { preimage: "paid-preimage" }
        },
      })
    )

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await expect(session.warm()).resolves.toMatchObject({
      status: "unreachable",
    })
    await expect(
      session.payInvoice({
        invoice: "lnbc1test",
        amountMsats: 1_000,
        timeoutMs: 100,
        appId: "market",
      })
    ).resolves.toMatchObject({
      status: "paid",
      preimage: "paid-preimage",
    })

    expect(payCalls).toBe(1)
  })

  it("creates a fresh client when retrying after a failed warm probe", async () => {
    const clients: FakeNwcClient[] = []

    __buyerNwcSessionTestInternals.__setClientFactory(() => {
      const client = fakeClient({
        getInfo:
          clients.length === 0
            ? async () => {
                throw new Error("relay cold")
              }
            : async () => ({ methods: ["pay_invoice"] }),
      })
      clients.push(client)
      return client
    })

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await expect(session.warm()).resolves.toMatchObject({
      status: "unreachable",
    })
    await expect(session.warm()).resolves.toMatchObject({
      status: "reachable",
    })

    expect(clients.length).toBe(2)
  })

  it("does not publish payment when fresh wallet info says pay_invoice is unsupported", async () => {
    let payCalls = 0

    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        getInfo: async () => ({ methods: ["get_balance"] }),
        payInvoice: async () => {
          payCalls += 1
          return { preimage: "should-not-pay" }
        },
      })
    )

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await expect(session.warm()).resolves.toMatchObject({
      status: "unsupported",
    })
    await expect(
      session.payInvoice({
        invoice: "lnbc1test",
        amountMsats: 1_000,
        timeoutMs: 100,
        appId: "market",
      })
    ).resolves.toMatchObject({
      status: "pre_publish_failed",
      phase: "before_publish",
    })

    expect(payCalls).toBe(0)
  })

  it("returns pre_publish_failed when no relay can connect before payment publish", async () => {
    let payCalls = 0
    const relayTimeouts: number[] = []

    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        pool: {
          ensureRelay: async (_url, params) => {
            relayTimeouts.push(params?.connectionTimeout ?? 0)
            throw new Error("relay unavailable")
          },
        },
        payInvoice: async () => {
          payCalls += 1
          return { preimage: "should-not-pay" }
        },
      })
    )

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await expect(
      session.payInvoice({
        invoice: "lnbc1test",
        amountMsats: 1_000,
        timeoutMs: 100,
        appId: "market",
      })
    ).resolves.toEqual({
      status: "pre_publish_failed",
      phase: "before_publish",
      reason: "Failed to connect to NWC relay(s).",
    })

    expect(relayTimeouts).toEqual([10_000, 15_000, 20_000])
    expect(payCalls).toBe(0)
  })

  it("treats timeout after pay_invoice starts as ambiguous after-publish failure", async () => {
    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        payInvoice: () => new Promise(() => {}),
      })
    )

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await expect(
      session.payInvoice({
        invoice: "lnbc1test",
        amountMsats: 1_000,
        timeoutMs: 5,
        appId: "market",
      })
    ).resolves.toEqual({
      status: "published_timeout",
      phase: "after_publish",
      reason: "NWC pay_invoice timed out after 5ms",
    })
  })
})

function fakeClient(overrides: Partial<FakeNwcClient>): FakeNwcClient {
  return {
    getInfo: async () => ({ methods: ["pay_invoice"] }),
    payInvoice: async () => ({ preimage: "preimage", fees_paid: 0 }),
    close: () => {},
    pool: {
      ensureRelay: async () => {},
    },
    ...overrides,
  }
}
