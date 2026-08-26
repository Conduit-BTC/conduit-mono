import { config } from "../config"
import { getConfiguredIsolatedE2eRelayUrl } from "./relay-settings"
import type { SignedPublicNostrEvent } from "./signed-event"

export type ExactRelayWriteStatus = "acked" | "rejected" | "timed_out"

const MAX_RESPONSE_FRAMES = 64
const MAX_RESPONSE_CHARS = 256 * 1024
const NIP_01_DUPLICATE_REASON = /^duplicate:/i
const NIP_01_REJECTION_REASON =
  /^(?:pow|blocked|rate-limited|invalid|restricted|mute|error):/i

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
      if (!Array.isArray(parsed) || parsed[0] !== "OK") return
      if (parsed[1] !== eventId) return

      if (parsed[2] === true) {
        finish("acked")
        return
      }
      if (parsed[2] !== false) return

      const reason = typeof parsed[3] === "string" ? parsed[3].trim() : ""
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
