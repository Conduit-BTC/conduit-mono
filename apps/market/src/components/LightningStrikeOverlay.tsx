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
   * Total visible duration in ms (entrance + hold). Defaults to 1300ms which
   * gives the electric storm enough time to strobe and fade.
   */
  durationMs?: number
}

interface BoltPath {
  d: string
}

/**
 * Recursively generate a jagged lightning bolt with random branching forks.
 * Each segment is offset perpendicular to the main axis with sin-tapered
 * jitter so the endpoints stay anchored. Branches recurse twice for natural
 * organic-looking forks (e.g. main strike -> sub-branch -> small spark).
 */
function generateLightningBolt(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  segments: number,
  jitter: number,
  depth: number = 0
): BoltPath[] {
  const result: BoltPath[] = []
  const points: { x: number; y: number }[] = []

  const dx = endX - startX
  const dy = endY - startY
  const stepX = dx / segments
  const stepY = dy / segments
  const baseAngle = Math.atan2(dy, dx)
  const perpAngle = baseAngle + Math.PI / 2

  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    // Sin-taper keeps endpoints anchored, peaks jitter at the midpoint.
    const taper = Math.sin(t * Math.PI)
    const offset = (Math.random() - 0.5) * jitter * taper
    points.push({
      x: startX + stepX * i + Math.cos(perpAngle) * offset,
      y: startY + stepY * i + Math.sin(perpAngle) * offset,
    })
  }

  result.push({
    d: points
      .map(
        (p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`
      )
      .join(" "),
  })

  if (depth < 2) {
    // Main strikes branch more aggressively than sub-branches.
    const branchCount =
      depth === 0
        ? 3 + Math.floor(Math.random() * 3)
        : Math.floor(Math.random() * 2) + 1
    const totalLen = Math.hypot(dx, dy)

    for (let b = 0; b < branchCount; b++) {
      // Pick a random middle vertex as the branch root.
      const branchIdx = 1 + Math.floor(Math.random() * (points.length - 2))
      const root = points[branchIdx]
      const branchAngle = baseAngle + (Math.random() - 0.5) * 1.4
      const branchLength = totalLen * (0.18 + Math.random() * 0.45)
      const ex = root.x + Math.cos(branchAngle) * branchLength
      const ey = root.y + Math.sin(branchAngle) * branchLength
      result.push(
        ...generateLightningBolt(
          root.x,
          root.y,
          ex,
          ey,
          Math.max(4, Math.floor(segments * 0.6)),
          jitter * 0.65,
          depth + 1
        )
      )
    }
  }

  return result
}

/**
 * LightningStrikeOverlay -- the "click registered" moment for the fast zap
 * checkout flow. Renders a full-viewport storm of branching purple lightning
 * bolts radiating from a glowing central aura, then auto-dismisses by
 * calling `onComplete()`.
 *
 * Token-driven (`--primary-*` scale only):
 *  - backdrop: `bg-black/85 backdrop-blur-sm`
 *  - bolts: layered soft-glow + mid + bright-core for realistic light bleed
 *  - center: aura halo + ringed bolt icon
 *
 * Reduced motion: hides the procedural lightning storm and shows a static
 * ringed bolt before still calling `onComplete()` after `durationMs`.
 */
export function LightningStrikeOverlay({
  open,
  onComplete,
  durationMs = 1300,
}: LightningStrikeOverlayProps) {
  const filterId = useId()
  const completedRef = useRef(false)
  const onCompleteRef = useRef(onComplete)
  const [exiting, setExiting] = useState(false)
  const [bolts, setBolts] = useState<BoltPath[]>([])
  const [size, setSize] = useState({ w: 1280, h: 800 })

  // Keep onComplete fresh without re-running the main effect (parents
  // commonly pass `() => setX(false)` which is a new function each render).
  useEffect(() => {
    onCompleteRef.current = onComplete
  })

  useEffect(() => {
    if (!open) {
      completedRef.current = false
      setExiting(false)
      setBolts([])
      return
    }
    completedRef.current = false
    setExiting(false)

    const w = window.innerWidth
    const h = window.innerHeight
    setSize({ w, h })

    // Start strikes from just outside the central aura so they look like
    // they emerge from the orb. Reach overshoots the viewport so branches
    // never end abruptly mid-screen.
    const cx = w / 2
    const cy = h / 2
    const startRadius = 70
    const maxReach = Math.max(w, h) * 1.05
    const strikeCount = 13
    const newBolts: BoltPath[] = []

    for (let i = 0; i < strikeCount; i++) {
      const baseAngle =
        (i / strikeCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.5
      const reach = maxReach * (0.55 + Math.random() * 0.5)
      const sx = cx + Math.cos(baseAngle) * startRadius
      const sy = cy + Math.sin(baseAngle) * startRadius
      const ex = cx + Math.cos(baseAngle) * reach
      const ey = cy + Math.sin(baseAngle) * reach
      const segments = 9 + Math.floor(Math.random() * 5)
      const jitter = Math.min(w, h) * 0.05
      newBolts.push(...generateLightningBolt(sx, sy, ex, ey, segments, jitter))
    }

    setBolts(newBolts)

    const exitAt = Math.max(durationMs - 280, 100)
    const exitTimer = window.setTimeout(() => setExiting(true), exitAt)
    const doneTimer = window.setTimeout(() => {
      if (completedRef.current) return
      completedRef.current = true
      onCompleteRef.current()
    }, durationMs)
    return () => {
      window.clearTimeout(exitTimer)
      window.clearTimeout(doneTimer)
    }
  }, [open, durationMs])

  if (!open) return null

  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={[
        "fixed inset-0 z-50 flex items-center justify-center overflow-hidden",
        "bg-black/85 backdrop-blur-sm",
        "transition-opacity duration-300 motion-reduce:transition-none",
        exiting ? "opacity-0" : "opacity-100",
      ].join(" ")}
    >
      {/* Full-viewport lightning storm */}
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${size.w} ${size.h}`}
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full motion-reduce:hidden"
      >
        <defs>
          <filter
            id={`${filterId}-soft`}
            x="-10%"
            y="-10%"
            width="120%"
            height="120%"
          >
            <feGaussianBlur stdDeviation="5" />
          </filter>
          <filter
            id={`${filterId}-bright`}
            x="-5%"
            y="-5%"
            width="110%"
            height="110%"
          >
            <feGaussianBlur stdDeviation="0.8" />
          </filter>
        </defs>

        {/* Soft outer glow -- large blurred halo behind each bolt */}
        <g
          stroke="var(--primary-500)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0"
          filter={`url(#${filterId}-soft)`}
          className="animate-[lso-soft_1100ms_ease-out_30ms_forwards]"
        >
          {bolts.map((b, i) => (
            <path key={`s-${i}`} d={b.d} />
          ))}
        </g>

        {/* Mid layer -- visible bolt body */}
        <g
          stroke="var(--primary-300)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0"
          className="animate-[lso-mid_1100ms_ease-out_60ms_forwards]"
        >
          {bolts.map((b, i) => (
            <path key={`m-${i}`} d={b.d} />
          ))}
        </g>

        {/* Bright core -- the hot white-purple thread inside */}
        <g
          stroke="var(--primary-100)"
          strokeWidth="0.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0"
          filter={`url(#${filterId}-bright)`}
          className="animate-[lso-core_1100ms_ease-out_80ms_forwards]"
        >
          {bolts.map((b, i) => (
            <path key={`c-${i}`} d={b.d} />
          ))}
        </g>
      </svg>

      {/* Central aura -- large glowing orb behind the ring */}
      <span
        aria-hidden="true"
        className={[
          "absolute h-72 w-72 rounded-full",
          "bg-[radial-gradient(circle,color-mix(in_srgb,var(--primary-400)_55%,transparent)_0%,color-mix(in_srgb,var(--primary-600)_25%,transparent)_45%,transparent_75%)]",
          "animate-[lso-aura_1200ms_ease-out_forwards]",
          "motion-reduce:animate-none motion-reduce:opacity-70",
        ].join(" ")}
      />

      {/* Bright ring -- the magenta-purple disc the bolt sits inside */}
      <span
        aria-hidden="true"
        className={[
          "absolute h-36 w-36 rounded-full",
          "border-2 border-[color-mix(in_srgb,var(--primary-300)_85%,transparent)]",
          "bg-[radial-gradient(circle,color-mix(in_srgb,var(--primary-300)_25%,transparent)_0%,transparent_70%)]",
          "shadow-[0_0_50px_color-mix(in_srgb,var(--primary-400)_75%,transparent),0_0_120px_color-mix(in_srgb,var(--primary-500)_50%,transparent)]",
          "animate-[lso-ring_1100ms_cubic-bezier(0.15,0.9,0.3,1)_forwards]",
          "motion-reduce:animate-none motion-reduce:scale-100",
        ].join(" ")}
      />

      {/* Bolt icon -- bright center */}
      <span
        aria-hidden="true"
        className={[
          "relative z-10 flex h-20 w-20 items-center justify-center",
          "text-[var(--primary-100)]",
          "drop-shadow-[0_0_18px_color-mix(in_srgb,var(--primary-300)_85%,transparent)]",
          "animate-[lso-bolt_1100ms_cubic-bezier(0.15,0.9,0.25,1)_forwards]",
          "motion-reduce:animate-none motion-reduce:scale-100",
        ].join(" ")}
      >
        <Zap
          className="h-12 w-12 fill-[var(--primary-100)]"
          strokeWidth={1.5}
        />
      </span>

      {/* Inline keyframes -- strobing flicker simulates real lightning */}
      <style>{`
        @keyframes lso-bolt {
          0%   { transform: scale(0.4) rotate(-12deg); opacity: 0; }
          25%  { transform: scale(1.25) rotate(3deg);  opacity: 1; }
          45%  { transform: scale(0.95) rotate(-1deg); opacity: 1; }
          70%  { transform: scale(1.05);               opacity: 1; }
          100% { transform: scale(1);                  opacity: 1; }
        }
        @keyframes lso-aura {
          0%   { transform: scale(0.5);  opacity: 0; }
          25%  { transform: scale(1.1);  opacity: 1; }
          70%  { transform: scale(1);    opacity: 0.85; }
          100% { transform: scale(1.15); opacity: 0; }
        }
        @keyframes lso-ring {
          0%   { transform: scale(0.4);  opacity: 0; }
          20%  { transform: scale(1.15); opacity: 1; }
          50%  { transform: scale(0.95); opacity: 1; }
          80%  { transform: scale(1.05); opacity: 0.9; }
          100% { transform: scale(1.1);  opacity: 0; }
        }
        @keyframes lso-soft {
          0%   { opacity: 0; }
          12%  { opacity: 1; }
          22%  { opacity: 0.55; }
          32%  { opacity: 1; }
          50%  { opacity: 0.7; }
          80%  { opacity: 0.35; }
          100% { opacity: 0; }
        }
        @keyframes lso-mid {
          0%   { opacity: 0; }
          10%  { opacity: 1; }
          20%  { opacity: 0.65; }
          30%  { opacity: 1; }
          55%  { opacity: 0.5; }
          80%  { opacity: 0.25; }
          100% { opacity: 0; }
        }
        @keyframes lso-core {
          0%   { opacity: 0; }
          8%   { opacity: 1; }
          18%  { opacity: 0.6; }
          28%  { opacity: 1; }
          50%  { opacity: 0.55; }
          80%  { opacity: 0.25; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}
