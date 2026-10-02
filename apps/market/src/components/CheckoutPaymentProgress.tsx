import { useEffect, useState } from "react"
import { LoaderCircle } from "lucide-react"

const LOADING_LINES = [
  "HODLing the door…",
  "Teaching ostriches to relay race…",
  "Tiny money. Big adventure.",
  "Somewhere, a banker just sighed.",
  "Proof of patience…",
  "Taking the secret warp pipe…",
  "Checking behind the waterfall…",
  "Rolling for initiative…",
  "Calibrating the flux capacitor…",
  "Resisting the urge to start another side quest…",
  "Politely asking the progress bar to progress…",
  "Doing computer things. Very important computer things.",
  "Consulting the council of rubber ducks…",
  "Giving the hamster a tiny espresso…",
  "Loading a better loading message…",
  "Teaching lightning some manners…",
  "Giving the internet’s plumbing a pep talk…",
  "Putting the fun in funds…",
] as const

/** Presentation only: this component cannot advance or confirm a payment. */
export function CheckoutPaymentProgress({ pausing }: { pausing: boolean }) {
  const [line, setLine] = useState(0)

  useEffect(() => {
    if (pausing) return
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)")
    let timer: ReturnType<typeof setInterval> | undefined
    const updateRotation = () => {
      clearInterval(timer)
      timer = undefined
      if (!preference.matches) {
        timer = setInterval(
          () => setLine((previous) => (previous + 1) % LOADING_LINES.length),
          5_000
        )
      }
    }
    updateRotation()
    preference.addEventListener("change", updateRotation)
    return () => {
      clearInterval(timer)
      preference.removeEventListener("change", updateRotation)
    }
  }, [pausing])

  const status = pausing ? "Pausing safely…" : "Completing your payment…"
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-sm font-medium"
      >
        <LoaderCircle
          className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {status}
      </div>
      <div
        role="progressbar"
        aria-label={status}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--surface)]"
      >
        <div className="h-full w-full animate-pulse rounded-full bg-[var(--accent)] motion-reduce:animate-none" />
      </div>
      {pausing ? (
        <p className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
          Waiting for the current operation to finish. Please don&apos;t pay
          again.
        </p>
      ) : (
        <>
          <p
            aria-hidden="true"
            className="mt-2 text-xs leading-5 text-[var(--text-secondary)]"
          >
            {LOADING_LINES[line]}
          </p>
          <p className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">
            Please keep this page open while we check your payment.
          </p>
        </>
      )}
    </div>
  )
}
