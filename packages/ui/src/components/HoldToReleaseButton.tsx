import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import { Button, type ButtonProps } from "./Button"
import { cn } from "../utils"

export type HoldToReleaseState = "idle" | "holding" | "charged"

export interface HoldToReleaseButtonProps extends Omit<
  ButtonProps,
  | "onClick"
  | "onKeyDown"
  | "onKeyUp"
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
> {
  holdDurationMs?: number
  haptics?: boolean
  canComplete?: () => boolean
  onHoldComplete: () => void
  holdingLabel?: string
  chargedLabel?: string
}

function vibrate(pattern: number | number[]): void {
  if (typeof navigator === "undefined" || !navigator.vibrate) return
  try {
    navigator.vibrate(pattern)
  } catch {
    // Haptics are progressive enhancement and may be denied by the browser.
  }
}

export function HoldToReleaseButton({
  children,
  className,
  disabled = false,
  holdDurationMs = 1_400,
  haptics = true,
  canComplete,
  onHoldComplete,
  holdingLabel = "Keep holding",
  chargedLabel = "Release to confirm",
  ...props
}: HoldToReleaseButtonProps) {
  const [state, setState] = useState<HoldToReleaseState>("idle")
  const stateRef = useRef<HoldToReleaseState>("idle")
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = useRef(0)
  const pointerIdRef = useRef<number | null>(null)
  const keyRef = useRef<" " | "Enter" | null>(null)
  const firedRef = useRef(false)
  const statusId = useId()

  const updateState = useCallback((next: HoldToReleaseState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const cancel = useCallback(() => {
    generationRef.current += 1
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    pointerIdRef.current = null
    keyRef.current = null
    firedRef.current = false
    updateState("idle")
    if (haptics) vibrate(0)
  }, [haptics, updateState])

  const arm = useCallback(() => {
    if (disabled || stateRef.current !== "idle") return
    const generation = ++generationRef.current
    firedRef.current = false
    updateState("holding")
    if (haptics) vibrate(8)
    timerRef.current = setTimeout(
      () => {
        if (generationRef.current !== generation || disabled) return
        timerRef.current = null
        updateState("charged")
        if (haptics) vibrate(24)
      },
      Math.max(1, holdDurationMs)
    )
  }, [disabled, haptics, holdDurationMs, updateState])

  const release = useCallback(() => {
    if (stateRef.current !== "charged" || firedRef.current) {
      cancel()
      return
    }
    if (canComplete && !canComplete()) {
      cancel()
      return
    }

    firedRef.current = true
    generationRef.current += 1
    pointerIdRef.current = null
    keyRef.current = null
    updateState("idle")
    if (haptics) vibrate([12, 28, 30])
    onHoldComplete()
  }, [canComplete, cancel, haptics, onHoldComplete, updateState])

  useEffect(
    () => () => {
      generationRef.current += 1
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
      pointerIdRef.current = null
      keyRef.current = null
      if (!firedRef.current && haptics) vibrate(0)
    },
    [haptics]
  )

  useEffect(() => {
    if (disabled && stateRef.current !== "idle") cancel()
  }, [cancel, disabled])

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && stateRef.current !== "idle") cancel()
    }
    const onVisibilityChange = () => {
      if (document.hidden && stateRef.current !== "idle") cancel()
    }
    window.addEventListener("keydown", onEscape)
    window.addEventListener("blur", cancel)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("keydown", onEscape)
      window.removeEventListener("blur", cancel)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [cancel])

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || pointerIdRef.current !== null || disabled) return
    event.preventDefault()
    pointerIdRef.current = event.pointerId
    event.currentTarget.setPointerCapture(event.pointerId)
    arm()
  }

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (pointerIdRef.current !== event.pointerId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const releasedInside =
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!releasedInside) {
      cancel()
      return
    }
    release()
  }

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (pointerIdRef.current !== event.pointerId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const isOutside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    if (!isOutside) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    cancel()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      event.repeat ||
      disabled ||
      keyRef.current ||
      (event.key !== " " && event.key !== "Enter")
    ) {
      return
    }
    event.preventDefault()
    keyRef.current = event.key
    arm()
  }

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (keyRef.current !== event.key) return
    event.preventDefault()
    release()
  }

  const statusLabel =
    state === "charged"
      ? chargedLabel
      : state === "holding"
        ? holdingLabel
        : null

  return (
    <Button
      {...props}
      disabled={disabled}
      aria-describedby={statusId}
      aria-busy={state === "holding"}
      data-hold-state={state}
      className={cn(
        "relative isolate overflow-hidden select-none touch-none",
        state === "charged" && "ring-2 ring-warning/70",
        className
      )}
      style={
        {
          ...props.style,
          "--hold-duration": `${Math.max(1, holdDurationMs)}ms`,
        } as CSSProperties
      }
      onClick={(event) => event.preventDefault()}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        if (!firedRef.current && pointerIdRef.current !== null) cancel()
      }}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={cancel}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-0 -z-10 origin-left scale-x-0 bg-white/20",
          state === "holding" &&
            "scale-x-100 transition-transform [transition-duration:var(--hold-duration)] [transition-timing-function:linear] motion-reduce:transition-none",
          state === "charged" && "scale-x-100 bg-warning/30"
        )}
      />
      <span className="relative inline-flex items-center justify-center gap-2">
        {children}
      </span>
      <span id={statusId} className="sr-only" role="status" aria-live="polite">
        {statusLabel ?? "Hold, then release to confirm"}
      </span>
    </Button>
  )
}
