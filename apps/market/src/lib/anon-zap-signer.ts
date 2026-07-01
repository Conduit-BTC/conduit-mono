import {
  config,
  normalizePubkey,
  validateAnonZapRequestDraft,
} from "@conduit/core"
import {
  getEventHash,
  validateEvent,
  verifyEvent,
  type Event as NostrEvent,
} from "nostr-tools"
import type {
  CheckoutZapRequestDraft,
  SignedCheckoutZapRequest,
} from "./checkout-payment"

type AnonZapSignerOptions = {
  signerUrl?: string | null
  expectedPubkey?: string | null
  fetchImpl?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function tagsMatch(a: readonly string[][], b: unknown): boolean {
  return Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b)
}

function isSignedNostrEvent(value: unknown): value is {
  id: string
  pubkey: string
  sig: string
  kind: number
  created_at: number
  content: string
  tags: string[][]
} {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.pubkey === "string" &&
    typeof value.sig === "string" &&
    typeof value.kind === "number" &&
    typeof value.created_at === "number" &&
    typeof value.content === "string" &&
    Array.isArray(value.tags) &&
    value.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((part) => typeof part === "string")
    )
  )
}

function normalizeSignerEndpoint(raw: string): string {
  const url = new URL(raw)
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) {
    throw new Error("Anon zap signer endpoint must use HTTPS.")
  }
  url.hash = ""
  return url.toString()
}

export function isAnonZapSignerConfigured(
  cfg: Pick<typeof config, "anonZapSignerUrl" | "anonZapSignerPubkey"> = config
): boolean {
  return !!cfg.anonZapSignerUrl && !!normalizePubkey(cfg.anonZapSignerPubkey)
}

export const validateAnonZapSignerDraft = validateAnonZapRequestDraft

export async function signCheckoutZapRequestWithAnonSigner(
  draft: CheckoutZapRequestDraft,
  options: AnonZapSignerOptions = {}
): Promise<SignedCheckoutZapRequest> {
  const validation = validateAnonZapSignerDraft(draft)
  if (!validation.ok) throw new Error(validation.reason)

  const signerUrl = options.signerUrl ?? config.anonZapSignerUrl
  if (!signerUrl) throw new Error("Anon zap signer is not configured.")
  const endpoint = normalizeSignerEndpoint(signerUrl)
  const expectedPubkey = normalizePubkey(
    options.expectedPubkey ?? config.anonZapSignerPubkey
  )
  if (!expectedPubkey) {
    throw new Error("Anon zap signer pubkey is not configured.")
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") {
    throw new Error("Anon zap signer fetch is not available.")
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ zapRequest: draft }),
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  })

  if (!response.ok) {
    throw new Error("Anon zap signer rejected the request.")
  }

  const body: unknown = await response.json()
  if (!isRecord(body)) {
    throw new Error("Anon zap signer returned an invalid response.")
  }

  const rawEvent = body.rawEvent ?? body.event
  if (!isSignedNostrEvent(rawEvent)) {
    throw new Error("Anon zap signer did not return a signed event.")
  }
  const id = typeof body.id === "string" ? body.id : rawEvent.id
  if (!id) throw new Error("Anon zap signer did not return an event id.")
  if (id !== rawEvent.id) {
    throw new Error("Anon zap signer returned a mismatched event id.")
  }
  if (
    rawEvent.kind !== draft.kind ||
    rawEvent.created_at !== draft.createdAt ||
    rawEvent.content !== draft.content
  ) {
    throw new Error("Anon zap signer returned a mismatched event.")
  }
  if (!tagsMatch(draft.tags, rawEvent.tags)) {
    throw new Error("Anon zap signer returned mismatched tags.")
  }

  const actualPubkey =
    typeof rawEvent.pubkey === "string"
      ? normalizePubkey(rawEvent.pubkey)
      : null
  if (actualPubkey !== expectedPubkey) {
    throw new Error("Anon zap signer returned the wrong pubkey.")
  }

  if (
    !validateEvent(rawEvent as NostrEvent) ||
    getEventHash(rawEvent as NostrEvent) !== rawEvent.id ||
    !verifyEvent(rawEvent as NostrEvent)
  ) {
    throw new Error("Anon zap signer returned an invalid signature.")
  }

  return { id, rawEvent }
}
