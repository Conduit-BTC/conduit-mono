import { validateAnonZapRequestDraft } from "@conduit/core/protocol/anon-zap"

type PagesFunctionEnv = {
  ANON_ZAP_SIGNER_URL?: string
  VITE_ANON_ZAP_SIGNER_URL?: string
  ANON_SIGNER_REQUEST_AUTH_SECRET?: string
}

type PagesFunctionContext = {
  request: Request
  env: PagesFunctionEnv
}

const MAX_REQUEST_BYTES = 8_192
const AUTH_TIMESTAMP_HEADER = "x-conduit-anon-signer-timestamp"
const AUTH_SIGNATURE_HEADER = "x-conduit-anon-signer-signature"

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  })
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function createRequestSignature(
  secret: string,
  timestamp: string,
  bodyText: string
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${bodyText}`)
  )
  return bytesToHex(signature)
}

async function readRequestText(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    throw new Error("Request body is too large.")
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new Error("Request body is too large.")
  }
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export async function onRequestPost({
  request,
  env,
}: PagesFunctionContext): Promise<Response> {
  const signerUrl = env.ANON_ZAP_SIGNER_URL ?? env.VITE_ANON_ZAP_SIGNER_URL
  const requestAuthSecret = env.ANON_SIGNER_REQUEST_AUTH_SECRET?.trim()
  if (!signerUrl || !requestAuthSecret) {
    return jsonResponse({ error: "Anon zap signer is not configured." }, 503)
  }

  try {
    const bodyText = await readRequestText(request)
    const body: unknown = JSON.parse(bodyText)
    if (!isRecord(body) || !isRecord(body.zapRequest)) {
      return jsonResponse({ error: "Invalid request body." }, 400)
    }
    const validation = validateAnonZapRequestDraft({
      kind: body.zapRequest.kind as number,
      createdAt: body.zapRequest.createdAt as number,
      content: body.zapRequest.content as string,
      tags: body.zapRequest.tags as string[][],
    })
    if (!validation.ok) {
      return jsonResponse({ error: validation.reason }, 400)
    }

    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = await createRequestSignature(
      requestAuthSecret,
      timestamp,
      bodyText
    )
    const signerResponse = await fetch(signerUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [AUTH_TIMESTAMP_HEADER]: timestamp,
        [AUTH_SIGNATURE_HEADER]: signature,
      },
      body: bodyText,
    })
    return new Response(signerResponse.body, {
      status: signerResponse.status,
      headers: {
        "content-type":
          signerResponse.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Signing failed."
    return jsonResponse({ error: message }, 400)
  }
}

export function onRequest(): Response {
  return jsonResponse({ error: "Method not allowed." }, 405)
}
