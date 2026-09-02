export const THEME_ATTRIBUTE = "data-theme"
export const THEME_STORAGE_KEY = "conduit:theme-preference"
export const THEME_COLOR_PROPERTY = "--theme-color"
export const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)"

export const NAMED_THEMES = [
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
] as const

export type ThemeId = (typeof NAMED_THEMES)[number]["id"]
export type ThemeColorScheme = (typeof NAMED_THEMES)[number]["colorScheme"]
export type ThemePreference = "system" | ThemeId

export const DEFAULT_THEME_TOGGLE_CYCLE = [
  "system",
  "day-market",
  "night-market",
] as const satisfies readonly ThemePreference[]

export const THEME_PREFERENCE_OPTIONS: readonly {
  id: ThemePreference
  label: string
}[] = [{ id: "system", label: "Use device setting" }, ...NAMED_THEMES]

export function createThemeBootstrapScript(): string {
  const nightTheme = NAMED_THEMES.find((theme) => theme.id === "night-market")!
  const dayTheme = NAMED_THEMES.find((theme) => theme.id === "day-market")!
  const supportedPreferences = [
    "system",
    ...NAMED_THEMES.map((theme) => theme.id),
  ]
  const themeColorSchemes = Object.fromEntries(
    NAMED_THEMES.map((theme) => [theme.id, theme.colorScheme])
  )

  return `(() => {
  const root = document.documentElement;
  let preference = "system";
  try {
    const storedPreference = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (${JSON.stringify(supportedPreferences)}.includes(storedPreference)) {
      preference = storedPreference;
    }
  } catch {}

  let systemPrefersDark = true;
  try {
    systemPrefersDark = window.matchMedia(${JSON.stringify(SYSTEM_THEME_QUERY)}).matches;
  } catch {}

  const theme = preference === "system"
    ? (systemPrefersDark ? ${JSON.stringify(nightTheme.id)} : ${JSON.stringify(dayTheme.id)})
    : preference;
  root.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)}, theme);
  root.style.colorScheme = ${JSON.stringify(themeColorSchemes)}[theme] ?? ${JSON.stringify(nightTheme.colorScheme)};
})();`
}
