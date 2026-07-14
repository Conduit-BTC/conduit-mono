import {
  assertAllowedOrigin,
  jsonResponse,
  optionsResponse,
  signAuthorizedAnonZapRequest,
  type AnonZapPagesFunctionContext,
} from "../_lib/anon-zap-checkout-auth"

export async function onRequestPost({
  request,
  env,
}: AnonZapPagesFunctionContext): Promise<Response> {
  const originError = assertAllowedOrigin(request, env)
  if (originError) return originError
  return signAuthorizedAnonZapRequest(request, env)
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
