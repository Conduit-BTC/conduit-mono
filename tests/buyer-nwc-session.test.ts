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
  getBalance: () => Promise<{
    balance: number
  }>
  getBudget?: () => Promise<
    | {
        used_budget: number
        total_budget: number
        renews_at?: number
        renewal_period: string
      }
    | Record<string, never>
  >
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
const NEXT_NWC_URI =
  "nostr+walletconnect://" +
  "c".repeat(64) +
  "?relay=wss%3A%2F%2Fnext-wallet.example&secret=" +
  "d".repeat(64)
const nextConnection = parseNwcUri(NEXT_NWC_URI)

class Nip47PublishError extends Error {}
class Nip47ReplyTimeoutError extends Error {}
class Nip47WalletError extends Error {
  code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

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

  it("keeps balance unavailable and never calls get_balance when capability is missing", async () => {
    let balanceCalls = 0

    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        getInfo: async () => ({ methods: ["pay_invoice"] }),
        getBalance: async () => {
          balanceCalls += 1
          return { balance: 10_000 }
        },
      })
    )

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await session.warm()
    await flushPromises()

    expect(balanceCalls).toBe(0)
    expect(session.getSnapshot().balance).toEqual({
      status: "unavailable",
      balanceMsats: null,
      fetchedAt: null,
      error: null,
    })

    await session.refreshBalance()
    expect(balanceCalls).toBe(0)
  })

  it("does not refresh advertised balances during warm or payment probes", async () => {
    let balanceCalls = 0

    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        getInfo: async () => ({ methods: ["pay_invoice", "get_balance"] }),
        getBalance: async () => ({
          balance: ++balanceCalls === 1 ? 25_000 : 19_000,
        }),
        payInvoice: async () => ({ preimage: "paid-preimage", fees_paid: 1 }),
      })
    )

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await session.warm()
    await flushPromises()
    expect(balanceCalls).toBe(0)
    expect(session.getSnapshot().balance).toEqual({
      status: "unchecked",
      balanceMsats: null,
      fetchedAt: null,
      error: null,
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
    await flushPromises()

    expect(balanceCalls).toBe(0)
    expect(session.getSnapshot().balance).toEqual({
      status: "unchecked",
      balanceMsats: null,
      fetchedAt: null,
      error: null,
    })

    await session.refreshBalance()
    expect(balanceCalls).toBe(1)
    expect(session.getSnapshot().balance).toMatchObject({
      status: "available",
      balanceMsats: 25_000,
      error: null,
    })
  })

  it("keeps the newest balance refresh when same-wallet requests overlap", async () => {
    const firstBalance = deferred<{ balance: number }>()
    const secondBalance = deferred<{ balance: number }>()
    let balanceCalls = 0

    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        getInfo: async () => ({ methods: ["pay_invoice", "get_balance"] }),
        getBalance: () => {
          balanceCalls += 1
          return balanceCalls === 1
            ? firstBalance.promise
            : secondBalance.promise
        },
      })
    )

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await session.warm()
    await flushPromises()
    expect(balanceCalls).toBe(0)

    const firstRefresh = session.refreshBalance()
    await flushPromises()
    expect(balanceCalls).toBe(1)

    const secondRefresh = session.refreshBalance()
    await flushPromises()
    expect(balanceCalls).toBe(2)

    secondBalance.resolve({ balance: 20_000 })
    await secondRefresh
    expect(session.getSnapshot().balance).toMatchObject({
      status: "available",
      balanceMsats: 20_000,
    })

    firstBalance.resolve({ balance: 30_000 })
    await firstRefresh
    await flushPromises()

    expect(session.getSnapshot().balance).toMatchObject({
      status: "available",
      balanceMsats: 20_000,
    })
  })

  it("clears balance state when the wallet disconnects", async () => {
    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        getInfo: async () => ({ methods: ["pay_invoice", "get_balance"] }),
        getBalance: async () => ({ balance: 25_000 }),
      })
    )

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await session.warm()
    await session.refreshBalance()
    await flushPromises()
    expect(session.getSnapshot().balance.balanceMsats).toBe(25_000)

    session.setConnection(null)

    expect(session.getSnapshot().balance).toEqual({
      status: "unchecked",
      balanceMsats: null,
      fetchedAt: null,
      error: null,
    })
  })

  it("refreshes advertised wallet budget with balance readiness", async () => {
    let budgetCalls = 0

    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        getInfo: async () => ({
          methods: ["pay_invoice", "get_balance", "get_budget"],
        }),
        getBalance: async () => ({ balance: 50_000 }),
        getBudget: async () => {
          budgetCalls += 1
          return {
            used_budget: 10_000,
            total_budget: 40_000,
            renews_at: 1_700_000_000,
            renewal_period: "daily",
          }
        },
      })
    )

    const session = new BuyerNwcSession()
    session.setConnection(connection)

    await session.warm()
    await session.refreshBalance()
    await flushPromises()

    expect(budgetCalls).toBe(1)
    expect(session.getSnapshot().budget).toMatchObject({
      status: "available",
      usedMsats: 10_000,
      totalMsats: 40_000,
      remainingMsats: 30_000,
      renewsAt: 1_700_000_000,
      renewalPeriod: "daily",
      error: null,
    })
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

  it("ignores a stale warm result after the wallet is disconnected", async () => {
    let resolveInfo:
      | ((value: { methods: string[]; alias?: string }) => void)
      | null = null

    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        pool: undefined,
        getInfo: () =>
          new Promise((resolve) => {
            resolveInfo = resolve
          }),
      })
    )

    const session = new BuyerNwcSession()
    const statuses: string[] = []
    session.subscribe((snapshot) => {
      statuses.push(snapshot.status)
    })

    session.setConnection(connection)
    const warmPromise = session.warm()
    await Promise.resolve()

    expect(resolveInfo).toBeFunction()
    session.setConnection(null)
    resolveInfo?.({ methods: ["pay_invoice"], alias: "Recovered too late" })
    await warmPromise

    expect(session.getSnapshot()).toMatchObject({
      status: "disconnected",
      connection: null,
      info: null,
      error: null,
    })
    expect(statuses).toEqual([
      "disconnected",
      "unreachable",
      "warming",
      "disconnected",
    ])
  })

  it("ignores a stale warm result after the wallet is replaced", async () => {
    const resolvers = new Map<
      string,
      (value: { methods: string[]; alias?: string }) => void
    >()

    __buyerNwcSessionTestInternals.__setClientFactory((clientConnection) =>
      fakeClient({
        pool: undefined,
        getInfo: () =>
          new Promise((resolve) => {
            resolvers.set(clientConnection.walletPubkey, resolve)
          }),
      })
    )

    const session = new BuyerNwcSession()
    const snapshots: string[] = []
    session.subscribe((snapshot) => {
      snapshots.push(
        `${snapshot.status}:${snapshot.connection?.walletPubkey.slice(0, 1) ?? "-"}:${snapshot.info?.alias ?? "-"}`
      )
    })

    session.setConnection(connection)
    const staleWarm = session.warm()
    await Promise.resolve()

    session.setConnection(nextConnection)
    const currentWarm = session.warm()
    await Promise.resolve()

    resolvers.get(nextConnection.walletPubkey)?.({
      methods: ["pay_invoice"],
      alias: "Current wallet",
    })
    await currentWarm

    resolvers.get(connection.walletPubkey)?.({
      methods: ["pay_invoice"],
      alias: "Stale wallet",
    })
    await staleWarm

    expect(session.getSnapshot()).toMatchObject({
      status: "reachable",
      connection: nextConnection,
      info: { alias: "Current wallet" },
    })
    expect(snapshots).not.toContain("reachable:a:Stale wallet")
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

  it("does not let failed relay preconnect skip payment publish", async () => {
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
    ).resolves.toMatchObject({
      status: "paid",
      preimage: "should-not-pay",
    })

    expect(relayTimeouts).toEqual([10_000, 15_000, 20_000])
    expect(payCalls).toBe(1)
  })

  it("returns pre_publish_failed when the SDK cannot publish payment", async () => {
    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        payInvoice: async () => {
          throw new Nip47PublishError("failed to publish")
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
  })

  it("treats SDK reply timeout as ambiguous after-publish failure", async () => {
    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        payInvoice: async () => {
          throw new Nip47ReplyTimeoutError("reply timed out")
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
      status: "published_timeout",
      phase: "after_publish",
      reason: "NWC request timed out.",
    })
  })

  it("includes NIP-47 wallet error codes in safe payment failures", async () => {
    __buyerNwcSessionTestInternals.__setClientFactory(() =>
      fakeClient({
        payInvoice: async () => {
          throw new Nip47WalletError("budget exceeded", "QUOTA_EXCEEDED")
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
      status: "wallet_error",
      phase: "after_publish",
      reason: "QUOTA_EXCEEDED: budget exceeded",
    })
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
    getBalance: async () => ({ balance: 0 }),
    payInvoice: async () => ({ preimage: "preimage", fees_paid: 0 }),
    close: () => {},
    pool: {
      ensureRelay: async () => {},
    },
    ...overrides,
  }
}

async function flushPromises(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}
