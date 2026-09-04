import { useEffect, useState } from "react"
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
  const [feedback, setFeedback] = useState<{
    preference: ThemePreference
    visible: boolean
  } | null>(null)

  useEffect(() => {
    if (!feedback?.visible) return
    const timeout = window.setTimeout(() => {
      setFeedback((current) =>
        current === feedback ? { ...current, visible: false } : current
      )
    }, 1_000)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  const nextPreference = getNextThemePreferenceInCycle(preference, cycle)
  const label = `Appearance: ${getThemePreferenceLabel(preference)}. Switch to ${getThemePreferenceLabel(nextPreference)}`
  const feedbackLabel = feedback
    ? getThemePreferenceLabel(feedback.preference)
    : ""
  const feedbackVisible =
    feedback?.visible && feedback.preference === preference
  const Icon =
    preference === "system" ? SunMoon : preference === "day-market" ? Sun : Moon

  return (
    <span className="relative inline-flex shrink-0">
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
        onClick={() => {
          setPreference(nextPreference)
          setFeedback({ preference: nextPreference, visible: true })
        }}
      >
        <Icon className="size-5" aria-hidden="true" />
      </button>
      <span
        aria-hidden="true"
        data-theme-toggle-feedback=""
        data-state={feedbackVisible ? "visible" : "hidden"}
        className={cn(
          "pointer-events-none absolute right-0 top-full z-50 mt-1.5 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface-overlay)] px-2.5 py-1.5 text-xs font-medium leading-4 text-[var(--text-primary)] shadow-sm transition-opacity duration-150 motion-reduce:transition-none",
          feedbackVisible ? "opacity-100" : "opacity-0"
        )}
      >
        {feedbackLabel}
      </span>
      <span
        data-theme-toggle-status=""
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {feedbackLabel ? `Appearance set to ${feedbackLabel}.` : ""}
      </span>
    </span>
  )
}
