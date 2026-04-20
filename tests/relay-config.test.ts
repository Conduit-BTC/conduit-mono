import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import {
  getDefaultRelayGroups,
  getEffectiveRelayGroups,
  getEffectiveRelayUrls,
  getEffectiveReadableRelayUrls,
  getEffectiveWritableRelayUrls,
  getRelayGroupsForActor,
  loadRelayOverrides,
  saveRelayOverrides,
  clearRelayOverrides,
  relayRoleLabel,
  relayRoleDescription,
} from "../packages/core/src/config"
import type { RelayGroups } from "../packages/core/src/types"

// Mock localStorage for test isolation
const store: Record<string, string> = {}
const originalLocalStorage = globalThis.localStorage

beforeEach(() => {
  Object.keys(store).forEach((key) => delete store[key])
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value },
      removeItem: (key: string) => { delete store[key] },
      clear: () => { Object.keys(store).forEach((key) => delete store[key]) },
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
  describe("getDefaultRelayGroups", () => {
    it("returns three relay groups", () => {
      const groups = getDefaultRelayGroups()
      expect(groups).toHaveProperty("merchant")
      expect(groups).toHaveProperty("commerce")
      expect(groups).toHaveProperty("general")
      expect(Array.isArray(groups.merchant)).toBe(true)
      expect(Array.isArray(groups.commerce)).toBe(true)
      expect(Array.isArray(groups.general)).toBe(true)
    })

    it("assigns correct roles to entries", () => {
      const groups = getDefaultRelayGroups()
      for (const entry of groups.merchant) {
        expect(entry.role).toBe("merchant")
        expect(entry.write).toBe(true)
      }
      for (const entry of groups.commerce) {
        expect(entry.role).toBe("commerce")
        expect(entry.write).toBe(true)
      }
      for (const entry of groups.general) {
        expect(entry.role).toBe("general")
        expect(entry.write).toBe(true)
      }
    })

    it("all entries have read=true", () => {
      const groups = getDefaultRelayGroups()
      const allEntries = [...groups.merchant, ...groups.commerce, ...groups.general]
      for (const entry of allEntries) {
        expect(entry.read).toBe(true)
      }
    })
  })

  describe("loadRelayOverrides / saveRelayOverrides / clearRelayOverrides", () => {
    it("returns null when no overrides saved", () => {
      expect(loadRelayOverrides()).toBeNull()
    })

    it("round-trips relay groups through localStorage", () => {
      const groups: RelayGroups = {
        merchant: [{ url: "wss://merchant.test", role: "merchant", read: true, write: true }],
        commerce: [{ url: "wss://commerce.test", role: "commerce", read: true, write: false }],
        general: [],
      }
      saveRelayOverrides(groups)
      const loaded = loadRelayOverrides()
      expect(loaded).toEqual(groups)
    })

    it("clearRelayOverrides removes saved settings", () => {
      const groups: RelayGroups = {
        merchant: [],
        commerce: [],
        general: [{ url: "wss://test.relay", role: "general", read: true, write: false }],
      }
      saveRelayOverrides(groups)
      expect(loadRelayOverrides()).not.toBeNull()
      clearRelayOverrides()
      expect(loadRelayOverrides()).toBeNull()
    })

    it("returns null for corrupted localStorage data", () => {
      store["conduit:relay-settings"] = "not-json"
      expect(loadRelayOverrides()).toBeNull()
    })

    it("returns null for wrong shape", () => {
      store["conduit:relay-settings"] = JSON.stringify({ foo: "bar" })
      expect(loadRelayOverrides()).toBeNull()
    })
  })

  describe("getEffectiveRelayGroups", () => {
    it("returns defaults when no overrides", () => {
      const effective = getEffectiveRelayGroups()
      const defaults = getDefaultRelayGroups()
      expect(effective).toEqual(defaults)
    })

    it("uses overrides when present", () => {
      const overrides: RelayGroups = {
        merchant: [{ url: "wss://custom-merchant.test", role: "merchant", read: true, write: true }],
        commerce: [{ url: "wss://custom-l2.test", role: "commerce", read: true, write: false }],
        general: [{ url: "wss://custom-general.test", role: "general", read: true, write: false }],
      }
      saveRelayOverrides(overrides)
      const effective = getEffectiveRelayGroups()
      expect(effective).toEqual(overrides)
    })

    it("preserves explicitly empty override groups", () => {
      const overrides: RelayGroups = {
        merchant: [{ url: "wss://custom.test", role: "merchant", read: true, write: true }],
        commerce: [],
        general: [],
      }
      saveRelayOverrides(overrides)
      const effective = getEffectiveRelayGroups()
      expect(effective.merchant).toEqual(overrides.merchant)
      expect(effective.commerce).toEqual([])
      expect(effective.general).toEqual([])
    })
  })

  describe("getRelayGroupsForActor", () => {
    it("returns all three groups for merchant", () => {
      const groups = getRelayGroupsForActor("merchant")
      expect(groups).toHaveProperty("merchant")
      expect(groups).toHaveProperty("commerce")
      expect(groups).toHaveProperty("general")
    })

    it("returns only commerce and general for shopper", () => {
      const groups = getRelayGroupsForActor("shopper")
      expect(groups).not.toHaveProperty("merchant")
      expect(groups).toHaveProperty("commerce")
      expect(groups).toHaveProperty("general")
    })
  })

  describe("getEffectiveRelayUrls", () => {
    it("returns a flat deduplicated list", () => {
      const urls = getEffectiveRelayUrls()
      expect(Array.isArray(urls)).toBe(true)
      const unique = [...new Set(urls)]
      expect(urls.length).toBe(unique.length)
    })

    it("does not include empty strings", () => {
      const urls = getEffectiveRelayUrls()
      for (const url of urls) {
        expect(url.length).toBeGreaterThan(0)
      }
    })

    it("includes relays enabled for either reads or writes", () => {
      saveRelayOverrides({
        merchant: [{ url: "wss://merchant.test", role: "merchant", read: false, write: true }],
        commerce: [{ url: "wss://commerce.test", role: "commerce", read: true, write: false }],
        general: [{ url: "wss://general.test", role: "general", read: false, write: false }],
      })

      expect(getEffectiveRelayUrls()).toEqual([
        "wss://merchant.test",
        "wss://commerce.test",
      ])
    })
  })

  describe("read and write relay filtering", () => {
    it("returns read-enabled relays only", () => {
      saveRelayOverrides({
        merchant: [{ url: "wss://merchant.test", role: "merchant", read: false, write: true }],
        commerce: [{ url: "wss://commerce.test", role: "commerce", read: true, write: false }],
        general: [{ url: "wss://general.test", role: "general", read: true, write: true }],
      })

      expect(getEffectiveReadableRelayUrls()).toEqual([
        "wss://commerce.test",
        "wss://general.test",
      ])
    })

    it("returns write-enabled relays only", () => {
      saveRelayOverrides({
        merchant: [{ url: "wss://merchant.test", role: "merchant", read: true, write: false }],
        commerce: [{ url: "wss://commerce.test", role: "commerce", read: true, write: true }],
        general: [{ url: "wss://general.test", role: "general", read: false, write: false }],
      })

      expect(getEffectiveWritableRelayUrls()).toEqual(["wss://commerce.test"])
    })

    it("deduplicates URLs shared across groups", () => {
      saveRelayOverrides({
        merchant: [{ url: "wss://shared.test", role: "merchant", read: true, write: true }],
        commerce: [{ url: "wss://shared.test", role: "commerce", read: true, write: true }],
        general: [],
      })

      expect(getEffectiveReadableRelayUrls()).toEqual(["wss://shared.test"])
      expect(getEffectiveWritableRelayUrls()).toEqual(["wss://shared.test"])
    })
  })

  describe("relayRoleLabel", () => {
    it("returns human-readable labels", () => {
      expect(relayRoleLabel("merchant")).toBe("Merchant relay")
      expect(relayRoleLabel("commerce")).toBe("Commerce relay")
      expect(relayRoleLabel("general")).toBe("General relay")
    })
  })

  describe("relayRoleDescription", () => {
    it("returns descriptions for all roles", () => {
      expect(relayRoleDescription("merchant")).toBeTruthy()
      expect(relayRoleDescription("commerce")).toBeTruthy()
      expect(relayRoleDescription("general")).toBeTruthy()
    })
  })
})
