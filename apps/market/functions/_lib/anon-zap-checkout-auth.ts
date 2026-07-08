export type AnonZapPagesEnv = {
  ANON_ZAP_ALLOWED_ORIGINS?: string
}

export type AnonZapPagesFunctionContext = {
  request: Request
  env: AnonZapPagesEnv
}

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function isOriginPatternMatch(origin: string, pattern: string): boolean {
  if (!pattern.includes("*")) return origin === pattern

  try {
    const originUrl = new URL(origin)
    const patternUrl = new URL(pattern)
    if (originUrl.protocol !== patternUrl.protocol) return false
    if (patternUrl.pathname !== "/" || patternUrl.search || patternUrl.hash) {
      return false
    }
    const wildcardPrefix = "*."
    if (!patternUrl.hostname.startsWith(wildcardPrefix)) return false
    const suffix = patternUrl.hostname.slice(wildcardPrefix.length)
    if (!originUrl.hostname.endsWith(`.${suffix}`)) return false
    const prefix = originUrl.hostname.slice(0, -(suffix.length + 1))
    return !!prefix && !prefix.includes(".")
  } catch {
    return false
  }
}

export function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: HeadersInit = {}
): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("content-type", "application/json")
  responseHeaders.set("cache-control", "no-store")
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  })
}

export function isOriginAllowed(
  request: Request,
  env: AnonZapPagesEnv
): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return false

  const configuredPatterns = parseCsv(env.ANON_ZAP_ALLOWED_ORIGINS)
  if (configuredPatterns.length > 0) {
    return configuredPatterns.some((pattern) =>
      isOriginPatternMatch(origin, pattern)
    )
  }

  return origin === new URL(request.url).origin
}

export function assertAllowedOrigin(
  request: Request,
  env: AnonZapPagesEnv
): Response | null {
  if (isOriginAllowed(request, env)) return null
  return jsonResponse({ error: "Origin is not allowed." }, 403)
}

export function getCorsHeaders(
  request: Request,
  env: AnonZapPagesEnv
): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  })
  const origin = request.headers.get("origin")
  if (origin && isOriginAllowed(request, env)) {
    headers.set("access-control-allow-origin", origin)
  }
  return headers
}

export function optionsResponse(
  request: Request,
  env: AnonZapPagesEnv
): Response {
  return new Response(null, {
    status: isOriginAllowed(request, env) ? 204 : 403,
    headers: getCorsHeaders(request, env),
  })
}
