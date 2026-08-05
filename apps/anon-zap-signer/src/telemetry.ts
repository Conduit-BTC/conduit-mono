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

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"
const DEFAULT_TIMEOUT_MS = 1_500
const SERVICE_DISTINCT_ID = "conduit-anon-zap-signer"
const EVENT_NAME = "anon_zap_signer_request_result"
const ALLOWED_POSTHOG_ORIGINS = new Set([
  "https://eu.i.posthog.com",
  "https://us.i.posthog.com",
])
const ALLOWED_ACTIONS = new Set<AnonZapSignerTelemetryAction>([
  "rate_limit",
  "sign",
])
const ALLOWED_STATUSES = new Set<AnonZapSignerTelemetryStatus>([
  "failure",
  "invalid_request",
  "rate_limited",
  "success",
  "unavailable",
])
const ALLOWED_LATENCY_BUCKETS = new Set<AnonZapSignerLatencyBucket>([
  "lt_100ms",
  "100_499ms",
  "500_1999ms",
  "2s_plus",
])

function getCaptureUrl(rawHost: string | undefined): string | null {
  const candidate = rawHost?.trim() || DEFAULT_POSTHOG_HOST

  try {
    const url = new URL(candidate)
    if (
      !ALLOWED_POSTHOG_ORIGINS.has(url.origin) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return `${url.origin}/capture/`
  } catch {
    return null
  }
}

function isValidProjectKey(value: string): boolean {
  return /^phc_[A-Za-z0-9_-]{20,}$/.test(value)
}

function getCaptureProperties(properties: AnonZapSignerTelemetryProperties):
  | (AnonZapSignerTelemetryProperties & {
      $process_person_profile: false
    })
  | null {
  if (
    properties.event_name !== "anon_zap_signer_request_result" ||
    properties.app !== "anon_zap_signer" ||
    properties.surface !== "worker" ||
    !ALLOWED_ACTIONS.has(properties.action) ||
    !ALLOWED_STATUSES.has(properties.status) ||
    !ALLOWED_LATENCY_BUCKETS.has(properties.latency_bucket)
  ) {
    return null
  }

  return {
    $process_person_profile: false,
    event_name: "anon_zap_signer_request_result",
    app: "anon_zap_signer",
    surface: "worker",
    action: properties.action,
    status: properties.status,
    latency_bucket: properties.latency_bucket,
  }
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
  const projectKey = env.POSTHOG_PROJECT_TOKEN?.trim() ?? ""
  const captureUrl = getCaptureUrl(env.POSTHOG_HOST)
  const captureProperties = getCaptureProperties(properties)
  if (
    eventName !== EVENT_NAME ||
    !isValidProjectKey(projectKey) ||
    !captureUrl ||
    !captureProperties
  ) {
    return
  }

  const abortController = new AbortController()
  const timeout = setTimeout(
    () => abortController.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )

  try {
    const fetchImpl =
      options.fetchImpl ??
      ((input: string, init: RequestInit) => fetch(input, init))
    const response = await fetchImpl(captureUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: projectKey,
        distinct_id: SERVICE_DISTINCT_ID,
        event: EVENT_NAME,
        properties: captureProperties,
      }),
      signal: abortController.signal,
    })
    await response.body?.cancel()
  } catch {
    // Telemetry is best effort and must never affect signer availability.
  } finally {
    clearTimeout(timeout)
  }
}
