import { afterEach, expect, test } from "bun:test"
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { config } from "../packages/core/src/config"
import { emptyAccountNetworkLocalState } from "../packages/core/src/protocol/account-network-local-state"
import { relayTargetsFromUrls } from "../packages/core/src/protocol/relay-authority"
import {
  __resetRelayPublishTestOverrides,
  __setRelayPublishTestOverrides,
  publishSignedEventPlan,
} from "../packages/core/src/protocol/relay-publish"

afterEach(__resetRelayPublishTestOverrides)
const event = () =>
  finalizeEvent(
    { kind: 1, content: "", tags: [], created_at: 1700000000 },
    generateSecretKey()
  )
const urls = [
  "wss://first.fixture.conduit.market",
  "wss://second.fixture.conduit.market",
  "wss://third.fixture.conduit.market",
  "wss://fourth.fixture.conduit.market",
]

test("small write concurrency drains exact bytes without requiring every relay to succeed", async () => {
  const signed = event()
  const bytes = JSON.stringify(signed)
  const attempts: string[] = []
  let active = 0,
    peak = 0
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: async (input) => {
      active++
      peak = Math.max(peak, active)
      expect(JSON.stringify(input.signedEvent)).toBe(bytes)
      attempts.push(input.relayUrl)
      await new Promise((resolve) =>
        setTimeout(resolve, input.relayUrl === urls[0] ? 30 : 1)
      )
      active--
      return input.relayUrl === urls[0] ? "timed_out" : "acked"
    },
  })
  const result = await publishSignedEventPlan({
    event: signed,
    intent: "author_event",
    authorPubkey: signed.pubkey,
    relayUrls: urls,
    maxRelayAttempts: 2,
    requiredRelayCount: 1,
    timeoutMs: 50,
  })
  expect(peak).toBe(2)
  expect(attempts).toEqual(urls)
  expect(result.thrown).toBeNull()
  expect(result.successfulRelayUrls).toEqual(urls.slice(1))
  expect(result.failedRelayUrls).toEqual([urls[0]!])
})

test("queued writes honor app-off, exclusions, duplicate grants and account replacement", async () => {
  const signed = event()
  const state = emptyAccountNetworkLocalState(signed.pubkey)
  const [appA, appB] = config.appWriteRelayUrls
  let current = true
  const attempts: string[] = []
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: async (input) => {
      attempts.push(input.relayUrl)
      if (input.relayUrl === urls[0]) {
        state.routingPolicy.appRelaysEnabled = false
        state.exclusions = [
          {
            relayUrl: urls[1]!,
            committedAt: Date.now(),
            relayListFrontier: { eventId: null, createdAt: null },
            inboxDeclarationFrontier: { eventId: null, createdAt: null },
          },
        ]
      }
      if (input.relayUrl === appB) current = false
      return "acked"
    },
  })
  const result = await publishSignedEventPlan({
    event: signed,
    intent: "author_event",
    authorPubkey: signed.pubkey,
    relayUrls: [urls[0]!, appA!, urls[1]!, appB!, urls[2]!],
    relayTargets: [
      ...relayTargetsFromUrls([appA!, appB!], {
        kind: "app",
        operation: "write",
        bucket: "general_write",
      }),
      ...relayTargetsFromUrls([...urls, appB!], {
        kind: "public_hint",
        operation: "write",
      }),
    ],
    maxRelayAttempts: 1,
    requiredRelayCount: 1,
    timeoutMs: 50,
    accountPubkey: signed.pubkey,
    authenticatedPubkey: signed.pubkey,
    accountNetworkLocalStateRepository: {
      get: async () => structuredClone(state),
    },
    shouldContinue: () => current,
  })
  expect(attempts).toEqual([urls[0]!, appB!])
  expect(
    result.relayAttempts.map(({ relayUrl, status }) => [relayUrl, status])
  ).toEqual([
    [urls[0], "acked"],
    [appA, "policy_blocked"],
    [urls[1], "policy_blocked"],
    [appB, "acked"],
    [urls[2], "cancelled"],
  ])
})

test("an exclusive private plan never gains app or unrelated personal destinations", async () => {
  const signed = finalizeEvent(
    {
      kind: 1059,
      content: "opaque",
      tags: [["p", "a".repeat(64)]],
      created_at: 1700000000,
    },
    generateSecretKey()
  )
  const attempts: string[] = []
  __setRelayPublishTestOverrides({
    publishSignedEventFrameToRelay: async (input) => {
      attempts.push(input.relayUrl)
      return "acked"
    },
  })
  await publishSignedEventPlan({
    event: signed,
    intent: "recipient_event",
    relayUrls: [urls[2]!],
    maxRelayAttempts: 1,
    requiredRelayCount: 1,
    timeoutMs: 50,
  })
  expect(attempts).toEqual([urls[2]!])
})
