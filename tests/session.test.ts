import { afterEach, describe, expect, it } from "bun:test"
import {
  createRelaySettingsFromPreferences,
  getRelaySettingsStorageKey,
  loadRelaySettings,
  resolveConduitSession,
  saveRelaySettings,
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
        relayScope: "market:alice",
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
      relayScope: "merchant:merchant-pubkey",
    })
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

    const merchantSettings = loadRelaySettings("merchant:alice")

    expect(getRelaySettingsStorageKey("market:guest")).not.toBe(
      getRelaySettingsStorageKey("merchant:alice")
    )
    expect(merchantSettings.entries.map((entry) => entry.url)).not.toContain(
      "wss://guest.example"
    )
  })
})
