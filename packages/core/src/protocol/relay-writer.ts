import { config } from "../config"
import { getConfiguredIsolatedE2eRelayUrl } from "./relay-settings"
import type { NostrEventSigner } from "./nostr-event-signer"
import { serializeSignerOperation } from "./interactive-signer"
import {
  isExactRelayAuthEvent,
  type SignedPublicNostrEvent,
} from "./signed-event"

export type ExactRelayWriteStatus = "acked" | "rejected" | "timed_out"

const MAX_RESPONSE_FRAMES = 64
const MAX_RESPONSE_CHARS = 256 * 1024
const MAX_AUTH_CHALLENGE_CHARS = 4 * 1024
const NIP_01_DUPLICATE_REASON = /^duplicate:/i
const NIP_01_REJECTION_REASON =
  /^(?:pow|blocked|rate-limited|invalid|restricted|mute|error):/i
const NIP_42_AUTH_REQUIRED_REASON = /^auth-required:/i
const signerQueues = new WeakMap<object, Promise<void>>()

export interface ExactRelayWriteAuthorization {
  /** Active externally backed account identity authorizing this foreground write. */
  expectedPubkey: string
  signer: NostrEventSigner
  /** Stable identity for serializing prompts from this account session. */
  sessionScope: object
  /** Foreground gate that can be cancelled when the socket deadline expires. */
  waitForSignerVisibility?: (signal?: AbortSignal) => Promise<void>
  /** Re-check live account authority before and after the signer interaction. */
  shouldContinue?: () => boolean
  /** Suppress later relay-auth prompts in this foreground publish attempt. */
  onSignerFailure?: () => void
  /** Deterministic clock seam for NIP-42 auth-event tests. */
  now?: () => number
}

function serializeEventFrame(event: SignedPublicNostrEvent): string {
  const snapshot: SignedPublicNostrEvent = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  }
  return JSON.stringify(["EVENT", snapshot])
}

function normalizeExpectedPubkey(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null
}

/**
 * Publish one already-signed event over one single-use WebSocket. This writer
 * is intentionally independent from ambient NDK/read connections so session
 * and relay-setting resets cannot interrupt a durable retry in flight.
 */
export function publishSignedEventFrameToRelay(input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
  timeoutMs: number
  /** Optional foreground-only NIP-42 capability for this exact relay write. */
  authorization?: ExactRelayWriteAuthorization
  createWebSocket?: (relayUrl: string) => WebSocket
}): Promise<ExactRelayWriteStatus> {
  const relayUrl = config.e2eRelayIsolationEnabled
    ? getConfiguredIsolatedE2eRelayUrl()
    : input.relayUrl
  if (!relayUrl) return Promise.resolve("timed_out")

  const eventId = input.signedEvent.id
  const frame = serializeEventFrame(input.signedEvent)
  const authorization = input.authorization
  const expectedAuthPubkey = authorization
    ? normalizeExpectedPubkey(authorization.expectedPubkey)
    : null
  if (
    authorization &&
    (!expectedAuthPubkey ||
      typeof authorization.sessionScope !== "object" ||
      authorization.sessionScope === null ||
      (authorization.signer.authMethod !== "nip07" &&
        authorization.signer.authMethod !== "nip46"))
  ) {
    return Promise.resolve("timed_out")
  }

  return new Promise((resolve) => {
    let socket: WebSocket | null = null
    let responseFrames = 0
    let responseChars = 0
    let settled = false
    let authChallenge: string | null = null
    let authEventId: string | null = null
    let authState: "idle" | "signing" | "sent" | "accepted" = "idle"
    const authAbortController = new AbortController()

    const finish = (status: ExactRelayWriteStatus) => {
      if (settled) return
      settled = true
      authAbortController.abort()
      clearTimeout(timeout)
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        if (socket.readyState < 2) {
          try {
            socket.close()
          } catch {
            // The result is fixed; teardown remains best-effort.
          }
        }
      }
      resolve(status)
    }

    try {
      socket = input.createWebSocket
        ? input.createWebSocket(relayUrl)
        : new WebSocket(relayUrl)
    } catch {
      resolve("timed_out")
      return
    }

    const timeout = setTimeout(() => {
      if (authState === "signing") authorization?.onSignerFailure?.()
      finish("timed_out")
    }, input.timeoutMs)
    socket.onopen = () => {
      try {
        socket?.send(frame)
      } catch {
        finish("timed_out")
      }
    }
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") {
        finish("timed_out")
        return
      }
      responseFrames += 1
      responseChars += message.data.length
      if (
        responseFrames > MAX_RESPONSE_FRAMES ||
        responseChars > MAX_RESPONSE_CHARS
      ) {
        finish("timed_out")
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        return
      }
      if (!Array.isArray(parsed) || typeof parsed[0] !== "string") return

      if (parsed[0] === "AUTH") {
        const challenge = parsed[1]
        if (
          !authorization ||
          !expectedAuthPubkey ||
          typeof challenge !== "string" ||
          challenge.length === 0 ||
          challenge.length > MAX_AUTH_CHALLENGE_CHARS
        ) {
          return
        }
        if (authChallenge !== null) {
          if (authChallenge !== challenge) finish("timed_out")
          return
        }
        authChallenge = challenge
        authState = "signing"
        void serializeSignerOperation(
          signerQueues,
          authorization.sessionScope,
          async () => {
            try {
              const signal = authAbortController.signal
              if (
                signal.aborted ||
                authorization.shouldContinue?.() === false
              ) {
                finish("timed_out")
                return
              }
              await authorization.waitForSignerVisibility?.(signal)
              if (
                signal.aborted ||
                settled ||
                authorization.shouldContinue?.() === false
              ) {
                finish("timed_out")
                return
              }
              const signerPubkey = (await authorization.signer.getPublicKey())
                .trim()
                .toLowerCase()
              if (signerPubkey !== expectedAuthPubkey) {
                authorization.onSignerFailure?.()
                finish("timed_out")
                return
              }
              if (signal.aborted || settled) {
                finish("timed_out")
                return
              }
              const createdAt = Math.floor(
                (authorization.now?.() ?? Date.now()) / 1_000
              )
              const signed = await authorization.signer.signEvent({
                kind: 22_242,
                pubkey: expectedAuthPubkey,
                created_at: createdAt,
                tags: [
                  ["relay", relayUrl],
                  ["challenge", challenge],
                ],
                content: "",
              })
              const exactAuthEvent = isExactRelayAuthEvent({
                event: signed,
                expectedPubkey: expectedAuthPubkey,
                relayUrl,
                challenge,
                createdAt,
              })
              if (!exactAuthEvent) authorization.onSignerFailure?.()
              if (
                signal.aborted ||
                settled ||
                authorization.shouldContinue?.() === false ||
                !exactAuthEvent
              ) {
                finish("timed_out")
                return
              }
              authEventId = signed.id
              authState = "sent"
              try {
                socket?.send(JSON.stringify(["AUTH", signed]))
              } catch {
                finish("timed_out")
                return
              }
            } catch {
              authorization.onSignerFailure?.()
              finish("timed_out")
            }
          }
        )
        return
      }

      if (parsed[0] !== "OK") return
      if (authEventId !== null && parsed[1] === authEventId) {
        if (parsed[2] === true && authState === "sent") {
          if (authorization?.shouldContinue?.() === false) {
            finish("timed_out")
            return
          }
          authState = "accepted"
          try {
            socket?.send(frame)
          } catch {
            finish("timed_out")
          }
          return
        }
        if (parsed[2] === false) {
          const reason = typeof parsed[3] === "string" ? parsed[3].trim() : ""
          finish(
            NIP_01_REJECTION_REASON.test(reason) ? "rejected" : "timed_out"
          )
        }
        return
      }
      if (parsed[1] !== eventId) return

      if (parsed[2] === true) {
        finish("acked")
        return
      }
      if (parsed[2] !== false) return

      const reason = typeof parsed[3] === "string" ? parsed[3].trim() : ""
      if (
        authorization &&
        authState !== "accepted" &&
        NIP_42_AUTH_REQUIRED_REASON.test(reason)
      ) {
        // The relay's AUTH challenge drives the signer interaction. Preserve
        // the original publish resolver until that challenge arrives and the
        // exact same EVENT frame can be retried on this socket.
        return
      }
      if (NIP_01_DUPLICATE_REASON.test(reason)) {
        finish("acked")
      } else if (NIP_01_REJECTION_REASON.test(reason)) {
        finish("rejected")
      } else {
        // Unprefixed OK-false text is not a stable machine-readable rejection.
        finish("timed_out")
      }
    }
    socket.onerror = () => finish("timed_out")
    socket.onclose = () => finish("timed_out")
  })
}
