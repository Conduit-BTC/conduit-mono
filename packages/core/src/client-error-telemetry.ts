import {
  recordBrowserTelemetryEvent,
  sanitizeTelemetryPath,
  type BrowserTelemetryEventProperties,
  type ConduitTelemetryApp,
} from "./telemetry"

export const clientErrorSources = [
  "window_error",
  "unhandled_rejection",
  "react_error_boundary",
] as const

export type ClientErrorSource = (typeof clientErrorSources)[number]

export const clientErrorFamilies = [
  "type_error",
  "reference_error",
  "range_error",
  "syntax_error",
  "aggregate_error",
  "dom_exception",
  "error",
  "non_error",
] as const

export type ClientErrorFamily = (typeof clientErrorFamilies)[number]

export interface BrowserClientErrorInput {
  app: ConduitTelemetryApp
  source: ClientErrorSource
  error: unknown
}

export interface ClientErrorRateLimiter {
  shouldRecord: (signature: string, now?: number) => boolean
}

const CLIENT_ERROR_DEDUPE_MS = 10_000
const CLIENT_ERROR_RATE_LIMIT_WINDOW_MS = 60_000
const CLIENT_ERROR_RATE_LIMIT_MAX_EVENTS = 5

const clientErrorLimiterByApp = new Map<
  ConduitTelemetryApp,
  ClientErrorRateLimiter
>()

export function getClientErrorFamily(error: unknown): ClientErrorFamily {
  try {
    if (typeof DOMException !== "undefined" && error instanceof DOMException) {
      return "dom_exception"
    }
    if (!(error instanceof Error)) return "non_error"

    switch (error.name) {
      case "TypeError":
        return "type_error"
      case "ReferenceError":
        return "reference_error"
      case "RangeError":
        return "range_error"
      case "SyntaxError":
        return "syntax_error"
      case "AggregateError":
        return "aggregate_error"
      default:
        return "error"
    }
  } catch {
    return "non_error"
  }
}

export function buildClientErrorTelemetryProperties(input: {
  source: ClientErrorSource
  error: unknown
}): BrowserTelemetryEventProperties {
  return {
    action: input.source,
    event_family: getClientErrorFamily(input.error),
    mode: input.source === "react_error_boundary" ? "handled" : "unhandled",
    status: "failure",
    surface: "browser",
  }
}

export function createClientErrorRateLimiter(input?: {
  dedupeMs?: number
  maxEvents?: number
  windowMs?: number
}): ClientErrorRateLimiter {
  const dedupeMs = input?.dedupeMs ?? CLIENT_ERROR_DEDUPE_MS
  const maxEvents = input?.maxEvents ?? CLIENT_ERROR_RATE_LIMIT_MAX_EVENTS
  const windowMs = input?.windowMs ?? CLIENT_ERROR_RATE_LIMIT_WINDOW_MS
  const latestBySignature = new Map<string, number>()
  let windowStartedAt: number | null = null
  let windowEventCount = 0

  return {
    shouldRecord(signature, now = Date.now()) {
      const latest = latestBySignature.get(signature)
      if (latest !== undefined && now - latest < dedupeMs) return false

      if (windowStartedAt === null || now - windowStartedAt >= windowMs) {
        windowStartedAt = now
        windowEventCount = 0
      }
      if (windowEventCount >= maxEvents) return false

      for (const [key, recordedAt] of latestBySignature) {
        if (now - recordedAt >= dedupeMs) latestBySignature.delete(key)
      }

      latestBySignature.set(signature, now)
      windowEventCount += 1
      return true
    },
  }
}

export function recordBrowserClientError(input: BrowserClientErrorInput): void {
  if (typeof window === "undefined" || typeof document === "undefined") return

  const properties = buildClientErrorTelemetryProperties(input)
  const signature = [
    input.source,
    properties.event_family,
    sanitizeTelemetryPath(window.location.pathname),
  ].join(":")
  const limiter = getClientErrorLimiter(input.app)
  if (!limiter.shouldRecord(signature)) return

  recordBrowserTelemetryEvent({
    app: input.app,
    eventName: "client_error_result",
    properties,
  })
}

export function installBrowserClientErrorTelemetry(
  app: ConduitTelemetryApp
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined
  }

  const handleError = (event: ErrorEvent) => {
    recordBrowserClientError({
      app,
      error: event.error,
      source: "window_error",
    })
  }
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    recordBrowserClientError({
      app,
      error: event.reason,
      source: "unhandled_rejection",
    })
  }

  window.addEventListener("error", handleError)
  window.addEventListener("unhandledrejection", handleUnhandledRejection)

  return () => {
    window.removeEventListener("error", handleError)
    window.removeEventListener("unhandledrejection", handleUnhandledRejection)
  }
}

function getClientErrorLimiter(
  app: ConduitTelemetryApp
): ClientErrorRateLimiter {
  const existing = clientErrorLimiterByApp.get(app)
  if (existing) return existing

  const limiter = createClientErrorRateLimiter()
  clientErrorLimiterByApp.set(app, limiter)
  return limiter
}
