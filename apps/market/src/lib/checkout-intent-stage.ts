import {
  parseCheckoutIntentFragment,
  type CheckoutIntentParseResult,
} from "@conduit/core"

import { clearCheckoutReferral } from "./checkout-referral"

const KEY = "conduit:checkout-intent:v1"
const MAX_AGE_MS = 30 * 60_000

export type StagedCheckoutIntent = {
  id: string
  createdAt: number
  result: CheckoutIntentParseResult
}

// Failed writes/removals must never revive an older persisted purchase.
let preferMemory = false
let fallback: StagedCheckoutIntent | null = null

function save(stage: StagedCheckoutIntent): void {
  fallback = stage
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(stage))
    preferMemory = false
  } catch {
    preferMemory = true
    /* tab memory remains available */
  }
}

export function clearStagedCheckoutIntent(): void {
  fallback = null
  try {
    window.sessionStorage.removeItem(KEY)
    preferMemory = false
  } catch {
    preferMemory = true
    /* storage unavailable */
  }
}

export function getStagedCheckoutIntent(): StagedCheckoutIntent | null {
  let candidate = fallback
  if (!preferMemory) {
    try {
      const raw = window.sessionStorage.getItem(KEY)
      candidate = raw ? (JSON.parse(raw) as StagedCheckoutIntent) : null
    } catch {
      /* use tab memory */
    }
  }
  if (
    !candidate ||
    typeof candidate.id !== "string" ||
    !Number.isFinite(candidate.createdAt) ||
    Date.now() - candidate.createdAt > MAX_AGE_MS ||
    candidate.createdAt > Date.now() ||
    !candidate.result ||
    !["valid", "invalid"].includes(candidate.result.status)
  ) {
    clearStagedCheckoutIntent()
    return null
  }
  fallback = candidate
  return candidate
}

/** Called before the Market provider tree can observe the URL. */
export function captureCheckoutIntentFragment(): void {
  if (window.location.pathname !== "/checkout" || !window.location.hash) return
  clearCheckoutReferral()
  const result = parseCheckoutIntentFragment(
    window.location.hash,
    document.referrer
  )
  const stage: StagedCheckoutIntent = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    result,
  }
  save(stage)
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname
  )
}
