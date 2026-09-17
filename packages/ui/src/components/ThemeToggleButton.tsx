import { useState } from "react"
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

/** Silent marker that makes a repeated announcement a new text change. */
const REPEAT_MARKER = "\u200b"

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
  /**
   * Only this button's own activations speak. Another tab or the device can
   * change the preference at any time; those updates change the icon, and the
   * live region keeps the last locally chosen text so it is neither cleared
   * nor repeated as if this button had performed them.
   */
  const [announcement, setAnnouncement] = useState("")

  const nextPreference = getNextThemePreferenceInCycle(preference, cycle)
  const label = `Appearance: ${getThemePreferenceLabel(preference)}. Switch to ${getThemePreferenceLabel(nextPreference)}`
  const Icon =
    preference === "system" ? SunMoon : preference === "day-market" ? Sun : Moon

  return (
    <>
      <button
        type="button"
        aria-label={label}
        data-theme-toggle-preference={preference}
        data-theme-toggle-target={nextPreference}
        className={cn(
          "relative inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] shadow-sm hover:bg-[var(--surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
          className
        )}
        onClick={() => {
          setPreference(nextPreference)
          setAnnouncement((current) => {
            const text = `Appearance set to ${getThemePreferenceLabel(nextPreference)}.`
            return current === text ? `${text}${REPEAT_MARKER}` : text
          })
        }}
      >
        <span
          aria-hidden="true"
          data-theme-toggle-icon=""
          className="inline-flex size-5"
        >
          <Icon className="size-5" />
        </span>
      </button>
      <span
        data-theme-toggle-status=""
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </span>
    </>
  )
}
