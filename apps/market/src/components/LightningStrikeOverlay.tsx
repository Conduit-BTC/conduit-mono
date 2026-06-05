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
   * Total visible duration in ms (entrance + hold). Defaults to 1200ms which
   * gives the electric storm enough time to read before dismissing.
   */
  durationMs?: number
}

/**
 * LightningStrikeOverlay -- the "click registered" moment for the fast zap
 * checkout flow. Renders a darkened, click-blocking backdrop with electric
 * lightning bolts striking from ALL SIDES toward a central Zap icon, then
 * auto-dismisses by calling `onComplete()`.
 *
 * Token-driven:
 *  - backdrop: `bg-black/80 backdrop-blur-sm`
 *  - all elements: `--primary-*` scale (brand purple)
 *
 * Reduced motion: skips turbulence/scale/strike animations and shows a static
 * bolt + glow before still calling `onComplete()` after `durationMs`.
 */
export function LightningStrikeOverlay({
  open,
  onComplete,
  durationMs = 1200,
}: LightningStrikeOverlayProps) {
  const turbulenceId = useId()
  const strikeId = useId()
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
    const exitAt = Math.max(durationMs - 220, 100)
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
        "bg-black/80 backdrop-blur-sm",
        "transition-opacity duration-220 motion-reduce:transition-none",
        exiting ? "opacity-0" : "opacity-100",
      ].join(" ")}
    >
      {/* Outer shockwave ring -- massive expanding pulse */}
      <span
        aria-hidden="true"
        className={[
          "absolute h-96 w-96 rounded-full",
          "bg-[radial-gradient(circle,color-mix(in_srgb,var(--primary-400)_30%,transparent)_0%,transparent_65%)]",
          "animate-[lso-shockwave_1100ms_cubic-bezier(0.1,0.6,0.3,1)_forwards]",
          "motion-reduce:animate-none motion-reduce:opacity-60",
        ].join(" ")}
      />

      {/* Mid halo -- sharp snap-in then sustain */}
      <span
        aria-hidden="true"
        className={[
          "absolute h-56 w-56 rounded-full",
          "bg-[radial-gradient(circle,color-mix(in_sgrb,var(--primary-500)_60%,transparent)_0%,color-mix(in_srgb,var(--primary-600)_25%,transparent)_45%,transparent_75%)]",
          "animate-[lso-halo_900ms_ease-out_forwards]",
          "motion-reduce:animate-none motion-reduce:opacity-80",
        ].join(" ")}
      />

      {/* Inner core -- bright tight burst */}
      <span
        aria-hidden="true"
        className={[
          "absolute h-28 w-28 rounded-full",
          "bg-[radial-gradient(circle,color-mix(in_sgrb,var(--primary-300)_80%,transparent)_0%,transparent_70%)]",
          "animate-[lso-core_700ms_ease-out_forwards]",
          "motion-reduce:animate-none",
        ].join(" ")}
      />

      {/* Lightning bolts from ALL SIDES -- distorted by feTurbulence */}
      <svg
        aria-hidden="true"
        viewBox="-140 -140 280 280"
        className="absolute h-[520px] w-[520px] motion-reduce:hidden"
      >
        <defs>
          {/* Turbulence displacement for jagged crackle effect */}
          <filter
            id={`${turbulenceId}-crack`}
            x="-60%"
            y="-60%"
            width="220%"
            height="220%"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.65"
              numOctaves="3"
              seed="7"
            >
              <animate
                attributeName="baseFrequency"
                values="0.65;0.9;0.75"
                dur="500ms"
                repeatCount="1"
                fill="freeze"
              />
              <animate
                attributeName="seed"
                values="7;13;3;19"
                dur="800ms"
                repeatCount="1"
                fill="freeze"
              />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" scale="9" />
          </filter>

          {/* Glow filter for the strike arms */}
          <filter
            id={`${strikeId}-glow`}
            x="-40%"
            y="-40%"
            width="180%"
            height="180%"
          >
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Bright core glow */}
          <filter
            id={`${strikeId}-coreglow`}
            x="-80%"
            y="-80%"
            width="260%"
            height="260%"
          >
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Primary strike arms -- thick main channels from all 8 directions */}
        <g
          stroke="var(--primary-300)"
          strokeWidth="2.2"
          strokeLinecap="round"
          fill="none"
          filter={`url(#${turbulenceId}-crack)`}
          opacity="0"
          className="animate-[lso-strikes_800ms_ease-out_50ms_forwards]"
        >
          {/* Top */}
          <path d="M 0 0 L -8 -55 L 4 -80 L -5 -125" />
          {/* Bottom */}
          <path d="M 0 0 L 6 52 L -4 78 L 8 122" />
          {/* Left */}
          <path d="M 0 0 L -55 8 L -80 -3 L -128 5" />
          {/* Right */}
          <path d="M 0 0 L 52 -6 L 78 4 L 125 -8" />
          {/* Top-right */}
          <path d="M 0 0 L 38 -40 L 52 -62 L 88 -88" />
          {/* Bottom-right */}
          <path d="M 0 0 L 42 38 L 60 55 L 90 85" />
          {/* Bottom-left */}
          <path d="M 0 0 L -38 42 L -58 58 L -86 90" />
          {/* Top-left */}
          <path d="M 0 0 L -40 -38 L -60 -55 L -92 -84" />
        </g>

        {/* Secondary crackle branches -- thinner, more chaotic */}
        <g
          stroke="var(--primary-400)"
          strokeWidth="1.3"
          strokeLinecap="round"
          fill="none"
          filter={`url(#${turbulenceId}-crack)`}
          opacity="0"
          className="animate-[lso-crackle_900ms_ease-out_100ms_forwards]"
        >
          {/* Branching off main axes */}
          <path d="M 0 0 L -12 -45 L 18 -70" />
          <path d="M 0 0 L 15 48 L -20 65" />
          <path d="M 0 0 L -48 12 L -68 -22" />
          <path d="M 0 0 L 45 -15 L 70 18" />
          <path d="M 0 0 L 28 -50 L 10 -90" />
          <path d="M 0 0 L -50 -28 L -88 -12" />
          <path d="M 0 0 L 48 30 L 75 12" />
          <path d="M 0 0 L -28 50 L -10 88" />
          {/* Short sparks in-between */}
          <path d="M 0 0 L 20 -25 L 35 -18" />
          <path d="M 0 0 L -22 20 L -30 38" />
          <path d="M 0 0 L 25 18 L 42 8" />
          <path d="M 0 0 L -18 -28 L -8 -48" />
        </g>

        {/* Glowing bright spine overlay -- pure primary-200 for the hottest core */}
        <g
          stroke="var(--primary-200)"
          strokeWidth="1"
          strokeLinecap="round"
          fill="none"
          filter={`url(#${strikeId}-glow)`}
          opacity="0"
          className="animate-[lso-spine_700ms_ease-out_80ms_forwards]"
        >
          <path d="M 0 0 L -6 -54 L 3 -78" />
          <path d="M 0 0 L 5 51 L -3 76" />
          <path d="M 0 0 L -54 6 L -78 -2" />
          <path d="M 0 0 L 51 -5 L 76 3" />
          <path d="M 0 0 L 37 -39 L 50 -60" />
          <path d="M 0 0 L 40 37 L 58 53" />
          <path d="M 0 0 L -37 40 L -57 56" />
          <path d="M 0 0 L -39 -37 L -59 -53" />
        </g>
      </svg>

      {/* Bolt icon -- scales in with electric snap */}
      <span
        className={[
          "relative z-10 flex h-24 w-24 items-center justify-center rounded-full",
          "border-2 border-[color-mix(in_srgb,var(--primary-300)_70%,transparent)]",
          "bg-[color-mix(in_srgb,var(--primary-600)_35%,transparent)]",
          "text-[var(--primary-200)]",
          "shadow-[0_0_80px_color-mix(in_srgb,var(--primary-500)_80%,transparent),0_0_160px_color-mix(in_srgb,var(--primary-600)_40%,transparent)]",
          "animate-[lso-bolt_900ms_cubic-bezier(0.15,0.9,0.25,1)_forwards]",
          "motion-reduce:animate-none motion-reduce:scale-100",
        ].join(" ")}
      >
        <Zap className="h-12 w-12 fill-current" strokeWidth={1} />
      </span>

      {/* Inline keyframes scoped to this overlay */}
      <style>{`
        @keyframes lso-bolt {
          0%   { transform: scale(0.3) rotate(-15deg); opacity: 0; }
          25%  { transform: scale(1.25) rotate(3deg);  opacity: 1; }
          50%  { transform: scale(0.95) rotate(-1deg); opacity: 1; }
          75%  { transform: scale(1.05) rotate(0deg);  opacity: 1; }
          100% { transform: scale(1) rotate(0deg);     opacity: 0.9; }
        }
        @keyframes lso-shockwave {
          0%   { transform: scale(0.3);  opacity: 0; }
          20%  { transform: scale(0.7);  opacity: 0.85; }
          60%  { transform: scale(1.2);  opacity: 0.5; }
          100% { transform: scale(1.9);  opacity: 0; }
        }
        @keyframes lso-halo {
          0%   { transform: scale(0.4);  opacity: 0; }
          30%  { transform: scale(1.05); opacity: 0.9; }
          70%  { transform: scale(1.1);  opacity: 0.7; }
          100% { transform: scale(1.25); opacity: 0; }
        }
        @keyframes lso-core {
          0%   { transform: scale(0);    opacity: 0; }
          15%  { transform: scale(1.3);  opacity: 1; }
          50%  { transform: scale(1.0);  opacity: 0.6; }
          100% { transform: scale(1.2);  opacity: 0; }
        }
        @keyframes lso-strikes {
          0%   { opacity: 0; stroke-dashoffset: 1; }
          15%  { opacity: 1; }
          70%  { opacity: 0.8; }
          100% { opacity: 0; }
        }
        @keyframes lso-crackle {
          0%   { opacity: 0; }
          20%  { opacity: 0.85; }
          65%  { opacity: 0.6; }
          100% { opacity: 0; }
        }
        @keyframes lso-spine {
          0%   { opacity: 0; }
          10%  { opacity: 0.9; }
          50%  { opacity: 0.5; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}
