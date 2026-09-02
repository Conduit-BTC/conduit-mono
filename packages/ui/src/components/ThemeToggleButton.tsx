import { Moon, Sun } from "lucide-react"
import { useTheme } from "../hooks/useTheme"
import {
  DEFAULT_THEME_TOGGLE_CYCLE,
  NAMED_THEMES,
  getNextThemeInCycle,
  type ThemeId,
} from "../theme"
import { cn } from "../utils"

export type ThemeToggleButtonProps = {
  className?: string
  cycle?: readonly ThemeId[]
}

export function ThemeToggleButton({
  className,
  cycle = DEFAULT_THEME_TOGGLE_CYCLE,
}: ThemeToggleButtonProps) {
  const { resolvedTheme, setPreference } = useTheme()
  const nextTheme = getNextThemeInCycle(resolvedTheme, cycle)
  const nextThemeDefinition =
    NAMED_THEMES.find((theme) => theme.id === nextTheme) ?? NAMED_THEMES[0]
  const label = `Switch to ${nextThemeDefinition.label}`
  const Icon = nextThemeDefinition.colorScheme === "light" ? Sun : Moon

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-theme-toggle-target={nextTheme}
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-sm transition-colors hover:bg-[var(--surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
        className
      )}
      onClick={() => setPreference(nextTheme)}
    >
      <Icon className="size-5" aria-hidden="true" />
    </button>
  )
}
