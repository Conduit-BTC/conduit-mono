import { useEffect, useState } from "react"
import { hasNip07 } from "../context/AuthContext"

/**
 * Some browsers/extensions inject `window.nostr` after initial render.
 * Poll briefly so connect surfaces can update without a manual refresh.
 */
export function useNip07Availability(): boolean {
  const [available, setAvailable] = useState(() => hasNip07())

  useEffect(() => {
    if (available) return

    let attempts = 0
    const intervalId = window.setInterval(() => {
      const next = hasNip07()
      if (next) {
        setAvailable(true)
        window.clearInterval(intervalId)
        return
      }

      attempts += 1
      if (attempts >= 20) {
        window.clearInterval(intervalId)
      }
    }, 250)

    return () => window.clearInterval(intervalId)
  }, [available])

  return available
}
