import { Moon, Sun, SunMoon } from "lucide-react"
import { useTheme } from "../hooks/useTheme"
import {
  DEFAULT_THEME_TOGGLE_CYCLE,
  NAMED_THEMES,
  getNextThemePreferenceInCycle,
  type ThemePreference,
} from "../theme"
import { cn } from "../utils"

export type ThemeToggleButtonProps = {
  className?: string
  cycle?: readonly ThemePreference[]
}

function getThemePreferenceLabel(preference: ThemePreference): string {
  if (preference === "system") return "System"
  return (
    NAMED_THEMES.find((theme) => theme.id === preference)?.label ?? preference
  )
}

export function ThemeToggleButton({
  className,
  cycle = DEFAULT_THEME_TOGGLE_CYCLE,
}: ThemeToggleButtonProps) {
  const { preference, setPreference } = useTheme()
  const nextPreference = getNextThemePreferenceInCycle(preference, cycle)
  const label = `Appearance: ${getThemePreferenceLabel(preference)}. Switch to ${getThemePreferenceLabel(nextPreference)}`
  const Icon =
    preference === "system" ? SunMoon : preference === "day-market" ? Sun : Moon

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-theme-toggle-preference={preference}
      data-theme-toggle-target={nextPreference}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-sm transition-colors hover:bg-[var(--surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
        className
      )}
      onClick={() => setPreference(nextPreference)}
    >
      <Icon className="size-5" aria-hidden="true" />
    </button>
  )
}
