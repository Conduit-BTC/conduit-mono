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

export type MerchantCheckoutSparkAutomaticScope =
  | { readonly kind: "all" }
  | {
      readonly kind: "order"
      readonly orderId: string
      /** Exact participant/checkout consent; absent only for older callers. */
      readonly selectionKey?: string
    }

export function merchantCheckoutSparkAutomaticScopeIncludes(
  scope: MerchantCheckoutSparkAutomaticScope | null,
  orderId: string | null | undefined,
  selectionKey?: string | null
): boolean {
  return Boolean(
    scope &&
    orderId &&
    (scope.kind === "all" ||
      (scope.orderId === orderId &&
        (scope.selectionKey === undefined ||
          scope.selectionKey === selectionKey)))
  )
}

/** Session-local UI authority only; this does not authorize any payout itself. */
export function createMerchantCheckoutSparkAutomaticSession(input: {
  isCurrent: () => boolean
  stopAndDrain: () => Promise<void>
  /** Capture the existing selected-order revision before draining prior work. */
  captureOrder?: (orderId: string, selectionKey?: string) => () => boolean
}) {
  let enabled = false
  let generation = 0
  let scope: MerchantCheckoutSparkAutomaticScope | null = null
  let scopeCurrent: () => boolean = () => false
  const isCurrent = () => {
    try {
      return input.isCurrent()
    } catch {
      return false
    }
  }
  const revoke = () => {
    enabled = false
    scope = null
    generation += 1
  }
  const hasCurrentScope = () => {
    try {
      return enabled && scope !== null && isCurrent() && scopeCurrent()
    } catch {
      return false
    }
  }
  return {
    revoke,
    getScope(): MerchantCheckoutSparkAutomaticScope | null {
      return hasCurrentScope() ? scope : null
    },
    async change(
      next: boolean,
      requestedScope: MerchantCheckoutSparkAutomaticScope = { kind: "all" }
    ): Promise<boolean> {
      // Invalidate held work before the first await, including a pending Start.
      revoke()
      const current = generation
      const capturedScope = Object.freeze({ ...requestedScope })
      const capturedOrderCurrent =
        capturedScope.kind === "order"
          ? (input.captureOrder?.(
              capturedScope.orderId,
              capturedScope.selectionKey
            ) ?? (() => false))
          : () => true
      await input.stopAndDrain()
      if (
        generation !== current ||
        !isCurrent() ||
        (next && !capturedOrderCurrent())
      )
        return false
      enabled = next
      scope = next ? capturedScope : null
      scopeCurrent = capturedOrderCurrent
      return enabled
    },
    capture(): (orderId?: string, selectionKey?: string | null) => void {
      const current = generation
      const capturedScope = scope
      return (orderId, selectionKey) => {
        if (
          !hasCurrentScope() ||
          generation !== current ||
          (orderId !== undefined &&
            !merchantCheckoutSparkAutomaticScopeIncludes(
              capturedScope,
              orderId,
              selectionKey
            ))
        ) {
          throw new Error("Merchant automatic recovery session changed.")
        }
      }
    },
  }
}
