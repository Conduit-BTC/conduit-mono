import {
  assertAllowedOrigin,
  getCorsHeaders,
  jsonResponse,
  optionsResponse,
  type AnonZapPagesFunctionContext,
} from "../_lib/anon-zap-checkout-auth"

export async function onRequestPost({
  request,
  env,
}: AnonZapPagesFunctionContext): Promise<Response> {
  const originError = assertAllowedOrigin(request, env)
  if (originError) return originError
  const corsHeaders = getCorsHeaders(request, env)

  return jsonResponse(
    { error: "Anon zap signer requires server-trusted checkout state." },
    403,
    corsHeaders
  )
}

export function onRequestOptions({
  request,
  env,
}: AnonZapPagesFunctionContext): Response {
  return optionsResponse(request, env)
}

export function onRequest(): Response {
  return jsonResponse({ error: "Method not allowed." }, 405)
}
