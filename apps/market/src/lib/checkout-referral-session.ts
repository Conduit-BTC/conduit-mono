import { clearCheckoutReferral } from "./checkout-referral"

const KEY = "conduit:checkout-referral-session:v1"
type Fence = { identity: string | null; token: string }
type AuthState = {
  accountPubkey: string | null
  authGeneration: number
  pending: boolean
}

/** Local purchase fence only. Never emitted as telemetry or used for account authority. */
export function createCheckoutReferralSessionFence() {
  let current: (Fence & { generation: number; pending: boolean }) | null = null

  const read = (): Fence | null => {
    try {
      const raw = window.sessionStorage.getItem(KEY)
      const value = raw ? (JSON.parse(raw) as Fence) : null
      return value &&
        (value.identity === null || typeof value.identity === "string") &&
        typeof value.token === "string" &&
        /^[0-9a-f-]{36}$/.test(value.token)
        ? value
        : null
    } catch {
      return null
    }
  }

  return {
    synchronize({ accountPubkey, authGeneration, pending }: AuthState): void {
      // Initial saved-signer restoration is not an account transition.
      if (!current && pending) return
      const previous = current ?? read()
      const changed =
        !previous ||
        previous.identity !== accountPubkey ||
        // StrictMode guest startup cleanup advances the process counter without
        // changing the buyer. Identity changes and observed auth attempts rotate.
        (current !== null &&
          current.generation !== authGeneration &&
          (accountPubkey !== null || pending || current.pending))
      let fence: Fence = changed
        ? { identity: accountPubkey, token: crypto.randomUUID() }
        : previous!
      if (!current || changed) {
        try {
          window.sessionStorage.setItem(KEY, JSON.stringify(fence))
        } catch {
          // A reload must not trust a stored fence that cannot be rotated.
          fence = { identity: accountPubkey, token: crypto.randomUUID() }
          clearCheckoutReferral()
        }
      }
      if (changed) clearCheckoutReferral()
      current = { ...fence, generation: authGeneration, pending }
    },
    getScope(
      accountPubkey: string | null,
      authGeneration: number
    ): string | undefined {
      return current?.identity === accountPubkey &&
        current.generation === authGeneration
        ? current.token
        : undefined
    },
  }
}

export const checkoutReferralSessionFence = createCheckoutReferralSessionFence()
