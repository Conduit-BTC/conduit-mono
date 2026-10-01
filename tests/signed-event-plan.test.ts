import { afterEach, describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import {
  __resetRelayPublishTestOverrides,
  __setRelayPublishTestOverrides,
  emptyAccountNetworkLocalState,
  publishSignedEventPlan,
  publishWithPlanner,
  publishWithPlannerProgressive,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import { publishSignedEventFrameToRelay } from "../packages/core/src/protocol/relay-writer"

function event(kind = 1): SignedPublicNostrEvent {
  return finalizeEvent(
    {
      kind,
      created_at: 1_700_000_000,
      tags: [],
      content: "synthetic transport fixture",
    },
    generateSecretKey()
  )
}

afterEach(__resetRelayPublishTestOverrides)

function controlledRelays() {
  const frames: string[] = []
  const counts = { opened: 0, closed: 0 }
  const sockets = new Set<import("bun").ServerWebSocket<{ mode: string }>>()
  const server = Bun.serve<{ mode: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { mode: new URL(request.url).pathname.slice(1) },
        })
      )
        return
      return new Response("Controlled relay", { status: 400 })
    },
    websocket: {
      open(socket) {
        counts.opened++
        sockets.add(socket)
      },
      close(socket) {
        counts.closed++
        sockets.delete(socket)
      },
      message(socket, message) {
        const text = String(message)
        const [type, signed] = JSON.parse(text) as [
          string,
          SignedPublicNostrEvent,
        ]
        if (type !== "EVENT")
          throw new Error("Unexpected signing or subscription frame")
        frames.push(text)
        const mode = socket.data.mode
        if (mode === "disconnect") {
          socket.close()
          return
        }
        if (mode === "stall") return
        if (mode === "noise") {
          socket.send("not json")
          socket.send(JSON.stringify(["OK", "0".repeat(64), true, ""]))
        }
        setTimeout(
          () => {
            if (!sockets.has(socket)) return
            const accepted =
              mode !== "reject" && mode !== "auth" && mode !== "duplicate"
            const reason =
              mode === "reject"
                ? "invalid: synthetic rejection"
                : mode === "auth"
                  ? "auth-required: synthetic challenge"
                  : mode === "duplicate"
                    ? "duplicate: already stored"
                    : ""
            socket.send(JSON.stringify(["OK", signed.id, accepted, reason]))
            if (mode === "noise")
              socket.send(
                JSON.stringify([
                  "OK",
                  signed.id,
                  false,
                  "invalid: reordered duplicate",
                ])
              )
          },
          mode === "late" ? 250 : 5
        )
      },
    },
  })
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: (input) =>
      publishSignedEventFrameToRelay({
        ...input,
        createWebSocket: (url) =>
          new WebSocket(
            `ws://127.0.0.1:${server.port}/${new URL(url).hostname.split(".")[0]}`
          ),
      }),
  })
  return {
    frames,
    counts,
    stop: async () => {
      server.stop(true)
      await new Promise((resolve) => setTimeout(resolve, 10))
    },
  }
}

describe("composed plain signed-event target plan", () => {
  it("records a fast ACK before stalled peers finish and closes every socket", async () => {
    const relay = controlledRelays()
    try {
      const signed = event()
      const started = performance.now()
      let firstAckMs: number | undefined
      const result = await publishSignedEventPlan({
        event: signed,
        relayUrls: [
          "wss://fast.fixture.conduit.market",
          "wss://stall.fixture.conduit.market",
          "wss://reject.fixture.conduit.market",
        ],
        timeoutMs: 150,
        requiredRelayCount: 1,
        onOutcome: (outcome) => {
          if (outcome.status === "acked")
            firstAckMs = performance.now() - started
        },
      })
      const terminalMs = performance.now() - started
      expect(firstAckMs).toBeDefined()
      expect(firstAckMs!).toBeLessThan(terminalMs)
      expect(result.thrown).toBeNull()
      expect(
        result.relayAttempts.map((outcome) => outcome.status).sort()
      ).toEqual(["acked", "rejected", "timed_out"])
      expect(result.admittedRelayUrls).toHaveLength(3)
      expect(result.attemptedRelayUrls).toHaveLength(3)
      expect(relay.frames).toHaveLength(3)
      expect(new Set(relay.frames).size).toBe(1)
      await relay.stop()
      expect(relay.counts).toEqual({ opened: 3, closed: 3 })
      console.info("Controlled local WebSocket publish evidence", {
        ...relay.counts,
        firstAckMs: Math.round(firstAckMs!),
        terminalMs: Math.round(terminalMs),
      })
    } finally {
      await relay.stop()
    }
  })

  it("keeps cancellation evidence through standard and progressive zero-ACK results", async () => {
    for (const progressive of [false, true]) {
      const relay = controlledRelays()
      const signed = event(progressive ? 1059 : 1)
      const cancellation = new AbortController()
      const target = "wss://stall.fixture.conduit.market"
      try {
        const input = {
          intent: progressive
            ? ("recipient_event" as const)
            : ("author_event" as const),
          authorPubkey: signed.pubkey,
          exclusiveRelayUrls: [target],
          deliveryMode: "critical" as const,
          signal: cancellation.signal,
        }
        const publishing = progressive
          ? (await publishWithPlannerProgressive(signed, input)).accepted
          : publishWithPlanner(signed, input)
        const errorPromise = publishing.catch((error: unknown) => error)
        while (relay.frames.length === 0)
          await new Promise((resolve) => setTimeout(resolve, 1))
        cancellation.abort()
        const error = (await errorPromise) as {
          diagnostics: {
            relayAttempts: Array<{ status: string }>
          }
        }
        expect(error.diagnostics.relayAttempts).toEqual([
          {
            relayUrl: target,
            attempt: 1,
            status: "cancelled",
          },
        ])
        expect(JSON.stringify(error.diagnostics)).not.toContain(signed.id)
        expect(relay.frames).toHaveLength(1)
        await relay.stop()
        expect(relay.counts).toEqual({ opened: 1, closed: 1 })
      } finally {
        await relay.stop()
      }
    }
  })

  it("preserves auth-required, disconnect, late ACK and zero-ACK terminal truth", async () => {
    const relay = controlledRelays()
    try {
      const result = await publishSignedEventPlan({
        event: event(),
        relayUrls: [
          "wss://auth.fixture.conduit.market",
          "wss://disconnect.fixture.conduit.market",
          "wss://late.fixture.conduit.market",
        ],
        timeoutMs: 100,
        requiredRelayCount: 1,
      })
      expect(result.thrown).toBeInstanceOf(Error)
      expect(result.successfulRelayUrls).toEqual([])
      expect(
        result.relayAttempts.map((outcome) => outcome.status).sort()
      ).toEqual(["auth_required", "timed_out", "timed_out"])
    } finally {
      await relay.stop()
    }
  })

  it("ignores unrelated and reordered OK frames, and treats duplicate as idempotent ACK", async () => {
    const relay = controlledRelays()
    try {
      const result = await publishSignedEventPlan({
        event: event(),
        relayUrls: [
          "wss://noise.fixture.conduit.market",
          "wss://duplicate.fixture.conduit.market",
        ],
        timeoutMs: 150,
        requiredRelayCount: 1,
      })
      expect(result.successfulRelayUrls.sort()).toEqual([
        "wss://duplicate.fixture.conduit.market",
        "wss://noise.fixture.conduit.market",
      ])
      expect(result.rejectedRelayUrls).toEqual([])
    } finally {
      await relay.stop()
    }
  })

  it("cancels an already-sent event on abort or account change without inventing a timeout", async () => {
    for (const fence of ["abort", "account"] as const) {
      const relay = controlledRelays()
      const cancellation = new AbortController()
      const signed = event()
      let activeAccount: string | null = signed.pubkey
      try {
        const resultPromise = publishSignedEventPlan({
          event: signed,
          relayUrls: ["wss://stall.fixture.conduit.market"],
          timeoutMs: 1_000,
          requiredRelayCount: 1,
          accountPubkey: signed.pubkey,
          accountNetworkLocalStateRepository: { get: async () => undefined },
          shouldContinue: () => activeAccount === signed.pubkey,
          signal: cancellation.signal,
        })
        while (relay.frames.length === 0)
          await new Promise((resolve) => setTimeout(resolve, 1))
        if (fence === "abort") cancellation.abort()
        else activeAccount = null
        const result = await resultPromise
        expect(result.relayAttempts[0]?.status).toBe("cancelled")
        expect(result.successfulRelayUrls).toEqual([])
        expect(result.attemptedRelayUrls).toEqual([
          "wss://stall.fixture.conduit.market",
        ])
        expect(relay.frames).toHaveLength(1)
        await relay.stop()
        expect(relay.counts).toEqual({ opened: 1, closed: 1 })
      } finally {
        await relay.stop()
      }
    }
  })

  it("snapshots signed bytes and targets before awaits, then retries the reloaded exact plan", async () => {
    const relay = controlledRelays()
    try {
      const signed = event()
      const checkpoint = JSON.stringify({
        event: signed,
        targets: ["wss://disconnect.fixture.conduit.market"],
      })
      const relayUrls = ["wss://disconnect.fixture.conduit.market"]
      const promise = publishSignedEventPlan({
        event: signed,
        relayUrls,
        timeoutMs: 150,
        requiredRelayCount: 1,
      })
      signed.content = "mutated by caller"
      relayUrls.push("wss://widened.fixture.conduit.market")
      const first = await promise
      const reloaded = JSON.parse(checkpoint) as {
        event: SignedPublicNostrEvent
        targets: string[]
      }
      const second = await publishSignedEventPlan({
        event: reloaded.event,
        relayUrls: reloaded.targets,
        timeoutMs: 150,
        requiredRelayCount: 1,
      })
      expect(first.attemptedRelayUrls).toEqual(reloaded.targets)
      expect(second.attemptedRelayUrls).toEqual(reloaded.targets)
      expect(relay.frames).toHaveLength(2)
      expect(relay.frames[0]).toBe(relay.frames[1])
    } finally {
      await relay.stop()
    }
  })

  it("rechecks policy after connection and refuses unsafe or excluded targets without I/O", async () => {
    const signed = event()
    let writes = 0
    let reads = 0
    __setRelayPublishTestOverrides({
      publishSignedEventFrameToRelay: async ({ beforeSend }) => {
        writes++
        expect(await beforeSend?.()).toBe(false)
        return "policy_blocked"
      },
    })
    const result = await publishSignedEventPlan({
      event: signed,
      relayUrls: [
        "wss://fast.fixture.conduit.market",
        "ws://remote.fixture.conduit.market",
        "wss://127.0.0.1",
      ],
      timeoutMs: 150,
      requiredRelayCount: 1,
      accountPubkey: signed.pubkey,
      authenticatedPubkey: signed.pubkey,
      accountNetworkLocalStateRepository: {
        get: async (pubkey) => {
          reads++
          const state = emptyAccountNetworkLocalState(pubkey)
          return reads < 5
            ? state
            : {
                ...state,
                exclusions: [
                  {
                    relayUrl: "wss://fast.fixture.conduit.market",
                    committedAt: 1,
                    relayListFrontier: { eventId: null, createdAt: null },
                    inboxDeclarationFrontier: {
                      eventId: null,
                      createdAt: null,
                    },
                  },
                ],
              }
        },
      },
    })
    expect(writes).toBe(1)
    expect(result.admittedRelayUrls).toEqual([
      "wss://fast.fixture.conduit.market",
    ])
    expect(result.successfulRelayUrls).toEqual([])
  })
})
