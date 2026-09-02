import { useSyncExternalStore } from "react"
import {
  getServerThemeSnapshot,
  getThemeSnapshot,
  setThemePreference,
  subscribeToTheme,
  type ThemePreference,
  type ThemeSnapshot,
} from "../theme"

export type ThemeState = ThemeSnapshot & {
  setPreference(preference: ThemePreference): void
}

export function useTheme(): ThemeState {
  const snapshot = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot
  )

  return {
    ...snapshot,
    setPreference: setThemePreference,
  }
}
