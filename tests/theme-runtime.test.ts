import { describe, expect, it } from "bun:test"
import {
  DEFAULT_THEME_TOGGLE_CYCLE,
  NAMED_THEMES,
  THEME_ATTRIBUTE,
  THEME_PREFERENCE_OPTIONS,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  getNextThemeInCycle,
  parseThemePreference,
  persistThemePreference,
  readThemePreference,
  resolveThemePreference,
} from "@conduit/ui/theme"

function createDocumentHarness(withThemeColorMeta = true) {
  const rootAttributes = new Map<string, string>()
  const root = {
    style: { colorScheme: "" },
    setAttribute(name: string, value: string) {
      rootAttributes.set(name, value)
    },
  }
  const createMeta = () => {
    const attributes = new Map<string, string>()
    return {
      attributes,
      setAttribute(name: string, value: string) {
        attributes.set(name, value)
      },
    }
  }
  let themeColorMeta = withThemeColorMeta ? createMeta() : null
  const targetDocument = {
    documentElement: root,
    head: {
      appendChild(node: ReturnType<typeof createMeta>) {
        themeColorMeta = node
        return node
      },
    },
    querySelector() {
      return themeColorMeta
    },
    createElement() {
      return createMeta()
    },
  } as unknown as Document

  return {
    document: targetDocument,
    getRootAttribute: (name: string) => rootAttributes.get(name),
    getRootColorScheme: () => root.style.colorScheme,
    getThemeColor: () => themeColorMeta?.attributes.get("content"),
    getThemeColorName: () => themeColorMeta?.attributes.get("name"),
  }
}

describe("named theme vocabulary", () => {
  it("uses stable named theme IDs and preference labels", () => {
    expect(NAMED_THEMES).toEqual([
      {
        id: "night-market",
        label: "Night Market",
        colorScheme: "dark",
      },
      {
        id: "day-market",
        label: "Day Market",
        colorScheme: "light",
      },
    ])
    expect(
      THEME_PREFERENCE_OPTIONS.map(({ id, label }) => ({ id, label }))
    ).toEqual([
      { id: "system", label: "Use device setting" },
      { id: "night-market", label: "Night Market" },
      { id: "day-market", label: "Day Market" },
    ])
  })

  it("parses supported preferences and falls back malformed values to system", () => {
    expect(parseThemePreference("system")).toBe("system")
    expect(parseThemePreference("night-market")).toBe("night-market")
    expect(parseThemePreference("day-market")).toBe("day-market")
    expect(parseThemePreference(null)).toBe("system")
    expect(parseThemePreference("dark")).toBe("system")
    expect(parseThemePreference({ theme: "night-market" })).toBe("system")
  })

  it("resolves system through the device while explicit themes ignore it", () => {
    expect(resolveThemePreference("system", true)).toBe("night-market")
    expect(resolveThemePreference("system", false)).toBe("day-market")
    expect(resolveThemePreference("night-market", false)).toBe("night-market")
    expect(resolveThemePreference("day-market", true)).toBe("day-market")
  })

  it("direct-toggles through the default named theme cycle", () => {
    expect(DEFAULT_THEME_TOGGLE_CYCLE).toEqual(["night-market", "day-market"])
    expect(getNextThemeInCycle("night-market")).toBe("day-market")
    expect(getNextThemeInCycle("day-market")).toBe("night-market")
    expect(
      getNextThemeInCycle("night-market", ["day-market", "night-market"])
    ).toBe("day-market")
    expect(getNextThemeInCycle("night-market", [])).toBe("night-market")
  })
})

describe("theme preference storage", () => {
  it("reads and writes the plain preference value", () => {
    const values = new Map<string, string>([
      [THEME_STORAGE_KEY, "night-market"],
    ])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }

    expect(readThemePreference(storage)).toBe("night-market")
    expect(persistThemePreference(storage, "day-market")).toBe(true)
    expect(values.get(THEME_STORAGE_KEY)).toBe("day-market")
  })

  it("falls back safely when storage access is blocked", () => {
    const storage = {
      getItem() {
        throw new Error("blocked")
      },
      setItem() {
        throw new Error("blocked")
      },
    }

    expect(readThemePreference(storage)).toBe("system")
    expect(persistThemePreference(storage, "night-market")).toBe(false)
  })
})

describe("document theme application", () => {
  it("updates the root theme, color-scheme, and existing theme-color metadata", () => {
    const harness = createDocumentHarness()

    applyThemeToDocument(
      harness.document,
      "night-market",
      () =>
        ({
          getPropertyValue: () => "rgb(10, 6, 20)",
        }) as CSSStyleDeclaration
    )

    expect(harness.getRootAttribute(THEME_ATTRIBUTE)).toBe("night-market")
    expect(harness.getRootColorScheme()).toBe("dark")
    expect(harness.getThemeColor()).toBe("rgb(10, 6, 20)")
  })

  it("creates missing metadata and updates it for Day Market", () => {
    const harness = createDocumentHarness(false)

    applyThemeToDocument(
      harness.document,
      "day-market",
      () =>
        ({
          getPropertyValue: () => "rgb(234, 235, 238)",
        }) as CSSStyleDeclaration
    )

    expect(harness.getRootAttribute(THEME_ATTRIBUTE)).toBe("day-market")
    expect(harness.getRootColorScheme()).toBe("light")
    expect(harness.getThemeColorName()).toBe("theme-color")
    expect(harness.getThemeColor()).toBe("rgb(234, 235, 238)")
  })
})
