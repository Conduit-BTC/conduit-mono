import { afterEach, describe, expect, it } from "bun:test"
import {
  createRelaySettingsFromPreferences,
  getRelaySettingsStorageKey,
  loadRelaySettings,
  resolveConduitSession,
  saveRelaySettings,
  shouldCloseProtectedConnectionsForScopeTransition,
} from "@conduit/core"

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const originalWindow = globalThis.window

function installWindowStorage(storage: MemoryStorage): void {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: storage },
    configurable: true,
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
  })
})

describe("Conduit session scopes", () => {
  it("resolves Market guest and signed-in relay scopes", () => {
    expect(
      resolveConduitSession({ appId: "market", allowGuest: true })
    ).toEqual({
      appId: "market",
      mode: "guest",
      pubkey: null,
      relayScope: "market:guest",
    })

    expect(resolveConduitSession({ appId: "market", pubkey: "alice" })).toEqual(
      {
        appId: "market",
        mode: "signed_in",
        pubkey: "alice",
        relayScope: "account:alice",
      }
    )
  })

  it("does not create a Merchant guest relay scope", () => {
    expect(
      resolveConduitSession({
        appId: "merchant",
        allowGuest: false,
      })
    ).toEqual({
      appId: "merchant",
      mode: "guest",
      pubkey: null,
      relayScope: null,
    })

    expect(
      resolveConduitSession({ appId: "merchant", pubkey: "merchant-pubkey" })
    ).toEqual({
      appId: "merchant",
      mode: "signed_in",
      pubkey: "merchant-pubkey",
      relayScope: "account:merchant-pubkey",
    })
  })

  it("closes protected connections whenever an active identity scope changes", () => {
    expect(
      shouldCloseProtectedConnectionsForScopeTransition(
        "account:alice",
        "market:guest"
      )
    ).toBe(true)
    expect(
      shouldCloseProtectedConnectionsForScopeTransition(
        "account:alice",
        "account:bob"
      )
    ).toBe(true)
    expect(
      shouldCloseProtectedConnectionsForScopeTransition("account:alice", null)
    ).toBe(true)
    expect(
      shouldCloseProtectedConnectionsForScopeTransition(
        "account:alice",
        "account:alice"
      )
    ).toBe(false)
    expect(
      shouldCloseProtectedConnectionsForScopeTransition(null, "market:guest")
    ).toBe(false)
  })

  it("keeps guest Market relay settings out of Merchant identity scope", () => {
    const storage = new MemoryStorage()
    installWindowStorage(storage)

    const guestSettings = createRelaySettingsFromPreferences(
      [
        {
          url: "wss://guest.example",
          readEnabled: true,
          writeEnabled: false,
        },
      ],
      "published"
    )
    saveRelaySettings(guestSettings, "market:guest")

    const merchantSettings = loadRelaySettings("account:alice")

    expect(getRelaySettingsStorageKey("market:guest")).not.toBe(
      getRelaySettingsStorageKey("account:alice")
    )
    expect(merchantSettings.entries.map((entry) => entry.url)).not.toContain(
      "wss://guest.example"
    )
  })
})
