export type AnonZapSignerTelemetryEnv = {
  POSTHOG_PROJECT_TOKEN?: string
  POSTHOG_HOST?: string
}

export type AnonZapSignerTelemetryAction = "rate_limit" | "sign"

export type AnonZapSignerTelemetryStatus =
  "failure" | "invalid_request" | "rate_limited" | "success" | "unavailable"

export type AnonZapSignerLatencyBucket =
  "lt_100ms" | "100_499ms" | "500_1999ms" | "2s_plus"

export type AnonZapSignerTelemetryProperties = {
  event_name: "anon_zap_signer_request_result"
  app: "anon_zap_signer"
  surface: "worker"
  action: AnonZapSignerTelemetryAction
  status: AnonZapSignerTelemetryStatus
  latency_bucket: AnonZapSignerLatencyBucket
}

type TelemetryFetch = (input: string, init: RequestInit) => Promise<Response>

type RecordTelemetryOptions = {
  fetchImpl?: TelemetryFetch
  timeoutMs?: number
}

export function getAnonZapSignerLatencyBucket(
  latencyMs: number
): AnonZapSignerLatencyBucket {
  if (latencyMs < 100) return "lt_100ms"
  if (latencyMs < 500) return "100_499ms"
  if (latencyMs < 2_000) return "500_1999ms"
  return "2s_plus"
}

export async function recordTelemetryEvent(
  eventName: "anon_zap_signer_request_result",
  properties: AnonZapSignerTelemetryProperties,
  env: AnonZapSignerTelemetryEnv,
  options: RecordTelemetryOptions = {}
): Promise<void> {
  // Keep the signer response path unchanged while all analytics delivery is paused.
  void eventName
  void properties
  void env
  void options
}
