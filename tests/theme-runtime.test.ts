import { describe, expect, it } from "bun:test"
import {
  NAMED_THEMES,
  THEME_ATTRIBUTE,
  THEME_PREFERENCE_OPTIONS,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  createThemeController,
  parseThemePreference,
  persistThemePreference,
  readThemePreference,
  resolveThemePreference,
  type ThemeId,
  type ThemeStorageEvent,
} from "@conduit/ui/theme"

type ControllerHarnessOptions = {
  stored?: string | null
  systemDark?: boolean
  readThrows?: boolean
  writeThrows?: boolean
}

function createControllerHarness({
  stored = null,
  systemDark = false,
  readThrows = false,
  writeThrows = false,
}: ControllerHarnessOptions = {}) {
  let storedPreference = stored
  let prefersDark = systemDark
  let systemListener = () => undefined
  let storageListener = (_event: ThemeStorageEvent) => undefined
  const appliedThemes: ThemeId[] = []

  const controller = createThemeController({
    storage: {
      getItem() {
        if (readThrows) throw new Error("storage unavailable")
        return storedPreference
      },
      setItem(_key, value) {
        if (writeThrows) throw new Error("storage unavailable")
        storedPreference = value
      },
    },
    systemPreference: {
      isDark: () => prefersDark,
      subscribe(listener) {
        systemListener = listener
        return () => {
          systemListener = () => undefined
        }
      },
    },
    applyTheme(theme) {
      appliedThemes.push(theme)
    },
    subscribeToStorage(listener) {
      storageListener = listener
      return () => {
        storageListener = () => undefined
      }
    },
  })
  controller.start()

  return {
    appliedThemes,
    controller,
    emitStorage(event: ThemeStorageEvent) {
      storageListener(event)
    },
    getStoredPreference: () => storedPreference,
    setSystemDark(value: boolean) {
      prefersDark = value
      systemListener()
    },
  }
}

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

describe("theme controller", () => {
  it("applies the initial theme synchronously before listeners start", () => {
    const harness = createControllerHarness({ systemDark: true })

    expect(harness.appliedThemes[0]).toBe("night-market")
    expect(harness.controller.getSnapshot()).toEqual({
      preference: "system",
      resolvedTheme: "night-market",
    })
  })

  it("still applies the system fallback when stored preference reads fail", () => {
    const harness = createControllerHarness({
      systemDark: false,
      readThrows: true,
    })

    expect(harness.controller.getSnapshot()).toEqual({
      preference: "system",
      resolvedTheme: "day-market",
    })
    expect(harness.appliedThemes[0]).toBe("day-market")
  })

  it("follows live device changes only while the preference is system", () => {
    const harness = createControllerHarness({ systemDark: false })

    harness.setSystemDark(true)
    expect(harness.controller.getSnapshot().resolvedTheme).toBe("night-market")

    harness.controller.setPreference("day-market")
    harness.setSystemDark(false)
    harness.setSystemDark(true)
    expect(harness.controller.getSnapshot()).toEqual({
      preference: "day-market",
      resolvedTheme: "day-market",
    })
  })

  it("applies a selection even when persistence fails", () => {
    const harness = createControllerHarness({
      systemDark: false,
      writeThrows: true,
    })

    harness.controller.setPreference("night-market")

    expect(harness.controller.getSnapshot().resolvedTheme).toBe("night-market")
    expect(harness.appliedThemes.at(-1)).toBe("night-market")
  })

  it("handles relevant storage events and ignores unrelated keys", () => {
    const harness = createControllerHarness({ systemDark: true })

    harness.emitStorage({ key: "unrelated", newValue: "day-market" })
    expect(harness.controller.getSnapshot().preference).toBe("system")

    harness.emitStorage({
      key: THEME_STORAGE_KEY,
      newValue: "day-market",
    })
    expect(harness.controller.getSnapshot()).toEqual({
      preference: "day-market",
      resolvedTheme: "day-market",
    })

    harness.emitStorage({ key: THEME_STORAGE_KEY, newValue: "malformed" })
    expect(harness.controller.getSnapshot()).toEqual({
      preference: "system",
      resolvedTheme: "night-market",
    })

    harness.emitStorage({ key: null, newValue: null })
    expect(harness.controller.getSnapshot().preference).toBe("system")
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
