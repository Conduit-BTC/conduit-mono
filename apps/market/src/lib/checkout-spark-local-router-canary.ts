/**
 * Loopback-only router rehearsal switch. Every local-only payment exception
 * must check this same runtime gate rather than trusting saved browser state.
 */
export function isCheckoutSparkLocalRouterCanaryContext(input: {
  dev: boolean
  deploymentProfile?: string
  flag: string | undefined
  hostname: string | undefined
}): boolean {
  return (
    input.dev === true &&
    (input.deploymentProfile === undefined ||
      input.deploymentProfile === "local") &&
    input.flag === "true" &&
    (input.hostname === "localhost" ||
      input.hostname === "127.0.0.1" ||
      input.hostname === "[::1]" ||
      input.hostname === "::1")
  )
}

/** No caller-supplied override may authorize a local-only payment path. */
export function canUseCheckoutSparkLocalRouterCanary(): boolean {
  return isCheckoutSparkLocalRouterCanaryContext({
    dev: import.meta.env.DEV === true,
    deploymentProfile: import.meta.env.VITE_DEPLOYMENT_PROFILE ?? "unknown",
    flag: import.meta.env.VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY,
    hostname:
      typeof window === "undefined" ? undefined : window.location.hostname,
  })
}

/** New-order timing only. Saved plans always retain their frozen deadlines. */
export function checkoutSparkSettledTimingForContext(
  input: Parameters<typeof isCheckoutSparkLocalRouterCanaryContext>[0] & {
    rehearsalFlag: string | undefined
    fastHandoffFlag: string | undefined
  }
): { fundingExpirySecs: number; takeoverAfterMs: number } {
  const fastHandoff =
    isCheckoutSparkLocalRouterCanaryContext(input) &&
    input.rehearsalFlag === "true" &&
    input.fastHandoffFlag === "true"
  return {
    fundingExpirySecs: (fastHandoff ? 2 : 15) * 60,
    takeoverAfterMs: (fastHandoff ? 3 : 2) * 60_000,
  }
}

/** The demo exception cannot be enabled by a caller or persisted order data. */
export function getCheckoutSparkSettledTiming() {
  return checkoutSparkSettledTimingForContext({
    dev: import.meta.env.DEV === true,
    deploymentProfile: import.meta.env.VITE_DEPLOYMENT_PROFILE ?? "unknown",
    flag: import.meta.env.VITE_CHECKOUT_SPARK_LOCAL_ROUTER_CANARY,
    hostname:
      typeof window === "undefined" ? undefined : window.location.hostname,
    rehearsalFlag: import.meta.env.VITE_CHECKOUT_SPARK_SETTLED_REHEARSAL,
    fastHandoffFlag: import.meta.env.VITE_CHECKOUT_SPARK_DEMO_FAST_HANDOFF,
  })
}
