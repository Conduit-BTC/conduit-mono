import type { Page } from "@playwright/test"
import { nip44 } from "nostr-tools"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event,
  type EventTemplate,
} from "nostr-tools/pure"

export type RuntimeSignerIdentity = Readonly<{
  pubkey: string
}>

export type RealTestSignerOptions = {
  rememberAuth?: boolean
  relays?: Record<string, { read: boolean; write: boolean }>
}

const identitySecrets = new WeakMap<RuntimeSignerIdentity, Uint8Array>()
let signerBindingSequence = 0
let relaySubscriptionSequence = 0

const RELAY_FRAME_TIMEOUT_MS = 5_000

type RelayFrame = unknown[]

async function openRelaySocket(relayUrl: string): Promise<{
  frames: RelayFrame[]
  socket: WebSocket
}> {
  const socket = new WebSocket(relayUrl)
  const frames: RelayFrame[] = []
  socket.addEventListener("message", (message) => {
    try {
      const frame = JSON.parse(String(message.data))
      if (Array.isArray(frame)) frames.push(frame)
    } catch {
      // Ignore malformed relay frames. The bounded waits below fail with a
      // static, content-free error when the expected protocol frame is absent.
    }
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("E2E_AUTH_RELAY_OPEN_TIMEOUT")),
      RELAY_FRAME_TIMEOUT_MS
    )
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout)
        reject(new Error("E2E_AUTH_RELAY_OPEN_FAILED"))
      },
      { once: true }
    )
  })

  return { frames, socket }
}

async function waitForRelayFrame(
  frames: RelayFrame[],
  predicate: (frame: RelayFrame) => boolean
): Promise<RelayFrame> {
  const deadline = Date.now() + RELAY_FRAME_TIMEOUT_MS
  while (Date.now() < deadline) {
    const match = frames.find(predicate)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("E2E_AUTH_RELAY_FRAME_TIMEOUT")
}

/**
 * Create a runtime-only test identity without exposing its secret key to the
 * browser context or the returned public descriptor.
 */
export function createRuntimeSignerIdentity(): RuntimeSignerIdentity {
  const secretKey = generateSecretKey()
  const identity = Object.freeze({ pubkey: getPublicKey(secretKey) })
  identitySecrets.set(identity, secretKey)
  return identity
}

/**
 * Remove a runtime identity from the signer harness and zero its mutable key
 * bytes before releasing the final helper-owned reference.
 */
export function disposeRuntimeSignerIdentity(
  identity: RuntimeSignerIdentity
): boolean {
  const secretKey = identitySecrets.get(identity)
  if (!secretKey) return false

  secretKey.fill(0)
  identitySecrets.delete(identity)
  return true
}

function requireIdentitySecret(identity: RuntimeSignerIdentity): Uint8Array {
  const secretKey = identitySecrets.get(identity)
  if (!secretKey) {
    throw new Error("Runtime signer identity was not created by this helper.")
  }
  return secretKey
}

export function signRuntimeTestEvent(
  identity: RuntimeSignerIdentity,
  event: EventTemplate
): Event {
  return finalizeEvent(
    {
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
    },
    requireIdentitySecret(identity)
  )
}

export function encryptRuntimeTestPayload(
  identity: RuntimeSignerIdentity,
  peerPubkey: string,
  plaintext: string
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(
    requireIdentitySecret(identity),
    peerPubkey
  )
  return nip44.v2.encrypt(plaintext, conversationKey)
}

export function decryptRuntimeTestPayload(
  identity: RuntimeSignerIdentity,
  peerPubkey: string,
  ciphertext: string
): string {
  const conversationKey = nip44.v2.utils.getConversationKey(
    requireIdentitySecret(identity),
    peerPubkey
  )
  return nip44.v2.decrypt(ciphertext, conversationKey)
}

/**
 * Read the runtime identity's NIP-59 inbox through the relay's NIP-42 gate.
 *
 * The query is intentionally fixed to one exact recipient and kind 1059 so a
 * test cannot accidentally widen a private read. Raw frames, ciphertext, and
 * signer material remain runner-only and never appear in thrown errors.
 */
export async function readAuthenticatedGiftWraps(
  identity: RuntimeSignerIdentity,
  relayUrl: string
): Promise<Event[]> {
  requireIdentitySecret(identity)
  relaySubscriptionSequence += 1
  const suffix = String(relaySubscriptionSequence)
  const challengeSubscriptionId = `gift-wrap-challenge-${suffix}`
  const authenticatedSubscriptionId = `gift-wrap-read-${suffix}`
  const { frames, socket } = await openRelaySocket(relayUrl)

  try {
    const protectedFilter = {
      kinds: [1_059],
      "#p": [identity.pubkey],
    }
    socket.send(
      JSON.stringify(["REQ", challengeSubscriptionId, protectedFilter])
    )
    const challengeFrame = await waitForRelayFrame(
      frames,
      (frame) => frame[0] === "AUTH" && typeof frame[1] === "string"
    )
    await waitForRelayFrame(
      frames,
      (frame) => frame[0] === "CLOSED" && frame[1] === challengeSubscriptionId
    )

    const authEvent = signRuntimeTestEvent(identity, {
      kind: 22_242,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [
        ["relay", relayUrl],
        ["challenge", challengeFrame[1] as string],
      ],
      content: "",
    })
    socket.send(JSON.stringify(["AUTH", authEvent]))
    const authAck = await waitForRelayFrame(
      frames,
      (frame) => frame[0] === "OK" && frame[1] === authEvent.id
    )
    if (authAck[2] !== true) throw new Error("E2E_AUTH_RELAY_REJECTED")

    socket.send(
      JSON.stringify(["REQ", authenticatedSubscriptionId, protectedFilter])
    )
    await waitForRelayFrame(
      frames,
      (frame) => frame[0] === "EOSE" && frame[1] === authenticatedSubscriptionId
    )

    const events = new Map<string, Event>()
    for (const frame of frames) {
      if (
        frame[0] !== "EVENT" ||
        frame[1] !== authenticatedSubscriptionId ||
        typeof frame[2] !== "object" ||
        frame[2] === null
      ) {
        continue
      }
      const event = frame[2] as Event
      if (
        event.kind === 1_059 &&
        verifyEvent(event) &&
        event.tags.some(
          ([name, value]) => name === "p" && value === identity.pubkey
        )
      ) {
        events.set(event.id, event)
      }
    }
    return [...events.values()]
  } finally {
    socket.close()
  }
}

/**
 * Install a NIP-07-shaped signer whose sensitive operations remain in the
 * Playwright runner. Only public identity and relay preferences are serialized
 * into the page.
 */
export async function installRealTestSigner(
  page: Page,
  identity: RuntimeSignerIdentity,
  relayUrl: string,
  options: RealTestSignerOptions = {}
): Promise<void> {
  requireIdentitySecret(identity)
  signerBindingSequence += 1
  const bindingSuffix = String(signerBindingSequence)
  const signBinding = `__conduitRealSignEvent${bindingSuffix}`
  const encryptBinding = `__conduitRealNip44Encrypt${bindingSuffix}`
  const decryptBinding = `__conduitRealNip44Decrypt${bindingSuffix}`

  await page.exposeFunction(signBinding, (event: EventTemplate) =>
    signRuntimeTestEvent(identity, event)
  )
  await page.exposeFunction(
    encryptBinding,
    (peerPubkey: string, plaintext: string) =>
      encryptRuntimeTestPayload(identity, peerPubkey, plaintext)
  )
  await page.exposeFunction(
    decryptBinding,
    (peerPubkey: string, ciphertext: string) =>
      decryptRuntimeTestPayload(identity, peerPubkey, ciphertext)
  )

  await page.addInitScript(
    ({
      pubkey,
      rememberAuth,
      relays,
      signEventBinding,
      encryptNip44Binding,
      decryptNip44Binding,
    }) => {
      if (rememberAuth) localStorage.setItem("conduit:auth", pubkey)

      const runner = window as typeof window &
        Record<string, (...args: unknown[]) => Promise<unknown>>
      Object.defineProperty(window, "nostr", {
        configurable: true,
        value: {
          async getPublicKey() {
            return pubkey
          },
          async getRelays() {
            return relays
          },
          async signEvent(event: Record<string, unknown>) {
            return await runner[signEventBinding]!(event)
          },
          nip44: {
            async encrypt(peerPubkey: string, plaintext: string) {
              return await runner[encryptNip44Binding]!(peerPubkey, plaintext)
            },
            async decrypt(peerPubkey: string, ciphertext: string) {
              return await runner[decryptNip44Binding]!(peerPubkey, ciphertext)
            },
          },
        },
      })
    },
    {
      pubkey: identity.pubkey,
      rememberAuth: options.rememberAuth !== false,
      relays: options.relays ?? {
        [relayUrl]: { read: true, write: true },
      },
      signEventBinding: signBinding,
      encryptNip44Binding: encryptBinding,
      decryptNip44Binding: decryptBinding,
    }
  )
}
