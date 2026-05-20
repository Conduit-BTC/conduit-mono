import { describe, expect, it } from "bun:test"
import { NDKRelayStatus } from "@nostr-dev-kit/ndk"

import { __nwcTestInternals } from "@conduit/core"

type FakeRelay = {
  status: NDKRelayStatus
  disconnect?: () => void
}

class FakePool {
  readonly relays = new Map<string, FakeRelay>()
  readonly listeners = new Set<() => void>()

  constructor(relays: Record<string, FakeRelay>) {
    for (const [url, relay] of Object.entries(relays)) {
      this.relays.set(url, relay)
    }
  }

  connectedRelays(): FakeRelay[] {
    return Array.from(this.relays.values()).filter(
      (relay) => relay.status >= NDKRelayStatus.CONNECTED
    )
  }

  on(event: "relay:connect", listener: () => void): void {
    if (event === "relay:connect") this.listeners.add(listener)
  }

  off(event: "relay:connect", listener: () => void): void {
    if (event === "relay:connect") this.listeners.delete(listener)
  }

  emitRelayConnect(): void {
    for (const listener of this.listeners) listener()
  }
}

function fakeNdk(input: {
  pool: FakePool
  connect: (timeoutMs?: number) => Promise<void>
}) {
  return {
    pool: input.pool,
    connect: input.connect,
  } as never
}

describe("NWC relay bootstrap", () => {
  it("waits for a delayed wallet relay connection before resolving", async () => {
    const relay: FakeRelay = { status: NDKRelayStatus.CONNECTING }
    const pool = new FakePool({ "wss://wallet.example": relay })
    let connectCalls = 0

    const ndk = fakeNdk({
      pool,
      connect: async () => {
        connectCalls += 1
        setTimeout(() => {
          relay.status = NDKRelayStatus.CONNECTED
          pool.emitRelayConnect()
        }, 5)
      },
    })

    await expect(
      __nwcTestInternals.waitForNwcRelayConnection(ndk, 50)
    ).resolves.toBeUndefined()

    expect(connectCalls).toBe(1)
    expect(pool.listeners.size).toBe(0)
  })

  it("rejects when no wallet relay connects before the timeout", async () => {
    const pool = new FakePool({
      "wss://wallet.example": { status: NDKRelayStatus.CONNECTING },
    })
    const ndk = fakeNdk({
      pool,
      connect: async () => {},
    })

    await expect(
      __nwcTestInternals.waitForNwcRelayConnection(ndk, 5)
    ).rejects.toThrow("Failed to connect to NWC relay(s)")

    expect(pool.listeners.size).toBe(0)
  })

  it("treats authenticated relays as already connected", async () => {
    const pool = new FakePool({
      "wss://wallet.example": { status: NDKRelayStatus.AUTHENTICATED },
    })
    let connectCalls = 0
    const ndk = fakeNdk({
      pool,
      connect: async () => {
        connectCalls += 1
      },
    })

    await expect(
      __nwcTestInternals.waitForNwcRelayConnection(ndk, 50)
    ).resolves.toBeUndefined()

    expect(connectCalls).toBe(0)
  })
})
