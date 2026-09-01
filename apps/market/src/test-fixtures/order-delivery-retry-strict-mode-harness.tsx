import { StrictMode, useEffect } from "react"
import { createRoot } from "react-dom/client"

import { useOrderDeliveryRetryAttempt } from "../lib/order-delivery-retry"

export async function probeStrictModeOrderDeliveryRetry(): Promise<{
  effectSetups: number
  signalAborted: boolean
}> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let effectSetups = 0
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  let resolveSignal!: (aborted: boolean) => void
  const signalResult = new Promise<boolean>((resolve) => {
    resolveSignal = resolve
  })

  function Probe() {
    const beginAttempt = useOrderDeliveryRetryAttempt("strict-mode-buyer")
    useEffect(() => {
      effectSetups += 1
      if (effectSetups >= 2) resolveReady()
    }, [])
    return (
      <button
        type="button"
        onClick={() => {
          const attempt = beginAttempt()
          resolveSignal(attempt.signal.aborted)
          attempt.finish()
        }}
      >
        Retry delivery
      </button>
    )
  }

  try {
    root.render(
      <StrictMode>
        <Probe />
      </StrictMode>
    )
    await ready
    const button = container.querySelector("button")
    if (!button) throw new Error("StrictMode retry probe did not render.")
    button.click()
    return {
      effectSetups,
      signalAborted: await signalResult,
    }
  } finally {
    root.unmount()
    container.remove()
  }
}
