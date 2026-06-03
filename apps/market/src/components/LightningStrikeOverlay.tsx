import { Zap } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

export interface LightningStrikeOverlayProps {
  /** Render the overlay. Becomes visible immediately when set true. */
  open: boolean
  /**
   * Called once the entrance animation has finished playing. Use this to
   * allow the underlying tracker to take focus / clear `overlayPlaying` state.
   * Fires exactly once per `open` cycle.
   */
  onComplete: () => void
  /**
   * Total visible duration in ms (entrance + hold). Defaults to 900ms which is
   * long enough to register the click moment without delaying the actual
   * payment work running underneath.
   */
  durationMs?: number
}

/**
 * LightningStrikeOverlay -- the "click registered" moment for the fast zap
 * checkout flow. Renders a darkened, click-blocking backdrop with a SVG
 * lightning bolt and electric tendrils, then auto-dismisses by calling
 * `onComplete()`.
 *
 * Token-driven:
 *  - backdrop: `bg-black/72 backdrop-blur-sm` (matches Dialog overlay)
 *  - bolt + tendrils: `--secondary-400` (lightning) / `--primary-500` (purple halo)
 *
 * Reduced motion: skips the turbulence/scale animations and shows a static
 * bolt + glow before still calling `onComplete()` after `durationMs`.
 */
export function LightningStrikeOverlay({
  open,
  onComplete,
  durationMs = 900,
}: LightningStrikeOverlayProps) {
  const turbulenceId = useId()
  const completedRef = useRef(false)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (!open) {
      completedRef.current = false
      setExiting(false)
      return
    }
    completedRef.current = false
    setExiting(false)
    const exitAt = Math.max(durationMs - 180, 100)
    const exitTimer = window.setTimeout(() => setExiting(true), exitAt)
    const doneTimer = window.setTimeout(() => {
      if (completedRef.current) return
      completedRef.current = true
      onComplete()
    }, durationMs)
    return () => {
      window.clearTimeout(exitTimer)
      window.clearTimeout(doneTimer)
    }
  }, [open, durationMs, onComplete])

  if (!open) return null

  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={[
        "fixed inset-0 z-50 flex items-center justify-center",
        "bg-black/72 backdrop-blur-sm",
        "transition-opacity duration-200 motion-reduce:transition-none",
        exiting ? "opacity-0" : "opacity-100",
      ].join(" ")}
    >
      {/* Outer glow ring -- expanding pulse */}
      <span
        aria-hidden="true"
        className={[
          "absolute h-72 w-72 rounded-full",
          "bg-[radial-gradient(circle,color-mix(in_srgb,var(--secondary-500)_45%,transparent)_0%,transparent_60%)]",
          "animate-[lightning-strike-pulse_900ms_ease-out_forwards]",
          "motion-reduce:animate-none motion-reduce:opacity-70",
        ].join(" ")}
      />

      {/* Inner halo -- short snap-in */}
      <span
        aria-hidden="true"
        className={[
          "absolute h-40 w-40 rounded-full",
          "bg-[radial-gradient(circle,color-mix(in_srgb,var(--primary-500)_55%,transparent)_0%,transparent_70%)]",
          "animate-[lightning-strike-halo_700ms_ease-out_forwards]",
          "motion-reduce:animate-none motion-reduce:opacity-80",
        ].join(" ")}
      />

      {/* SVG tendrils -- electric arcs distorted by feTurbulence */}
      <svg
        aria-hidden="true"
        viewBox="-100 -100 200 200"
        className="absolute h-80 w-80 motion-reduce:hidden"
      >
        <defs>
          <filter
            id={`${turbulenceId}-disp`}
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.9"
              numOctaves="2"
              seed="3"
            >
              <animate
                attributeName="seed"
                values="3;7;11"
                dur="600ms"
                repeatCount="1"
                fill="freeze"
              />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" scale="6" />
          </filter>
        </defs>
        <g
          stroke="var(--secondary-400)"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
          filter={`url(#${turbulenceId}-disp)`}
          opacity="0"
          className="animate-[lightning-strike-tendrils_700ms_ease-out_120ms_forwards]"
        >
          <path d="M 0 0 L 70 -30" />
          <path d="M 0 0 L -70 -25" />
          <path d="M 0 0 L 65 35" />
          <path d="M 0 0 L -65 40" />
          <path d="M 0 0 L 25 -75" />
          <path d="M 0 0 L -20 78" />
        </g>
      </svg>

      {/* Bolt -- scales in, holds, fades out */}
      <span
        className={[
          "relative flex h-24 w-24 items-center justify-center rounded-full",
          "border border-[color-mix(in_srgb,var(--secondary-400)_55%,transparent)]",
          "bg-[color-mix(in_srgb,var(--secondary-500)_18%,transparent)]",
          "text-[var(--secondary-400)]",
          "shadow-[0_0_60px_color-mix(in_srgb,var(--secondary-500)_55%,transparent)]",
          "animate-[lightning-strike-bolt_800ms_cubic-bezier(0.2,0.9,0.3,1)_forwards]",
          "motion-reduce:animate-none motion-reduce:scale-100",
        ].join(" ")}
      >
        <Zap className="h-12 w-12 fill-current" strokeWidth={1.5} />
      </span>

      {/* Inline keyframes scoped to this overlay -- avoids tailwind plugin churn */}
      <style>{`
        @keyframes lightning-strike-bolt {
          0%   { transform: scale(0.4) rotate(-12deg); opacity: 0; }
          35%  { transform: scale(1.15) rotate(0deg);   opacity: 1; }
          60%  { transform: scale(1) rotate(0deg);      opacity: 1; }
          100% { transform: scale(0.96) rotate(0deg);   opacity: 0.85; }
        }
        @keyframes lightning-strike-pulse {
          0%   { transform: scale(0.4); opacity: 0; }
          40%  { transform: scale(1);    opacity: 0.9; }
          100% { transform: scale(1.6);  opacity: 0; }
        }
        @keyframes lightning-strike-halo {
          0%   { transform: scale(0.6); opacity: 0; }
          50%  { transform: scale(1.05); opacity: 0.95; }
          100% { transform: scale(1.2);  opacity: 0; }
        }
        @keyframes lightning-strike-tendrils {
          0%   { opacity: 0; }
          30%  { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}
