const DEFAULT_TRANSIENT_NIP07_RETRY_DELAYS_MS = [250, 750] as const

export interface TransientNip07ReadinessRetryOptions {
  retryDelaysMs?: readonly number[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : ""
}

export function isTransientNip07BridgeError(error: unknown): boolean {
  const message = getErrorMessage(error)

  return /could not establish connection|receiving end does not exist|message port closed|extension context invalidated|chrome\.runtime\.lastError|nip-07 extension not available/i.test(
    message
  )
}

/**
 * Retry only a caller-provided browser-extension readiness probe. Authority-
 * bearing operations must never be passed here because a bridge error does not
 * prove whether an earlier sign, encrypt, or decrypt request reached the signer.
 */
export async function withTransientNip07ReadinessRetry<T>(
  readinessProbe: () => Promise<T>,
  options: TransientNip07ReadinessRetryOptions = {}
): Promise<T> {
  const retryDelaysMs =
    options.retryDelaysMs ?? DEFAULT_TRANSIENT_NIP07_RETRY_DELAYS_MS
  let lastError: unknown

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await readinessProbe()
    } catch (error) {
      lastError = error
      const retryDelay = retryDelaysMs[attempt]
      if (!isTransientNip07BridgeError(error) || retryDelay === undefined) {
        throw error
      }
      await sleep(retryDelay)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("NIP-07 signer readiness check failed")
}
