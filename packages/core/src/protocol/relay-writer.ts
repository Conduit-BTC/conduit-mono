import { config } from "../config"
import { getConfiguredIsolatedE2eRelayUrl } from "./relay-settings"
import {
  isValidSignedPublicNostrEvent,
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

export type ExactRelayAuthSigner = (input: {
  relayUrl: string
  challenge: string
  authorPubkey: string
}) => Promise<SignedPublicNostrEvent>

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

function serializeAuthFrame(event: SignedPublicNostrEvent): string {
  return JSON.stringify(["AUTH", event])
}

function hasExactAuthTag(
  event: SignedPublicNostrEvent,
  name: string,
  value: string
): boolean {
  const matching = event.tags.filter((tag) => tag[0] === name)
  return (
    matching.length === 1 &&
    matching[0]?.length === 2 &&
    matching[0]?.[1] === value
  )
}

function isExactRelayAuthEvent(input: {
  event: SignedPublicNostrEvent
  relayUrl: string
  challenge: string
  authorPubkey: string
}): boolean {
  return (
    input.event.kind === 22_242 &&
    input.event.pubkey === input.authorPubkey &&
    input.event.content === "" &&
    isValidSignedPublicNostrEvent(input.event) &&
    hasExactAuthTag(input.event, "relay", input.relayUrl) &&
    hasExactAuthTag(input.event, "challenge", input.challenge)
  )
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
  signAuthEvent?: ExactRelayAuthSigner
  createWebSocket?: (relayUrl: string) => WebSocket
}): Promise<ExactRelayWriteStatus> {
  const relayUrl = config.e2eRelayIsolationEnabled
    ? getConfiguredIsolatedE2eRelayUrl()
    : input.relayUrl
  if (!relayUrl) return Promise.resolve("timed_out")

  const eventId = input.signedEvent.id
  const frame = serializeEventFrame(input.signedEvent)

  return new Promise((resolve) => {
    let socket: WebSocket | null = null
    let responseFrames = 0
    let responseChars = 0
    let settled = false
    let authChallenge: string | null = null
    let authEventId: string | null = null
    let authPending = false
    let authenticated = false

    const finish = (status: ExactRelayWriteStatus) => {
      if (settled) return
      settled = true
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

    const timeout = setTimeout(() => finish("timed_out"), input.timeoutMs)
    const sendEvent = () => {
      if (settled) return
      try {
        socket?.send(frame)
      } catch {
        finish("timed_out")
      }
    }
    const authenticate = async (challenge: string) => {
      if (settled || authenticated || authChallenge === challenge) return
      if (authPending || authChallenge !== null || !input.signAuthEvent) {
        finish("timed_out")
        return
      }
      authChallenge = challenge
      authPending = true
      try {
        const authEvent = await input.signAuthEvent({
          relayUrl,
          challenge,
          authorPubkey: input.signedEvent.pubkey,
        })
        if (settled) return
        if (
          !isExactRelayAuthEvent({
            event: authEvent,
            relayUrl,
            challenge,
            authorPubkey: input.signedEvent.pubkey,
          })
        ) {
          finish("timed_out")
          return
        }
        authEventId = authEvent.id
        socket?.send(serializeAuthFrame(authEvent))
      } catch {
        finish("timed_out")
      } finally {
        authPending = false
      }
    }
    socket.onopen = sendEvent
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
      if (!Array.isArray(parsed)) return
      if (parsed[0] === "AUTH") {
        const challenge = parsed[1]
        if (
          typeof challenge !== "string" ||
          challenge.length === 0 ||
          challenge.length > MAX_AUTH_CHALLENGE_CHARS
        ) {
          finish("timed_out")
          return
        }
        if (!input.signAuthEvent) return
        void authenticate(challenge)
        return
      }
      if (parsed[0] !== "OK") return
      if (authEventId && parsed[1] === authEventId) {
        if (parsed[2] === true) {
          authenticated = true
          sendEvent()
        } else if (parsed[2] === false) {
          finish("rejected")
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
      if (NIP_01_DUPLICATE_REASON.test(reason)) {
        finish("acked")
      } else if (
        NIP_42_AUTH_REQUIRED_REASON.test(reason) &&
        input.signAuthEvent &&
        !authenticated
      ) {
        // The relay's AUTH challenge may arrive before or after this response.
        // Keep the exact socket alive so the same event can be retried after
        // the challenge is signed and acknowledged.
        return
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
