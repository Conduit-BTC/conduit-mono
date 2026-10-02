/** Pin manual work across worker drains and local/provider reads. */
export function captureMerchantCheckoutSparkRecoveryAction(input: {
  generation: () => number
  isCurrent: () => boolean
}) {
  const generation = input.generation()
  const isCurrent = () => {
    try {
      return input.generation() === generation && input.isCurrent()
    } catch {
      return false
    }
  }
  return {
    isCurrent,
    assertCurrent() {
      if (!isCurrent()) {
        throw new Error("Merchant recovery action session changed.")
      }
    },
  }
}

/** Session-local UI authority only; this does not authorize any payout itself. */
export function createMerchantCheckoutSparkAutomaticSession(input: {
  isCurrent: () => boolean
  stopAndDrain: () => Promise<void>
}) {
  let enabled = false
  let generation = 0
  const isCurrent = () => {
    try {
      return input.isCurrent()
    } catch {
      return false
    }
  }
  const revoke = () => {
    enabled = false
    generation += 1
  }
  return {
    revoke,
    async change(next: boolean): Promise<boolean> {
      // Invalidate held work before the first await, including a pending Start.
      revoke()
      const current = generation
      await input.stopAndDrain()
      if (generation !== current || !isCurrent()) return false
      enabled = next
      return enabled
    },
    capture(): () => void {
      const current = generation
      return () => {
        if (!enabled || generation !== current || !isCurrent()) {
          throw new Error("Merchant automatic recovery session changed.")
        }
      }
    },
  }
}
