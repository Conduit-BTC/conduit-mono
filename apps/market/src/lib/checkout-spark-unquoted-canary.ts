/** Distinct local funding policy; never a fallback after a quote error. */
export const CHECKOUT_SPARK_LOCAL_UNQUOTED_RECEIVE_POLICY =
  "local-loopback-unquoted-balance-gated-v1" as const

export const CHECKOUT_SPARK_LOCAL_UNQUOTED_ADMISSION_POLICY =
  "local-loopback-unquoted-receive-v1" as const

export {
  canUseCheckoutSparkLocalRouterCanary,
  isCheckoutSparkLocalRouterCanaryContext,
} from "./checkout-spark-local-router-canary"
