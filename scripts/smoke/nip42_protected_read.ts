import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools"
import {
  WebSocketCommerceRelayExecutor,
  type RelayObservation,
} from "../../packages/core/src/protocol/relay-executor"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../../packages/core/src/protocol/protected-read-authorization"
import type { NostrEventSigner } from "../../packages/core/src/protocol/nostr-event-signer"

const ACCOUNT_KEY = new Uint8Array(32).fill(31)
const OTHER_ACCOUNT_KEY = new Uint8Array(32).fill(32)
const WRAP_KEY = new Uint8Array(32).fill(33)
const ACCOUNT_PUBKEY = getPublicKey(ACCOUNT_KEY)
const OTHER_ACCOUNT_PUBKEY = getPublicKey(OTHER_ACCOUNT_KEY)

type RelaySocketData = {
  connectionId: number
  challenge: string
  authenticatedPubkey?: string
  challengeSent: boolean
  challengeUsed: boolean
}

type RelayFilter = {
  kinds?: number[]
  "#p"?: string[]
}

let connectionSequence = 0
let relayUrl = ""
let authenticatedAccountConnectionId: number | null = null
const protectedSubscriptionIdsByConnection = new Map<number, string[]>()

const giftWrap = finalizeEvent(
  {
    kind: 1_059,
    created_at: Math.floor(Date.now() / 1_000),
    tags: [["p", ACCOUNT_PUBKEY]],
    content: "encrypted-fixture",
  },
  WRAP_KEY
)

function send(ws: ServerWebSocket<RelaySocketData>, frame: unknown[]): void {
  ws.send(JSON.stringify(frame))
}

function isExactAuthentication(
  event: unknown,
  data: RelaySocketData
): event is ReturnType<typeof finalizeEvent> {
  if (!event || typeof event !== "object") return false
  const signed = event as ReturnType<typeof finalizeEvent>
  if (!verifyEvent(signed)) return false
  if (signed.kind !== 22_242 || signed.content !== "") return false
  if (Math.abs(Math.floor(Date.now() / 1_000) - signed.created_at) > 60) {
    return false
  }
  return (
    !data.challengeUsed &&
    signed.tags.filter((tag) => tag[0] === "relay").length === 1 &&
    signed.tags.filter((tag) => tag[0] === "challenge").length === 1 &&
    signed.tags.some((tag) => tag[0] === "relay" && tag[1] === relayUrl) &&
    signed.tags.some(
      (tag) => tag[0] === "challenge" && tag[1] === data.challenge
    )
  )
}

function handleRelayMessage(
  ws: ServerWebSocket<RelaySocketData>,
  payload: string | BufferSource
): void {
  const raw =
    typeof payload === "string"
      ? payload
      : Buffer.from(payload as ArrayBuffer).toString("utf8")
  let frame: unknown
  try {
    frame = JSON.parse(raw)
  } catch {
    send(ws, ["NOTICE", "invalid"])
    return
  }
  if (!Array.isArray(frame) || typeof frame[0] !== "string") return

  if (frame[0] === "AUTH") {
    const event = frame[1]
    const accepted = isExactAuthentication(event, ws.data)
    const eventId =
      event && typeof event === "object" && "id" in event
        ? String(event.id)
        : "invalid"
    if (accepted) {
      ws.data.challengeUsed = true
      ws.data.authenticatedPubkey = event.pubkey
      if (event.pubkey === ACCOUNT_PUBKEY) {
        authenticatedAccountConnectionId = ws.data.connectionId
      }
    }
    send(ws, ["OK", eventId, accepted, accepted ? "" : "restricted:"])
    return
  }

  if (frame[0] !== "REQ" || typeof frame[1] !== "string") return
  const subscriptionId = frame[1]
  const filters = frame.slice(2) as RelayFilter[]
  const protectedFilters = filters.filter((filter) =>
    filter.kinds?.includes(1_059)
  )
  if (protectedFilters.length > 0) {
    const subscriptions =
      protectedSubscriptionIdsByConnection.get(ws.data.connectionId) ?? []
    subscriptions.push(subscriptionId)
    protectedSubscriptionIdsByConnection.set(
      ws.data.connectionId,
      subscriptions
    )
    if (!ws.data.authenticatedPubkey) {
      if (!ws.data.challengeSent) {
        ws.data.challengeSent = true
        send(ws, ["AUTH", ws.data.challenge])
      }
      send(ws, ["CLOSED", subscriptionId, "auth-required:"])
      return
    }
    const authorized = protectedFilters.every(
      (filter) =>
        filter.kinds?.length === 1 &&
        filter["#p"]?.length === 1 &&
        filter["#p"]?.[0] === ws.data.authenticatedPubkey
    )
    if (!authorized) {
      send(ws, ["CLOSED", subscriptionId, "restricted:"])
      return
    }
    if (ws.data.authenticatedPubkey === ACCOUNT_PUBKEY) {
      send(ws, ["EVENT", subscriptionId, giftWrap])
    }
    send(ws, ["EOSE", subscriptionId])
    return
  }

  // Public discovery/product reads remain anonymous even though the
  // connection received a challenge.
  send(ws, ["EOSE", subscriptionId])
}

function nextFrame(
  ws: WebSocket,
  predicate: (frame: unknown[]) => boolean,
  timeoutMs = 2_000
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", onMessage)
      reject(new Error("fixture timeout"))
    }, timeoutMs)
    const onMessage = (event: MessageEvent<string>) => {
      const frame = JSON.parse(event.data) as unknown[]
      if (!predicate(frame)) return
      clearTimeout(timeout)
      ws.removeEventListener("message", onMessage)
      resolve(frame)
    }
    ws.addEventListener("message", onMessage)
  })
}

async function openSocket(): Promise<WebSocket> {
  const ws = new WebSocket(relayUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true })
    ws.addEventListener(
      "error",
      () => reject(new Error("fixture connection")),
      {
        once: true,
      }
    )
  })
  return ws
}

function coarseTransitions(observations: RelayObservation[]): string[] {
  return observations.map((observation) => {
    switch (observation.type) {
      case "connection":
        return `connection_${observation.state}`
      case "auth":
        return `auth_${observation.state}`
      case "timeout":
        return `${observation.phase}_timeout`
      default:
        return observation.type
    }
  })
}

const server = Bun.serve<RelaySocketData>({
  hostname: "127.0.0.1",
  port: Number(process.env.NIP42_SMOKE_PORT ?? "17842"),
  fetch(request, instance) {
    connectionSequence += 1
    const challenge = `fixture-${connectionSequence}`
    if (
      instance.upgrade(request, {
        data: {
          connectionId: connectionSequence,
          challenge,
          challengeSent: false,
          challengeUsed: false,
        },
      })
    ) {
      return
    }
    return new Response("NIP-42 fixture", { status: 200 })
  },
  websocket: {
    message(ws, message) {
      handleRelayMessage(ws, message)
    },
  },
})
relayUrl = `ws://127.0.0.1:${server.port}`

async function run(): Promise<void> {
  const unauthenticated = await openSocket()
  const unauthenticatedChallenge = nextFrame(
    unauthenticated,
    (frame) => frame[0] === "AUTH"
  )
  const unauthenticatedRejection = nextFrame(
    unauthenticated,
    (frame) => frame[0] === "CLOSED"
  )
  unauthenticated.send(
    JSON.stringify([
      "REQ",
      "unauthenticated",
      { kinds: [1_059], "#p": [ACCOUNT_PUBKEY] },
    ])
  )
  await unauthenticatedChallenge
  const unauthenticatedClosed = await unauthenticatedRejection
  unauthenticated.close()

  let signerCalls = 0
  const eventSigner: NostrEventSigner = {
    authMethod: "nip07",
    getPublicKey: async () => ACCOUNT_PUBKEY,
    signEvent: async (event) => {
      signerCalls += 1
      return finalizeEvent(event, ACCOUNT_KEY)
    },
  }
  installProtectedReadSigner(eventSigner, ACCOUNT_PUBKEY, () => true)
  const authorization = getProtectedReadAuthorization(ACCOUNT_PUBKEY)
  if (!authorization) throw new Error("fixture authorization")
  const executor = new WebSocketCommerceRelayExecutor()
  const protectedResult = await executor.query(
    {
      relayUrls: [relayUrl],
      operation: "private_inbox_read",
      filters: [{ kinds: [1_059], "#p": [ACCOUNT_PUBKEY] }],
    },
    { authorization, authTimeoutMs: 2_000, queryTimeoutMs: 2_000 }
  )
  const signerCallsAfterProtectedRead = signerCalls
  const publicResult = await executor.query({
    relayUrls: [relayUrl],
    operation: "public_read",
    filters: [{ kinds: [30_402], limit: 1 }],
  })

  const otherAccount = await openSocket()
  const challengePromise = nextFrame(
    otherAccount,
    (frame) => frame[0] === "AUTH"
  )
  const initialOtherRejection = nextFrame(
    otherAccount,
    (frame) => frame[0] === "CLOSED"
  )
  otherAccount.send(
    JSON.stringify([
      "REQ",
      "other-bootstrap",
      { kinds: [1_059], "#p": [OTHER_ACCOUNT_PUBKEY] },
    ])
  )
  const challengeFrame = await challengePromise
  await initialOtherRejection
  const challenge = String(challengeFrame[1])
  const otherAuth = finalizeEvent(
    {
      kind: 22_242,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [
        ["relay", relayUrl],
        ["challenge", challenge],
      ],
      content: "",
    },
    OTHER_ACCOUNT_KEY
  )
  otherAccount.send(JSON.stringify(["AUTH", otherAuth]))
  await nextFrame(
    otherAccount,
    (frame) => frame[0] === "OK" && frame[2] === true
  )
  otherAccount.send(
    JSON.stringify([
      "REQ",
      "cross-recipient",
      { kinds: [1_059], "#p": [ACCOUNT_PUBKEY] },
    ])
  )
  const crossRecipientClosed = await nextFrame(
    otherAccount,
    (frame) => frame[0] === "CLOSED"
  )
  otherAccount.close()

  const authenticatedSubscriptionIds =
    authenticatedAccountConnectionId === null
      ? []
      : (protectedSubscriptionIdsByConnection.get(
          authenticatedAccountConnectionId
        ) ?? [])
  const unauthenticatedRejected = String(unauthenticatedClosed[2]).startsWith(
    "auth-required:"
  )
  const crossRecipientRejected = String(crossRecipientClosed[2]).startsWith(
    "restricted:"
  )
  const retriedWithNewSubscription =
    authenticatedSubscriptionIds.length === 2 &&
    authenticatedSubscriptionIds[0] !== authenticatedSubscriptionIds[1]
  const transitions = coarseTransitions(protectedResult.observations)

  if (!unauthenticatedRejected) {
    throw new Error("Unauthenticated protected read was not rejected")
  }
  if (
    protectedResult.status !== "success" ||
    protectedResult.events.length !== 1 ||
    protectedResult.relays[0]?.auth !== "succeeded"
  ) {
    throw new Error("Authenticated protected read did not complete")
  }
  if (!retriedWithNewSubscription) {
    throw new Error("Protected read did not retry with a new subscription")
  }
  if (!crossRecipientRejected) {
    throw new Error("Cross-recipient protected read was not rejected")
  }
  if (publicResult.status !== "success") {
    throw new Error("Anonymous public product read did not complete")
  }
  if (signerCalls !== signerCallsAfterProtectedRead) {
    throw new Error("Public read requested a signer operation")
  }

  console.log(
    JSON.stringify(
      {
        unauthenticatedProtectedRead: "rejected",
        authenticatedProtectedRead: protectedResult.status,
        authenticatedEventCount: protectedResult.events.length,
        retriedWithNewSubscription,
        transitions,
        crossRecipientRead: "rejected",
        publicProductRead: publicResult.status,
        publicSignerCalls: signerCalls - signerCallsAfterProtectedRead,
      },
      null,
      2
    )
  )
  executor.dispose()
}

try {
  await run()
} catch (error) {
  console.error(
    error instanceof Error
      ? `NIP-42 protected-read smoke failed: ${error.message}`
      : "NIP-42 protected-read smoke failed"
  )
  process.exitCode = 1
} finally {
  __resetProtectedReadSigner()
  server.stop(true)
}
