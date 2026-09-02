import {
  NAMED_THEMES,
  SYSTEM_THEME_QUERY,
  THEME_ATTRIBUTE,
  THEME_COLOR_PROPERTY,
  THEME_STORAGE_KEY,
  type ThemeId,
  type ThemePreference,
} from "./definitions"

export {
  NAMED_THEMES,
  SYSTEM_THEME_QUERY,
  THEME_ATTRIBUTE,
  THEME_COLOR_PROPERTY,
  THEME_PREFERENCE_OPTIONS,
  THEME_STORAGE_KEY,
} from "./definitions"
export type { ThemeColorScheme, ThemeId, ThemePreference } from "./definitions"

export type ThemeSnapshot = Readonly<{
  preference: ThemePreference
  resolvedTheme: ThemeId
}>

export interface ThemeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ThemeSystemPreference {
  isDark(): boolean
  subscribe(listener: () => void): () => void
}

export type ThemeStorageEvent = Readonly<{
  key: string | null
  newValue: string | null
}>

export interface ThemeControllerEnvironment {
  storage?: ThemeStorage | null
  systemPreference: ThemeSystemPreference
  applyTheme(theme: ThemeId): void
  subscribeToStorage(listener: (event: ThemeStorageEvent) => void): () => void
}

export interface ThemeController {
  getSnapshot(): ThemeSnapshot
  setPreference(preference: ThemePreference): void
  start(): void
  stop(): void
  subscribe(listener: () => void): () => void
}

const SERVER_THEME_SNAPSHOT: ThemeSnapshot = {
  preference: "system",
  resolvedTheme: "night-market",
}

function isThemeId(value: unknown): value is ThemeId {
  return NAMED_THEMES.some((theme) => theme.id === value)
}

function getThemeDefinition(themeId: ThemeId) {
  return NAMED_THEMES.find((theme) => theme.id === themeId)!
}

export function parseThemePreference(value: unknown): ThemePreference {
  if (value === "system" || isThemeId(value)) return value
  return "system"
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean
): ThemeId {
  if (preference !== "system") return preference
  return systemPrefersDark ? "night-market" : "day-market"
}

export function readThemePreference(
  storage: ThemeStorage | null | undefined
): ThemePreference {
  if (!storage) return "system"

  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY))
  } catch {
    return "system"
  }
}

export function persistThemePreference(
  storage: ThemeStorage | null | undefined,
  preference: ThemePreference
): boolean {
  if (!storage) return false

  try {
    storage.setItem(THEME_STORAGE_KEY, preference)
    return true
  } catch {
    return false
  }
}

export function applyThemeToDocument(
  targetDocument: Document,
  themeId: ThemeId,
  readComputedStyle: (element: Element) => CSSStyleDeclaration
): void {
  const theme = getThemeDefinition(themeId)
  const root = targetDocument.documentElement

  root.setAttribute(THEME_ATTRIBUTE, theme.id)
  root.style.colorScheme = theme.colorScheme

  const themeColor = readComputedStyle(root)
    .getPropertyValue(THEME_COLOR_PROPERTY)
    .trim()
  if (!themeColor) return

  let themeColorMeta = targetDocument.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]'
  )
  if (!themeColorMeta) {
    themeColorMeta = targetDocument.createElement("meta")
    themeColorMeta.setAttribute("name", "theme-color")
    targetDocument.head.appendChild(themeColorMeta)
  }
  themeColorMeta.setAttribute("content", themeColor)
}

export function createThemeController(
  environment: ThemeControllerEnvironment
): ThemeController {
  let preference = readThemePreference(environment.storage)
  let snapshot: ThemeSnapshot = {
    preference,
    resolvedTheme: resolveThemePreference(
      preference,
      environment.systemPreference.isDark()
    ),
  }
  let started = false
  let unsubscribeSystem: () => void = () => undefined
  let unsubscribeStorage: () => void = () => undefined
  const listeners = new Set<() => void>()

  function applyPreference(nextPreference: ThemePreference): void {
    const nextSnapshot: ThemeSnapshot = {
      preference: nextPreference,
      resolvedTheme: resolveThemePreference(
        nextPreference,
        environment.systemPreference.isDark()
      ),
    }
    const changed =
      nextSnapshot.preference !== snapshot.preference ||
      nextSnapshot.resolvedTheme !== snapshot.resolvedTheme

    preference = nextPreference
    snapshot = nextSnapshot
    environment.applyTheme(nextSnapshot.resolvedTheme)

    if (changed) {
      for (const listener of listeners) listener()
    }
  }

  function handleSystemPreferenceChange(): void {
    if (preference === "system") applyPreference(preference)
  }

  function handleStorageChange(event: ThemeStorageEvent): void {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
    applyPreference(parseThemePreference(event.newValue))
  }

  environment.applyTheme(snapshot.resolvedTheme)

  return {
    getSnapshot() {
      return snapshot
    },
    setPreference(nextPreference) {
      const parsedPreference = parseThemePreference(nextPreference)
      persistThemePreference(environment.storage, parsedPreference)
      applyPreference(parsedPreference)
    },
    start() {
      if (started) return
      started = true
      unsubscribeSystem = environment.systemPreference.subscribe(
        handleSystemPreferenceChange
      )
      unsubscribeStorage = environment.subscribeToStorage(handleStorageChange)
    },
    stop() {
      if (!started) return
      started = false
      unsubscribeSystem()
      unsubscribeStorage()
      unsubscribeSystem = () => undefined
      unsubscribeStorage = () => undefined
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function getBrowserStorage(): ThemeStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function createBrowserThemeController(): ThemeController | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null
  }

  const mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY)
  return createThemeController({
    storage: getBrowserStorage(),
    systemPreference: {
      isDark: () => mediaQuery.matches,
      subscribe(listener) {
        mediaQuery.addEventListener("change", listener)
        return () => mediaQuery.removeEventListener("change", listener)
      },
    },
    applyTheme: (theme) =>
      applyThemeToDocument(
        document,
        theme,
        window.getComputedStyle.bind(window)
      ),
    subscribeToStorage(listener) {
      const handleStorage = (event: StorageEvent): void => {
        listener({ key: event.key, newValue: event.newValue })
      }
      window.addEventListener("storage", handleStorage)
      return () => window.removeEventListener("storage", handleStorage)
    },
  })
}

let browserThemeController: ThemeController | null | undefined

function getBrowserThemeController(): ThemeController | null {
  if (browserThemeController === undefined) {
    browserThemeController = createBrowserThemeController()
  }
  return browserThemeController
}

export function initializeTheme(): void {
  const controller = getBrowserThemeController()
  if (!controller) return
  controller.start()
}

export function setThemePreference(preference: ThemePreference): void {
  const controller = getBrowserThemeController()
  if (!controller) return
  controller.start()
  controller.setPreference(preference)
}

export function getThemeSnapshot(): ThemeSnapshot {
  return getBrowserThemeController()?.getSnapshot() ?? SERVER_THEME_SNAPSHOT
}

export function subscribeToTheme(listener: () => void): () => void {
  const controller = getBrowserThemeController()
  if (!controller) return () => undefined
  controller.start()
  return controller.subscribe(listener)
}

export function getServerThemeSnapshot(): ThemeSnapshot {
  return SERVER_THEME_SNAPSHOT
}
