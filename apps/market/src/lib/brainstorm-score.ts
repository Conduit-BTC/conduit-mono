const BRAINSTORM_STATS_URL = "https://api.brainstorm.world/stats/pubkey"

const HEX_PUBKEY = /^[0-9a-f]{64}$/
const MAX_PENDING_RETRIES = 3
const MAX_PENDING_WAIT_MS = 30_000

function retryAfterMs(header: string | null): number | null {
  if (!header) return null

  const value = header.trim()
  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : null
  }

  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function parseBrainstormGlobalScore(
  value: unknown,
  expectedPubkey: string
): number {
  if (
    !value ||
    typeof value !== "object" ||
    !("pubkey" in value) ||
    value.pubkey !== expectedPubkey ||
    !("rank" in value) ||
    typeof value.rank !== "number" ||
    !Number.isFinite(value.rank) ||
    value.rank < 0 ||
    value.rank > 1
  ) {
    throw new Error("Brainstorm returned an invalid global score")
  }

  // ORE-02 currently returns raw GrapeRank influence (0–1). Brainstorm's
  // public profile presents the corresponding rounded 0–100 score.
  return Math.round(value.rank * 100)
}

export async function fetchBrainstormGlobalScore(
  pubkey: string,
  signal?: AbortSignal
): Promise<number> {
  if (!HEX_PUBKEY.test(pubkey)) {
    throw new Error("Brainstorm score lookup requires a hex pubkey")
  }

  const request: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey }),
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  }
  const deadline = Date.now() + MAX_PENDING_WAIT_MS

  for (let retries = 0; ; retries += 1) {
    signal?.throwIfAborted()
    const response = await fetch(BRAINSTORM_STATS_URL, request)

    if (response.status === 202) {
      const delayMs = retryAfterMs(response.headers.get("Retry-After"))
      if (delayMs === null) {
        throw new Error("Brainstorm pending score omitted Retry-After")
      }
      if (retries >= MAX_PENDING_RETRIES || delayMs > deadline - Date.now()) {
        throw new Error("Brainstorm score is still being prepared")
      }
      await waitForRetry(delayMs, signal)
      continue
    }

    if (!response.ok) {
      throw new Error(`Brainstorm score lookup failed (${response.status})`)
    }

    return parseBrainstormGlobalScore(await response.json(), pubkey)
  }
}
