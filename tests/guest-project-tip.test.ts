import { afterEach, describe, expect, it } from "bun:test"
import { prepareGuestProjectTip } from "../apps/market/src/lib/project-tip"
import { PROJECT_TIP_PAY_REQUEST_URL } from "@conduit/core/protocol/project-tip"
import { makeSignedBolt11Fixture } from "./support/signed-bolt11-fixture"

const originalFetch = globalThis.fetch
const calls: string[] = []
afterEach(() => {
  globalThis.fetch = originalFetch
  calls.length = 0
})

function provider(
  options: {
    hrp?: string
    invalidSignature?: boolean
    createdAt?: number
    maxSendable?: number
  } = {}
) {
  const invoice = makeSignedBolt11Fixture({
    hrp: options.hrp ?? "lnbc1000n",
    createdAt: options.createdAt ?? Math.floor(Date.now() / 1_000),
    invalidSignature: options.invalidSignature,
  })
  globalThis.fetch = (async (input) => {
    const url = String(input)
    calls.push(url)
    if (url === PROJECT_TIP_PAY_REQUEST_URL) {
      return Response.json({
        tag: "payRequest",
        callback:
          "https://conduit.cash/lnurlp/receiver/invoice?nostr=obsolete&lnurl=obsolete",
        minSendable: 100_000,
        maxSendable: options.maxSendable ?? 1_000_000,
        metadata: JSON.stringify([["text/plain", "Tip Conduit"]]),
        allowsNostr: false,
      })
    }
    const callback = new URL(url)
    expect(callback.origin + callback.pathname).toBe(
      "https://conduit.cash/lnurlp/receiver/invoice"
    )
    expect(callback.searchParams.get("amount")).toBe("100000")
    expect(callback.searchParams.has("nostr")).toBe(false)
    expect(callback.searchParams.has("lnurl")).toBe(false)
    expect(callback.searchParams.has("comment")).toBe(false)
    return Response.json({ pr: invoice })
  }) as typeof fetch
  return invoice
}

describe("guest Lightning tips without zap signing", () => {
  it("requests the fixed Conduit recipient's plain invoice without signing or requiring Nostr metadata", async () => {
    const invoice = provider()
    const tip = await prepareGuestProjectTip(100)
    expect(tip.invoice).toBe(invoice)
    expect(tip.amountMsats).toBe(100_000)
    expect(tip.zapRequestId).toBeNull()
    expect(tip.lnurlNostrPubkey).toBeNull()
    expect(tip.relayUrls).toEqual([])
    expect(calls).toHaveLength(2)
    expect(calls.every((url) => !url.includes("/api/project-tip-sign"))).toBe(
      true
    )
  })
  it("rejects an invalid amount before requesting anything", async () => {
    provider()
    await expect(prepareGuestProjectTip(99)).rejects.toThrow()
    expect(calls).toEqual([])
  })
  it("rejects an amount outside the provider range before asking for an invoice", async () => {
    provider({ maxSendable: 99_000 })
    await expect(prepareGuestProjectTip(100)).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })
  for (const [label, options] of [
    ["wrong amount", { hrp: "lnbc2000n" }],
    ["wrong network", { hrp: "lntb1000n" }],
    ["invalid signature", { invalidSignature: true }],
    ["expired invoice", { createdAt: 1_600_000_000 }],
  ] as const) {
    it(`rejects a ${label} before exposing a payable tip`, async () => {
      provider(options)
      await expect(prepareGuestProjectTip(100)).rejects.toThrow()
    })
  }
})
