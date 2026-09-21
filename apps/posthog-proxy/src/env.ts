import type { CommerceGmvCutoverResolution } from "./commerce-gmv-contract"

type CommerceGmvDailyStub = Pick<
  ReturnType<Env["GMV_DAILY_AGGREGATE"]["getByName"]>,
  "observe"
>

type CommerceGmvDailyNamespace = {
  getByName(name: string): CommerceGmvDailyStub
}

type CommerceGmvCutoverStub = {
  resolve(
    configuredCutoverDate: string | null
  ): Promise<CommerceGmvCutoverResolution>
}

type CommerceGmvCutoverNamespace = {
  getByName(name: string): CommerceGmvCutoverStub
}

type GmvRateLimit = Pick<Env["GMV_GLOBAL_RATE_LIMITER"], "limit">

export type PostHogProxyEnv = {
  GMV_CUTOVER_FENCE?: CommerceGmvCutoverNamespace
  GMV_DAILY_AGGREGATE?: CommerceGmvDailyNamespace
  GMV_GLOBAL_RATE_LIMITER?: GmvRateLimit
  GMV_ORDER_RATE_LIMITER?: GmvRateLimit
  POSTHOG_PROJECT_TOKEN?: string
  COMMERCE_GMV_TELEMETRY_HMAC_SECRET?: string
  COMMERCE_GMV_DAILY_CUTOVER_DATE?: string
}
