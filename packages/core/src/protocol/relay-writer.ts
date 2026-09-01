import { config } from "../config"
import { getConfiguredIsolatedE2eRelayUrl } from "./relay-settings"
import type { SignedPublicNostrEvent } from "./signed-event"

export type ExactRelayWriteStatus = "acked" | "rejected" | "timed_out"

export interface ExactRelayWriteOutcome {
  status: ExactRelayWriteStatus
  /** Whether replaying these exact immutable bytes may produce a new result. */
  retryable: boolean
}

const MAX_RESPONSE_FRAMES = 64
const MAX_RESPONSE_CHARS = 256 * 1024
const NIP_01_DUPLICATE_REASON = /^duplicate:/i
const NIP_01_REJECTION_REASON =
  /^(?:pow|blocked|rate-limited|invalid|restricted|mute|error):/i
const NIP_01_IMMUTABLE_TERMINAL_REASON = /^(?:invalid|pow):/i

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

/**
 * Publish one already-signed event over one single-use WebSocket. This writer
 * is intentionally independent from ambient NDK/read connections so session
 * and relay-setting resets cannot interrupt a durable retry in flight.
 */
export function publishSignedEventFrameToRelay(input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
  timeoutMs: number
  createWebSocket?: (relayUrl: string) => WebSocket
}): Promise<ExactRelayWriteStatus> {
  return publishSignedEventFrameToRelayOutcome(input).then(
    (outcome) => outcome.status
  )
}

/**
 * Detailed exact-write result used by durable delivery. It retains only a
 * content-safe retry decision, never the relay's human-readable reason.
 */
export function publishSignedEventFrameToRelayOutcome(input: {
  relayUrl: string
  signedEvent: SignedPublicNostrEvent
  timeoutMs: number
  createWebSocket?: (relayUrl: string) => WebSocket
}): Promise<ExactRelayWriteOutcome> {
  const relayUrl = config.e2eRelayIsolationEnabled
    ? getConfiguredIsolatedE2eRelayUrl()
    : input.relayUrl
  if (!relayUrl)
    return Promise.resolve({ status: "timed_out", retryable: true })

  const eventId = input.signedEvent.id
  const frame = serializeEventFrame(input.signedEvent)

  return new Promise((resolve) => {
    let socket: WebSocket | null = null
    let responseFrames = 0
    let responseChars = 0
    let settled = false

    const finish = (outcome: ExactRelayWriteOutcome) => {
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
      resolve(outcome)
    }

    try {
      socket = input.createWebSocket
        ? input.createWebSocket(relayUrl)
        : new WebSocket(relayUrl)
    } catch {
      resolve({ status: "timed_out", retryable: true })
      return
    }

    const timeout = setTimeout(
      () => finish({ status: "timed_out", retryable: true }),
      input.timeoutMs
    )
    socket.onopen = () => {
      try {
        socket?.send(frame)
      } catch {
        finish({ status: "timed_out", retryable: true })
      }
    }
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") {
        finish({ status: "timed_out", retryable: true })
        return
      }
      responseFrames += 1
      responseChars += message.data.length
      if (
        responseFrames > MAX_RESPONSE_FRAMES ||
        responseChars > MAX_RESPONSE_CHARS
      ) {
        finish({ status: "timed_out", retryable: true })
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(message.data)
      } catch {
        return
      }
      if (!Array.isArray(parsed) || parsed[0] !== "OK") return
      if (parsed[1] !== eventId) return

      if (parsed[2] === true) {
        finish({ status: "acked", retryable: false })
        return
      }
      if (parsed[2] !== false) return

      const reason = typeof parsed[3] === "string" ? parsed[3].trim() : ""
      if (NIP_01_DUPLICATE_REASON.test(reason)) {
        finish({ status: "acked", retryable: false })
      } else if (NIP_01_REJECTION_REASON.test(reason)) {
        finish({
          status: "rejected",
          retryable: !NIP_01_IMMUTABLE_TERMINAL_REASON.test(reason),
        })
      } else {
        // Unprefixed OK-false text is not a stable machine-readable rejection.
        finish({ status: "timed_out", retryable: true })
      }
    }
    socket.onerror = () => finish({ status: "timed_out", retryable: true })
    socket.onclose = () => finish({ status: "timed_out", retryable: true })
  })
}
