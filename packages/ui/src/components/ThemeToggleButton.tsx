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

const compactPreferenceLabels: Record<ThemePreference, string> = {
  system: "System",
  "day-market": "Day",
  "night-market": "Night",
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
    }, 320)
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
          setFeedback({ preference: nextPreference, visible: true })
        }}
      >
        <span
          aria-hidden="true"
          data-theme-toggle-icon=""
          className={cn(
            "inline-flex size-5 transition-[opacity,transform] duration-[80ms] ease-out motion-reduce:transform-none motion-reduce:transition-none",
            feedbackVisible ? "scale-90 opacity-0" : "scale-100 opacity-100"
          )}
        >
          <Icon className="size-5" />
        </span>
        <span
          aria-hidden="true"
          data-theme-toggle-feedback=""
          data-state={feedbackVisible ? "visible" : "hidden"}
          className={cn(
            "pointer-events-none absolute inset-0 flex items-center justify-center whitespace-nowrap text-[11px] font-medium leading-none transition-[opacity,transform] duration-[80ms] ease-out motion-reduce:transform-none motion-reduce:transition-none",
            feedbackVisible
              ? "translate-y-0 opacity-100"
              : "translate-y-0.5 opacity-0"
          )}
        >
          {feedback ? compactPreferenceLabels[feedback.preference] : ""}
        </span>
      </button>
      <span
        data-theme-toggle-status=""
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {feedbackLabel ? `Appearance set to ${feedbackLabel}.` : ""}
      </span>
    </>
  )
}
