import { describe, expect, it } from "bun:test"
import {
  __resetNdkTestState,
  fetchEventsFanoutDetailed,
} from "../packages/core/src/protocol/ndk"
import {
  emptyAccountNetworkLocalState,
  type AccountNetworkLocalStateRepository,
} from "../packages/core/src/protocol/account-network-local-state"

const ACCOUNT_A = "a".repeat(64)
const ACCOUNT_B = "b".repeat(64)

function accountNetworkState(
  pubkey: string,
  excludedRelayUrls: readonly string[],
  preferredRelayOrder: readonly string[] = []
) {
  const state = emptyAccountNetworkLocalState(pubkey)
  return {
    ...state,
    exclusions: excludedRelayUrls.map((relayUrl, index) => ({
      relayUrl,
      committedAt: 1_700_000_000_000 + index,
      relayListFrontier: { eventId: null, createdAt: null },
      inboxDeclarationFrontier: { eventId: null, createdAt: null },
    })),
    preferredRelayOrder: [...preferredRelayOrder],
  }
}

function installEoseWebSocket(): {
  openedUrls: string[]
  restore: () => void
} {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocket"
  )
  const openedUrls: string[] = []

  class EoseWebSocket {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = EoseWebSocket.CONNECTING
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onclose: ((event: Event) => void) | null = null

    constructor(readonly url: string) {
      openedUrls.push(url)
      queueMicrotask(() => {
        if (this.readyState !== EoseWebSocket.CONNECTING) return
        this.readyState = EoseWebSocket.OPEN
        this.onopen?.(new Event("open"))
      })
    }

    send(payload: string): void {
      const frame = JSON.parse(payload) as [string, string]
      if (frame[0] !== "REQ") return
      queueMicrotask(() => {
        if (this.readyState !== EoseWebSocket.OPEN) return
        this.onmessage?.({
          data: JSON.stringify(["EOSE", frame[1]]),
        } as MessageEvent<string>)
      })
    }

    close(): void {
      if (this.readyState === EoseWebSocket.CLOSED) return
      this.readyState = EoseWebSocket.CLOSED
    }
  }

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: EoseWebSocket,
  })

  return {
    openedUrls,
    restore: () => {
      __resetNdkTestState()
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "WebSocket", originalDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, "WebSocket")
      }
    },
  }
}

describe("NDK network boundary", () => {
  it("applies whole-relay exclusions only to the explicit account", async () => {
    const relayUrl = "wss://stale-read-plan.conduit.market"
    const opened = installEoseWebSocket()
    const queriedPubkeys: string[] = []
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        queriedPubkeys.push(pubkey)
        return accountNetworkState(
          pubkey,
          pubkey === ACCOUNT_A ? [relayUrl] : []
        )
      },
    }

    try {
      const excluded = await fetchEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [relayUrl],
          accountPubkey: ACCOUNT_A,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )
      const otherAccount = await fetchEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [relayUrl],
          accountPubkey: ACCOUNT_B,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )
      const publicRead = await fetchEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls: [relayUrl],
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )

      expect(excluded.relays).toEqual([])
      expect(otherAccount.relays).toEqual([
        {
          relayUrl,
          status: "success",
          eventCount: 0,
        },
      ])
      expect(publicRead.relays).toEqual(otherAccount.relays)
      expect(opened.openedUrls).toEqual([relayUrl, relayUrl])
      expect(queriedPubkeys).toEqual([
        ACCOUNT_A,
        ACCOUNT_A,
        ACCOUNT_B,
        ACCOUNT_B,
      ])
    } finally {
      opened.restore()
    }
  })

  it("re-reads eligibility when queued fanout work reaches its relay slot", async () => {
    const relayUrls = Array.from(
      { length: 9 },
      (_, index) => `wss://queued-${index}.conduit.market`
    )
    const removedRelayUrl = relayUrls.at(-1)!
    const opened = installEoseWebSocket()
    let durableReads = 0
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) => {
        durableReads += 1
        return accountNetworkState(
          pubkey,
          durableReads >= relayUrls.length ? [removedRelayUrl] : []
        )
      },
    }

    try {
      const result = await fetchEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls,
          accountPubkey: ACCOUNT_A,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )

      expect(durableReads).toBe(relayUrls.length + 1)
      expect(opened.openedUrls).toEqual(relayUrls.slice(0, -1))
      expect(result.relays.map(({ relayUrl }) => relayUrl)).toEqual(
        relayUrls.slice(0, -1)
      )
    } finally {
      opened.restore()
    }
  })

  it("applies local order only after the final account read plan is selected", async () => {
    const relayUrls = [
      "wss://first-order.conduit.market",
      "wss://second-order.conduit.market",
      "wss://third-order.conduit.market",
    ]
    const preferredRelayOrder = [relayUrls[2]!, relayUrls[0]!, relayUrls[1]!]
    const opened = installEoseWebSocket()
    const repository: Pick<AccountNetworkLocalStateRepository, "get"> = {
      get: async (pubkey) =>
        accountNetworkState(pubkey, [], preferredRelayOrder),
    }

    try {
      const result = await fetchEventsFanoutDetailed(
        { kinds: [1] },
        {
          relayUrls,
          accountPubkey: ACCOUNT_A,
          accountNetworkLocalStateRepository: repository,
          reuseRelayConnections: false,
        }
      )

      expect(opened.openedUrls).toEqual(preferredRelayOrder)
      expect(result.relays.map(({ relayUrl }) => relayUrl)).toEqual(
        preferredRelayOrder
      )
      expect(new Set(result.relays.map(({ relayUrl }) => relayUrl))).toEqual(
        new Set(relayUrls)
      )
    } finally {
      opened.restore()
    }
  })

  it("keeps contact-list reads on Conduit's planned verified reader", async () => {
    const [follows, merchantTrust] = await Promise.all([
      Bun.file("packages/core/src/protocol/follows.ts").text(),
      Bun.file("apps/market/src/hooks/useMerchantTrustContext.ts").text(),
    ])

    expect(follows).not.toContain(".fetchEvents(")
    expect(merchantTrust).not.toContain(".fetchEvents(")
    expect(follows).toContain("fetchSignedEventsFanoutDetailed")
    expect(follows).toContain("skipHealthFilter: true")
  })

  it("does not connect a shared NDK pool or use bare default publishing", async () => {
    const [sessionContext, relayPublisher] = await Promise.all([
      Bun.file("packages/core/src/context/ConduitSessionContext.tsx").text(),
      Bun.file("packages/core/src/protocol/relay-publish.ts").text(),
    ])

    expect(sessionContext).not.toContain("void connectNdk(")
    expect(relayPublisher).not.toContain("await event.publish()")
    expect(relayPublisher).toContain(
      "Refusing to publish without an approved relay target."
    )
  })

  it("refetches the signed-in profile after authenticated relay activation", async () => {
    const [sessionContext, header] = await Promise.all([
      Bun.file("packages/core/src/context/ConduitSessionContext.tsx").text(),
      Bun.file("apps/market/src/components/MarketHeader.tsx").text(),
    ])

    expect(sessionContext).toContain("!relaySettingsReady ||")
    expect(sessionContext).toContain("session.relayScope")
    expect(sessionContext).toContain("void refetchProfile()")
    expect(sessionContext).toContain(
      "profileRelayScopeRef.current === profileScope"
    )
    expect(sessionContext).toContain("subscribeRelaySettingsChanges")
    expect(sessionContext).toContain("scope !== activeScopeRef.current")
    expect(sessionContext).toContain("profileRefreshReadyRef.current")
    expect(header).not.toContain("subscribeRelaySettingsChanges")
    expect(header).not.toContain("useConduitSession")
  })
})
