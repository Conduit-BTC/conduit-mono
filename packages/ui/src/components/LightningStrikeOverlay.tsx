import { Zap } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

export interface LightningStrikeOverlayProps {
  /** Render a decorative payment effect without blocking the current action. */
  open: boolean
  /**
   * Called once the entrance animation has finished playing. Use this to
   * clear the presentation state.
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
  depth: number
  /**
   * Hero bolts are the 1-2 dominant main strikes; they render with thicker
   * stroke widths and a white-hot core. All branches inherit the parent
   * strike's hero-ness so a hero strike is bright all the way to its tips.
   */
  isHero: boolean
}

interface BranchSeed {
  x: number
  y: number
  angle: number
  length: number
  depth: number
  isHero: boolean
}

const MAX_BOLT_PATHS = 160
const BRANCH_LIMITS = [4, 3, 2, 0] as const
const branchWidth = (base: number, depth: number) => base * 0.68 ** depth

/**
 * Grow a bounded set of wandering channels from the center. Each channel
 * changes direction gradually and can sprout shorter lateral branches along
 * its length. Processing breadth first keeps every main channel visible even
 * when the path budget is reached.
 */
function generateLightningPaths(w: number, h: number): BoltPath[] {
  const cx = w / 2
  const cy = h / 2
  const reach = Math.max(w, h) * 1.08
  const rootCount = 5
  const heroIndex = Math.floor(Math.random() * rootCount)
  const queue: BranchSeed[] = Array.from({ length: rootCount }, (_, i) => {
    const isHero = i === heroIndex || i === (heroIndex + 2) % rootCount
    return {
      x: cx,
      y: cy,
      angle: (i / rootCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.8,
      length:
        reach *
        (isHero ? 0.9 + Math.random() * 0.2 : 0.7 + Math.random() * 0.25),
      depth: 0,
      isHero,
    }
  })
  const paths: BoltPath[] = []
  const baseStep = Math.max(9, Math.min(w, h) * 0.027)

  for (
    let index = 0;
    index < queue.length && paths.length < MAX_BOLT_PATHS;
    index++
  ) {
    const seed = queue[index]
    const steps = Math.max(
      5,
      Math.ceil(seed.length / (baseStep * 0.82 ** seed.depth))
    )
    const points = [{ x: seed.x, y: seed.y }]
    const branchLimit = BRANCH_LIMITS[seed.depth] ?? 0
    let x = seed.x
    let y = seed.y
    let heading = seed.angle
    let turn = 0
    let branches = 0
    let lastFork = -4

    for (let step = 1; step <= steps; step++) {
      // Correlated turns produce tortuous channels without independent zigzags.
      turn =
        turn * 0.58 + (Math.random() - 0.5) * (seed.depth === 0 ? 0.32 : 0.42)
      heading += turn + Math.sin(seed.angle - heading) * 0.06
      const stride = (seed.length / steps) * (0.8 + Math.random() * 0.4)
      x += Math.cos(heading) * stride
      y += Math.sin(heading) * stride
      points.push({ x, y })

      if (
        branches < branchLimit &&
        step >= 3 &&
        step <= steps - 2 &&
        step - lastFork >= 4 &&
        Math.random() < (seed.depth === 0 ? 0.22 : 0.18)
      ) {
        const side = Math.random() < 0.5 ? -1 : 1
        queue.push({
          x,
          y,
          angle: heading + side * (0.4 + Math.random() * 0.65),
          length: seed.length * (0.38 + Math.random() * 0.22),
          depth: seed.depth + 1,
          isHero: seed.isHero,
        })
        branches++
        lastFork = step
      }
    }

    paths.push({
      d: points
        .map(
          (point, i) =>
            `${i === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
        )
        .join(" "),
      depth: seed.depth,
      isHero: seed.isHero,
    })
  }

  return paths
}

/**
 * LightningStrikeOverlay celebrates a Lightning payment result. It renders a
 * decorative full-viewport storm, then dismisses via `onComplete()`.
 *
 * Token-driven (`--primary-*` scale only):
 *  - bolts: layered soft-glow + mid + bright-core; 1-2 hero strikes get a
 *    thicker stroke and a white-hot `--primary-50` core for natural
 *    real-lightning hierarchy where one channel dominates.
 *  - center: compact purple glow behind the bolt icon
 *
 * Reduced motion: hides the procedural lightning storm and shows a static
 * bolt before still calling `onComplete()` after `durationMs`.
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

    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches
    setBolts(reducedMotion ? [] : generateLightningPaths(w, h))

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

  const heroBolts = bolts.filter((b) => b.isHero)
  const normalBolts = bolts.filter((b) => !b.isHero)

  return (
    <div
      role="presentation"
      aria-hidden="true"
      data-testid="payment-sent-lightning"
      className={[
        "pointer-events-none fixed inset-0 z-50 flex items-center justify-center overflow-hidden",
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
            id={`${filterId}-soft-hero`}
            x="-15%"
            y="-15%"
            width="130%"
            height="130%"
          >
            <feGaussianBlur stdDeviation="9" />
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

        {/* Soft outer glow -- normal bolts (large blurred halo behind body) */}
        <g
          stroke="var(--primary-500)"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0"
          filter={`url(#${filterId}-soft)`}
          className="animate-[lso-soft_1100ms_ease-out_30ms_forwards]"
        >
          {normalBolts.map((b, i) => (
            <path
              key={`s-${i}`}
              d={b.d}
              strokeWidth={branchWidth(4, b.depth)}
            />
          ))}
        </g>

        {/* Soft outer glow -- hero bolts (fatter halo, deeper blur) */}
        <g
          stroke="var(--primary-500)"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0"
          filter={`url(#${filterId}-soft-hero)`}
          className="animate-[lso-soft-hero_1100ms_ease-out_20ms_forwards]"
        >
          {heroBolts.map((b, i) => (
            <path
              key={`sh-${i}`}
              d={b.d}
              strokeWidth={branchWidth(9, b.depth)}
            />
          ))}
        </g>

        {/* Mid layer -- normal bolt body (lavender) */}
        <g
          stroke="var(--primary-300)"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0"
          className="animate-[lso-mid_1100ms_ease-out_60ms_forwards]"
        >
          {normalBolts.map((b, i) => (
            <path
              key={`m-${i}`}
              d={b.d}
              strokeWidth={branchWidth(1.4, b.depth)}
            />
          ))}
        </g>

        {/* Mid layer -- hero bolt body (brighter lavender, thicker spine) */}
        <g
          stroke="var(--primary-200)"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0"
          className="animate-[lso-mid-hero_1100ms_ease-out_50ms_forwards]"
        >
          {heroBolts.map((b, i) => (
            <path
              key={`mh-${i}`}
              d={b.d}
              strokeWidth={branchWidth(2.6, b.depth)}
            />
          ))}
        </g>

        {/* Bright core -- normal bolts (pale lavender thread) */}
        <g
          stroke="var(--primary-100)"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0"
          filter={`url(#${filterId}-bright)`}
          className="animate-[lso-core_1100ms_ease-out_80ms_forwards]"
        >
          {normalBolts.map((b, i) => (
            <path
              key={`c-${i}`}
              d={b.d}
              strokeWidth={branchWidth(0.6, b.depth)}
            />
          ))}
        </g>

        {/* Bright core -- hero bolts (white-hot, thicker, dominant flash) */}
        <g
          stroke="var(--primary-50)"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          opacity="0"
          filter={`url(#${filterId}-bright)`}
          className="animate-[lso-core-hero_1100ms_ease-out_70ms_forwards]"
        >
          {heroBolts.map((b, i) => (
            <path
              key={`ch-${i}`}
              d={b.d}
              strokeWidth={branchWidth(1.4, b.depth)}
            />
          ))}
        </g>
      </svg>

      {/* Compact center flash covers the roots beneath the bolt icon. */}
      <span
        aria-hidden="true"
        className={[
          "absolute h-40 w-40 rounded-full",
          "bg-[radial-gradient(circle,color-mix(in_srgb,var(--primary-400)_70%,transparent)_0%,color-mix(in_srgb,var(--primary-600)_30%,transparent)_35%,transparent_72%)]",
          "animate-[lso-aura_1200ms_ease-out_forwards]",
          "motion-reduce:animate-none motion-reduce:opacity-70",
        ].join(" ")}
      />

      {/* Bolt icon -- bright center */}
      <span
        aria-hidden="true"
        className={[
          "relative z-10 flex h-20 w-20 items-center justify-center",
          "text-[var(--primary-50)]",
          "drop-shadow-[0_0_10px_color-mix(in_srgb,var(--primary-300)_85%,transparent)]",
          "animate-[lso-bolt_1100ms_cubic-bezier(0.15,0.9,0.25,1)_forwards]",
          "motion-reduce:animate-none motion-reduce:scale-100",
        ].join(" ")}
      >
        <Zap className="h-12 w-12 fill-[var(--primary-50)]" strokeWidth={1.5} />
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
        @keyframes lso-soft {
          0%   { opacity: 0; }
          12%  { opacity: 0.85; }
          22%  { opacity: 0.45; }
          32%  { opacity: 0.85; }
          50%  { opacity: 0.55; }
          80%  { opacity: 0.25; }
          100% { opacity: 0; }
        }
        @keyframes lso-soft-hero {
          0%   { opacity: 0; }
          10%  { opacity: 1; }
          20%  { opacity: 0.7; }
          32%  { opacity: 1; }
          50%  { opacity: 0.75; }
          80%  { opacity: 0.35; }
          100% { opacity: 0; }
        }
        @keyframes lso-mid {
          0%   { opacity: 0; }
          10%  { opacity: 0.85; }
          20%  { opacity: 0.55; }
          30%  { opacity: 0.85; }
          55%  { opacity: 0.4; }
          80%  { opacity: 0.2; }
          100% { opacity: 0; }
        }
        @keyframes lso-mid-hero {
          0%   { opacity: 0; }
          8%   { opacity: 1; }
          18%  { opacity: 0.7; }
          28%  { opacity: 1; }
          55%  { opacity: 0.55; }
          80%  { opacity: 0.3; }
          100% { opacity: 0; }
        }
        @keyframes lso-core {
          0%   { opacity: 0; }
          8%   { opacity: 0.9; }
          18%  { opacity: 0.5; }
          28%  { opacity: 0.9; }
          50%  { opacity: 0.45; }
          80%  { opacity: 0.2; }
          100% { opacity: 0; }
        }
        @keyframes lso-core-hero {
          0%   { opacity: 0; }
          6%   { opacity: 1; }
          16%  { opacity: 0.65; }
          26%  { opacity: 1; }
          50%  { opacity: 0.6; }
          80%  { opacity: 0.3; }
          100% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}
