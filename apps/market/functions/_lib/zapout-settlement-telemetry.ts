import type { OmfZapoutReceipt } from "@conduit/core/protocol/lightning"

export type ZapoutSettlementTelemetryEnv = {
  POSTHOG_PROJECT_TOKEN?: string
  POSTHOG_HOST?: string
  ZAPOUT_SETTLEMENT_TELEMETRY_HMAC_SECRET?: string
}

type TelemetryFetch = (input: string, init: RequestInit) => Promise<Response>

type RecordZapoutSettlementOptions = {
  fetchImpl?: TelemetryFetch
  subtleCrypto?: SubtleCrypto
  timeoutMs?: number
}

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com"
const DEFAULT_TIMEOUT_MS = 1_500
const EVENT_NAME = "zapout_settled"
const SERVICE_DISTINCT_ID = "conduit-zapout-settlement"
const EVENT_ID_DOMAIN = "conduit-zapout-settlement-v1"
const ALLOWED_POSTHOG_ORIGINS = new Set([
  "https://eu.i.posthog.com",
  "https://us.i.posthog.com",
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
    return `${url.origin}/capture/?ip=0`
  } catch {
    return null
  }
}

function isValidProjectToken(value: string): boolean {
  return /^phc_[A-Za-z0-9_-]{20,}$/.test(value)
}

function getSettlementSats(receipt: OmfZapoutReceipt): number | null {
  const amountMsats = receipt.amountMsats
  if (
    amountMsats === null ||
    !Number.isSafeInteger(amountMsats) ||
    amountMsats <= 0 ||
    amountMsats % 1_000 !== 0
  ) {
    return null
  }

  return amountMsats / 1_000
}

function getSettlementDay(createdAt: number | null): string | null {
  if (
    createdAt === null ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0
  ) {
    return null
  }

  const date = new Date(createdAt * 1_000)
  if (!Number.isFinite(date.getTime())) return null
  return `${date.toISOString().slice(0, 10)}T00:00:00.000Z`
}

function bytesToUuid(bytes: Uint8Array): string {
  const value = bytes.slice(0, 16)
  value[6] = (value[6]! & 0x0f) | 0x50
  value[8] = (value[8]! & 0x3f) | 0x80
  const hex = Array.from(value, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function getOpaqueEventUuid(
  receiptId: string,
  secret: string,
  subtleCrypto: SubtleCrypto
): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(receiptId) || secret.trim().length < 32) {
    return null
  }

  const encoder = new TextEncoder()
  const key = await subtleCrypto.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const digest = await subtleCrypto.sign(
    "HMAC",
    key,
    encoder.encode(`${EVENT_ID_DOMAIN}:${receiptId}`)
  )
  return bytesToUuid(new Uint8Array(digest))
}

export async function recordZapoutSettlement(
  receipt: OmfZapoutReceipt,
  env: ZapoutSettlementTelemetryEnv,
  options: RecordZapoutSettlementOptions = {}
): Promise<void> {
  const projectToken = env.POSTHOG_PROJECT_TOKEN?.trim() ?? ""
  const hmacSecret = env.ZAPOUT_SETTLEMENT_TELEMETRY_HMAC_SECRET?.trim() ?? ""
  const captureUrl = getCaptureUrl(env.POSTHOG_HOST)
  const settledAmountSats = getSettlementSats(receipt)
  const timestamp = getSettlementDay(receipt.createdAt)
  if (
    !isValidProjectToken(projectToken) ||
    !captureUrl ||
    settledAmountSats === null ||
    !timestamp
  ) {
    return
  }

  try {
    const uuid = await getOpaqueEventUuid(
      receipt.id,
      hmacSecret,
      options.subtleCrypto ?? crypto.subtle
    )
    if (!uuid) return

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
          token: projectToken,
          distinct_id: SERVICE_DISTINCT_ID,
          event: EVENT_NAME,
          timestamp,
          uuid,
          properties: {
            $process_person_profile: false,
            settled_amount_sats: settledAmountSats,
          },
        }),
        signal: abortController.signal,
      })
      await response.body?.cancel()
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    // Settlement telemetry is best effort and must never affect payment state.
  }
}
