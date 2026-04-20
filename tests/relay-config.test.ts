import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  clearRelayOverrides,
  getConfiguredRelayGroups,
  getDefaultRelayGroups,
  getEffectiveRelayGroups,
  getEffectiveReadableRelayUrls,
  getEffectiveRelayUrls,
  getEffectiveWritableRelayUrls,
  getRelayGroupsForActor,
  loadRelayOverrides,
  loadSignerRelayMap,
  saveRelayOverrides,
  saveSignerRelayMap,
} from "../packages/core/src/config"
import type { RelayOverrides } from "../packages/core/src/types"

const store: Record<string, string> = {}
const originalLocalStorage = globalThis.localStorage

beforeEach(() => {
  Object.keys(store).forEach((key) => delete store[key])
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        Object.keys(store).forEach((key) => delete store[key])
      },
      length: 0,
      key: () => null,
    },
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: originalLocalStorage,
    writable: true,
    configurable: true,
  })
})

describe("relay config model", () => {
  it("merges signer relays into the general group by default", () => {
    saveSignerRelayMap({
      "wss://signer-a.test": { read: true, write: true },
      "wss://signer-b.test": { read: true, write: false },
    })

    const groups = getDefaultRelayGroups()
    expect(groups.general.map((entry) => entry.url)).toContain("wss://signer-a.test")
    expect(groups.general.map((entry) => entry.url)).toContain("wss://signer-b.test")
    expect(groups.general.some((entry) => entry.source === "signer")).toBe(true)
  })

  it("keeps configured commerce relays separate from signer general relays", () => {
    const configured = getConfiguredRelayGroups()
    for (const entry of configured.commerce) {
      expect(entry.role).toBe("commerce")
      expect(entry.source).toBe("app")
    }
  })

  it("round-trips override state", () => {
    const overrides: RelayOverrides = {
      custom: {
        merchant: [],
        commerce: [],
        general: [{
          url: "wss://custom-general.test",
          role: "general",
          source: "custom",
          out: true,
          in: true,
          find: true,
          dm: true,
        }],
      },
      states: {
        merchant: {},
        commerce: {},
        general: {
          "wss://app-general.test": { hidden: true },
        },
      },
    }

    saveRelayOverrides(overrides)
    expect(loadRelayOverrides()).toEqual(overrides)
  })

  it("returns null when no overrides exist", () => {
    expect(loadRelayOverrides()).toBeNull()
  })

  it("persists signer relays separately", () => {
    saveSignerRelayMap({
      "wss://signer.test": { read: true, write: false },
    })

    expect(loadSignerRelayMap()).toEqual({
      "wss://signer.test": { read: true, write: false },
    })
  })

  it("applies hidden state to configured relays", () => {
    const configured = getConfiguredRelayGroups()
    const hiddenUrl = configured.general[0]?.url
    if (!hiddenUrl) return

    saveRelayOverrides({
      custom: { merchant: [], commerce: [], general: [] },
      states: {
        merchant: {},
        commerce: {},
        general: {
          [hiddenUrl]: { hidden: true },
        },
      },
    })

    expect(getEffectiveRelayGroups().general.some((entry) => entry.url === hiddenUrl)).toBe(false)
  })

  it("returns only commerce and general groups for shoppers", () => {
    const groups = getRelayGroupsForActor("shopper")
    expect(groups).not.toHaveProperty("merchant")
    expect(groups).toHaveProperty("commerce")
    expect(groups).toHaveProperty("general")
  })

  it("uses actor-aware relay pools", () => {
    const merchantUrls = getEffectiveRelayUrls("merchant")
    const shopperUrls = getEffectiveRelayUrls("shopper")
    const merchantGroup = getEffectiveRelayGroups().merchant

    expect(shopperUrls.every((url) => !merchantGroup.some((entry) => entry.url === url))).toBe(true)
    expect(merchantUrls.length).toBeGreaterThanOrEqual(shopperUrls.length)
  })

  it("filters readable and writable relays by actor", () => {
    saveSignerRelayMap({
      "wss://signer.test": { read: true, write: false },
    })

    const readable = getEffectiveReadableRelayUrls("shopper")
    const writable = getEffectiveWritableRelayUrls("shopper")

    expect(readable).toContain("wss://signer.test")
    expect(writable).not.toContain("wss://signer.test")
  })

  it("clearRelayOverrides removes saved overrides", () => {
    saveRelayOverrides({
      custom: { merchant: [], commerce: [], general: [] },
      states: { merchant: {}, commerce: {}, general: { "wss://x.test": { hidden: true } } },
    })

    clearRelayOverrides()
    expect(loadRelayOverrides()).toBeNull()
  })
})
