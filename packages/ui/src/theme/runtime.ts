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

type ThemeListener = () => void

const themeListeners = new Set<ThemeListener>()
let browserThemeSnapshot = SERVER_THEME_SNAPSHOT
let browserThemeInitialized = false
let browserStorage: Storage | null = null
let browserSystemPreference: MediaQueryList | null = null

function getBrowserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function getSystemPrefersDark(): boolean {
  return browserSystemPreference?.matches ?? true
}

function notifyThemeListeners(): void {
  themeListeners.forEach((listener) => listener())
}

function applyBrowserTheme(themeId: ThemeId): void {
  applyThemeToDocument(document, themeId, window.getComputedStyle.bind(window))
}

function updateBrowserPreference(preference: ThemePreference): void {
  const nextSnapshot: ThemeSnapshot = {
    preference,
    resolvedTheme: resolveThemePreference(preference, getSystemPrefersDark()),
  }
  const changed =
    nextSnapshot.preference !== browserThemeSnapshot.preference ||
    nextSnapshot.resolvedTheme !== browserThemeSnapshot.resolvedTheme

  browserThemeSnapshot = nextSnapshot
  applyBrowserTheme(nextSnapshot.resolvedTheme)
  if (changed) notifyThemeListeners()
}

function handleSystemPreferenceChange(): void {
  if (browserThemeSnapshot.preference === "system") {
    updateBrowserPreference("system")
  }
}

function handleStorageChange(event: StorageEvent): void {
  if (event.storageArea && event.storageArea !== browserStorage) return
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
  updateBrowserPreference(parseThemePreference(event.newValue))
}

function createSystemPreferenceQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(SYSTEM_THEME_QUERY)
  } catch {
    return null
  }
}

export function initializeTheme(): void {
  if (
    browserThemeInitialized ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) {
    return
  }

  browserThemeInitialized = true
  browserStorage = getBrowserStorage()
  browserSystemPreference = createSystemPreferenceQuery()
  updateBrowserPreference(readThemePreference(browserStorage))
  browserSystemPreference?.addEventListener(
    "change",
    handleSystemPreferenceChange
  )
  window.addEventListener("storage", handleStorageChange)
}

export function setThemePreference(preference: ThemePreference): void {
  initializeTheme()
  if (!browserThemeInitialized) return

  const parsedPreference = parseThemePreference(preference)
  persistThemePreference(browserStorage, parsedPreference)
  updateBrowserPreference(parsedPreference)
}

export function getThemeSnapshot(): ThemeSnapshot {
  return browserThemeSnapshot
}

export function subscribeToTheme(listener: () => void): () => void {
  initializeTheme()
  if (!browserThemeInitialized) return () => undefined

  themeListeners.add(listener)
  return () => themeListeners.delete(listener)
}

export function getServerThemeSnapshot(): ThemeSnapshot {
  return SERVER_THEME_SNAPSHOT
}
