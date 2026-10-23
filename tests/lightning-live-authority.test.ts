import { describe, expect, it } from "bun:test"

import { waitForZapReceipt } from "@conduit/core/protocol/lightning"
import { emptyAccountNetworkLocalState } from "@conduit/core/protocol/account-network-local-state"
import { __resetPublicReaderTestState } from "@conduit/core/protocol/relay-reader"

const ACCOUNT = "a".repeat(64)
const ALLOWED_RELAY = "wss://receipt-allowed.example"
const EXCLUDED_RELAY = "wss://receipt-excluded.example"

function receiptInput() {
  return {
    zapRequestId: "f".repeat(64),
    requestCreatedAt: 1,
    recipientPubkey: ACCOUNT,
    expectedAmountMsats: 1_000,
    expectedLnurl: "lnurl1test",
    expectedInvoice: "lnbc1test",
    lnurlNostrPubkey: "b".repeat(64),
    timeoutMs: 0,
  }
}

function installEmptyRelaySockets() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")
  const opened: string[] = []
  class EmptyRelaySocket {
    static OPEN = 1
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null
    constructor(readonly url: string) {
      opened.push(url)
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.(new Event("open"))
      })
    }
    send(payload: string) {
      const frame = JSON.parse(payload) as [string, string]
      if (frame[0] === "REQ")
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify(["EOSE", frame[1]]),
          } as MessageEvent<string>)
        )
    }
    close() {
      this.readyState = 3
    }
  }
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: EmptyRelaySocket,
  })
  return {
    opened,
    restore: () => {
      __resetPublicReaderTestState()
      if (original) Object.defineProperty(globalThis, "WebSocket", original)
      else Reflect.deleteProperty(globalThis, "WebSocket")
    },
  }
}

describe("Lightning relay-read authority", () => {
  it("stops a public zap receipt read before opening a relay after account change", async () => {
    await expect(
      waitForZapReceipt({
        zapRequestId: "f".repeat(64),
        requestCreatedAt: 1,
        recipientPubkey: "a".repeat(64),
        expectedAmountMsats: 1_000,
        expectedLnurl: "lnurl1test",
        expectedInvoice: "lnbc1test",
        lnurlNostrPubkey: "b".repeat(64),
        relayUrls: ["wss://relay.example"],
        shouldContinue: () => false,
        timeoutMs: 0,
      })
    ).rejects.toMatchObject({ code: "authority_changed" })
  })

  it("observes only eligible secure receipt relays for an account", async () => {
    const sockets = installEmptyRelaySockets()
    try {
      const result = await waitForZapReceipt({
        ...receiptInput(),
        relayUrls: [
          EXCLUDED_RELAY,
          "ws://unsafe-receipt.example",
          ALLOWED_RELAY,
        ],
        accountPubkey: ACCOUNT,
        accountNetworkLocalStateRepository: {
          get: async (pubkey) => ({
            ...emptyAccountNetworkLocalState(pubkey),
            exclusions: [
              {
                relayUrl: EXCLUDED_RELAY,
                committedAt: 1,
                relayListFrontier: { eventId: null, createdAt: null },
                inboxDeclarationFrontier: { eventId: null, createdAt: null },
              },
            ],
          }),
        },
        shouldContinue: () => true,
      })
      expect(result).toBeNull()
      expect(sockets.opened).toEqual([ALLOWED_RELAY])
    } finally {
      sockets.restore()
    }
  })

  it("rechecks the live account predicate before opening a receipt relay", async () => {
    const sockets = installEmptyRelaySockets()
    let current = true
    try {
      await expect(
        waitForZapReceipt({
          ...receiptInput(),
          relayUrls: [ALLOWED_RELAY],
          accountPubkey: ACCOUNT,
          accountNetworkLocalStateRepository: {
            get: async (pubkey) => {
              current = false
              return emptyAccountNetworkLocalState(pubkey)
            },
          },
          shouldContinue: () => current,
        })
      ).rejects.toMatchObject({ code: "authority_changed" })
      expect(sockets.opened).toEqual([])
    } finally {
      sockets.restore()
    }
  })
})
