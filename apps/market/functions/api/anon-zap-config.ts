import {
  getAnonZapReceiptRelays,
  jsonResponse,
  type AnonZapPagesFunctionContext,
} from "../_lib/anon-zap-checkout-auth"

export function onRequestGet({ env }: AnonZapPagesFunctionContext): Response {
  return jsonResponse({ receiptRelayUrls: getAnonZapReceiptRelays(env) }, 200)
}

export function onRequest(): Response {
  return jsonResponse({ error: "Method not allowed." }, 405)
}
