import type { NDKEvent, NDKSigner } from "@nostr-dev-kit/ndk"

const DEFAULT_TRANSIENT_NIP07_RETRY_DELAYS_MS = [250, 750] as const

export interface TransientNip07RetryOptions {
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

  return /could not establish connection|receiving end does not exist|message port closed|extension context invalidated|chrome\.runtime\.lastError/i.test(
    message
  )
}

/**
 * Retry only browser-extension bridge readiness failures. These happen before a
 * signer operation reaches the user or produces a signed event, and are distinct
 * from user rejection, validation errors, wallet errors, or payment ambiguity.
 */
export async function withTransientNip07Retry<T>(
  operation: () => Promise<T>,
  options: TransientNip07RetryOptions = {}
): Promise<T> {
  const retryDelaysMs =
    options.retryDelaysMs ?? DEFAULT_TRANSIENT_NIP07_RETRY_DELAYS_MS
  let lastError: unknown

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation()
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
    : new Error("NIP-07 signer operation failed")
}

export function signNdkEventWithTransientNip07Retry(
  event: NDKEvent,
  signer?: NDKSigner,
  options?: TransientNip07RetryOptions
): Promise<string> {
  return withTransientNip07Retry(() => event.sign(signer), options)
}
