import { afterEach, describe, expect, it } from "bun:test"

import {
  __nwcTestInternals,
  nwcGetInfo,
  nwcMakeInvoice,
  nwcPayInvoice,
  parseNwcUri,
  type NwcConnection,
} from "@conduit/core"

type FakeNwcClient = {
  getInfo: () => Promise<{
    methods: string[]
    alias?: string
    color?: string
    pubkey?: string
    network?: string
    block_height?: number
  }>
  makeInvoice: (request: {
    amount: number
    description?: string
    expiry?: number
  }) => Promise<{
    invoice: string
    payment_hash: string
    amount: number
    created_at: number
    expires_at?: number
  }>
  payInvoice: (request: {
    invoice: string
    amount?: number
    metadata?: Record<string, unknown>
  }) => Promise<{
    preimage: string
    fees_paid: number
  }>
  close: () => void
}

const connection: NwcConnection = {
  walletPubkey:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  secret: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  relays: ["wss://wallet.example"],
}

afterEach(() => {
  __nwcTestInternals.__setNwcClientFactory(null)
})

describe("NWC URI parsing", () => {
  it("parses modern NWC URIs", () => {
    const parsed = parseNwcUri(
      [
        `nostr+walletconnect://${connection.walletPubkey}`,
        `?relay=${encodeURIComponent(connection.relays[0])}`,
        `&secret=${connection.secret}`,
        "&lud16=buyer%40example.com",
      ].join("")
    )

    expect(parsed).toEqual({
      ...connection,
      lud16: "buyer@example.com",
    })
  })

  it("parses legacy NWC URIs used by existing wallet clients", () => {
    const parsed = parseNwcUri(
      [
        `nostrwalletconnect://${connection.walletPubkey}`,
        `?relay=${encodeURIComponent(connection.relays[0])}`,
        `&secret=${connection.secret}`,
      ].join("")
    )

    expect(parsed).toEqual(connection)
  })

  it("rejects URIs without a secret", () => {
    expect(() =>
      parseNwcUri(
        `nostr+walletconnect://${connection.walletPubkey}?relay=${encodeURIComponent(
          connection.relays[0]
        )}`
      )
    ).toThrow("missing secret")
  })
})

describe("NWC SDK adapter", () => {
  it("maps get_info responses and closes the SDK client", async () => {
    let closed = false
    __nwcTestInternals.__setNwcClientFactory(() =>
      fakeClient({
        getInfo: async () => ({
          methods: ["pay_invoice", "get_balance"],
          alias: "Test Wallet",
          color: "#ffcc00",
          pubkey: "wallet-node-pubkey",
          network: "bitcoin",
          block_height: 850_000,
        }),
        close: () => {
          closed = true
        },
      })
    )

    await expect(nwcGetInfo(connection, 100, "market")).resolves.toEqual({
      methods: ["pay_invoice", "get_balance"],
      alias: "Test Wallet",
      color: "#ffcc00",
      pubkey: "wallet-node-pubkey",
      network: "bitcoin",
      blockHeight: 850_000,
    })
    expect(closed).toBe(true)
  })

  it("passes invoice payment details to the SDK and maps payment proof", async () => {
    let request:
      | {
          invoice: string
          amount?: number
          metadata?: Record<string, unknown>
        }
      | undefined

    __nwcTestInternals.__setNwcClientFactory(() =>
      fakeClient({
        payInvoice: async (input) => {
          request = input
          return { preimage: "paid-preimage", fees_paid: 12 }
        },
      })
    )

    await expect(
      nwcPayInvoice(
        connection,
        {
          invoice: minimalBolt11Invoice("lnbc1110n"),
          amountMsats: 111_000,
          metadata: { app: "conduit-market" },
        },
        100,
        "market"
      )
    ).resolves.toEqual({
      preimage: "paid-preimage",
      feeMsats: 12,
    })
    expect(request).toEqual({
      invoice: minimalBolt11Invoice("lnbc1110n"),
      metadata: { app: "conduit-market" },
    })
  })

  it("passes an amount only for amountless invoices", async () => {
    let request:
      | {
          invoice: string
          amount?: number
          metadata?: Record<string, unknown>
        }
      | undefined
    const invoice = minimalBolt11Invoice("lnbc")

    __nwcTestInternals.__setNwcClientFactory(() =>
      fakeClient({
        payInvoice: async (input) => {
          request = input
          return { preimage: "paid-preimage", fees_paid: 0 }
        },
      })
    )

    await nwcPayInvoice(
      connection,
      {
        invoice,
        amountMsats: 111_000,
      },
      100,
      "market"
    )

    expect(request).toEqual({
      invoice,
      amount: 111_000,
    })
  })

  it("rejects mismatched fixed invoice amounts before publishing a pay request", async () => {
    let paymentAttempted = false

    __nwcTestInternals.__setNwcClientFactory(() =>
      fakeClient({
        payInvoice: async () => {
          paymentAttempted = true
          return { preimage: "paid-preimage", fees_paid: 0 }
        },
      })
    )

    await expect(
      nwcPayInvoice(
        connection,
        {
          invoice: minimalBolt11Invoice("lnbc1000n"),
          amountMsats: 111_000,
        },
        100,
        "market"
      )
    ).rejects.toThrow("Amount in invoice does not match amount in request")

    expect(paymentAttempted).toBe(false)
  })

  it("passes invoice generation details to the SDK and maps invoice data", async () => {
    let request:
      | {
          amount: number
          description?: string
          expiry?: number
        }
      | undefined

    __nwcTestInternals.__setNwcClientFactory(() =>
      fakeClient({
        makeInvoice: async (input) => {
          request = input
          return {
            invoice: "lnbc1merchant",
            payment_hash: "payment-hash",
            amount: 50_000,
            created_at: 1_700_000_000,
            expires_at: 1_700_003_600,
          }
        },
      })
    )

    await expect(
      nwcMakeInvoice(
        connection,
        {
          amountMsats: 50_000,
          description: "Order #1",
          expiry: 3_600,
        },
        100,
        "merchant"
      )
    ).resolves.toEqual({
      invoice: "lnbc1merchant",
      paymentHash: "payment-hash",
      amount: 50_000,
      createdAt: 1_700_000_000,
      expiresAt: 1_700_003_600,
    })
    expect(request).toEqual({
      amount: 50_000,
      description: "Order #1",
      expiry: 3_600,
    })
  })

  it("times out SDK calls at the Conduit wrapper boundary", async () => {
    let closed = false
    __nwcTestInternals.__setNwcClientFactory(() =>
      fakeClient({
        getInfo: () => new Promise(() => {}),
        close: () => {
          closed = true
        },
      })
    )

    await expect(nwcGetInfo(connection, 5, "market")).rejects.toThrow(
      "NWC get_info timed out"
    )
    expect(closed).toBe(true)
  })
})

function fakeClient(overrides: Partial<FakeNwcClient>): FakeNwcClient {
  return {
    getInfo: async () => ({ methods: [] }),
    makeInvoice: async () => ({
      invoice: "lnbc1default",
      payment_hash: "hash",
      amount: 1,
      created_at: 1,
    }),
    payInvoice: async () => ({ preimage: "preimage", fees_paid: 0 }),
    close: () => {},
    ...overrides,
  }
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [
  0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3,
]

function minimalBolt11Invoice(hrp: string): string {
  const timestampWords = [0, 0, 0, 0, 0, 0, 1]
  const checksum = createBech32Checksum(hrp, timestampWords)
  return `${hrp}1${[...timestampWords, ...checksum]
    .map((word) => BECH32_CHARSET[word]!)
    .join("")}`
}

function createBech32Checksum(hrp: string, words: number[]): number[] {
  const values = [...bech32HrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]
  const polymod = bech32Polymod(values) ^ 1
  const checksum: number[] = []
  for (let index = 0; index < 6; index += 1) {
    checksum.push((polymod >> (5 * (5 - index))) & 31)
  }
  return checksum
}

function bech32Polymod(values: number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index += 1) {
      if ((top >> index) & 1) {
        chk ^= BECH32_GENERATORS[index]!
      }
    }
  }
  return chk
}

function bech32HrpExpand(hrp: string): number[] {
  const values: number[] = []
  for (let index = 0; index < hrp.length; index += 1) {
    values.push(hrp.charCodeAt(index) >> 5)
  }
  values.push(0)
  for (let index = 0; index < hrp.length; index += 1) {
    values.push(hrp.charCodeAt(index) & 31)
  }
  return values
}
