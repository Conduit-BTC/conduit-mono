import { useEffect, useState } from "react"

export function CheckoutSparkFundingExpiry({
  expiresAt,
  now = Date.now,
}: {
  expiresAt: number
  now?: () => number
}) {
  const [nowMs, setNowMs] = useState(now)
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - nowMs) / 1_000))
  const expired = remainingSeconds === 0
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  const expiresAtDate = new Date(expiresAt)

  useEffect(() => {
    if (expired) return
    const timer = window.setInterval(() => setNowMs(now()), 1_000)
    return () => window.clearInterval(timer)
  }, [expired, expiresAt, now])

  return (
    <p className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">
      <span className="font-medium text-[var(--text-primary)]">
        Funding invoice expires at
      </span>{" "}
      <time dateTime={expiresAtDate.toISOString()}>
        {expiresAtDate.toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "medium",
        })}
      </time>
      <span className="block text-[var(--secondary)]">
        {expired ? (
          "Time has ended; do not pay this invoice."
        ) : (
          <span aria-label={`${minutes} minutes and ${seconds} seconds left`}>
            {minutes}:{String(seconds).padStart(2, "0")} left
          </span>
        )}
      </span>
    </p>
  )
}
