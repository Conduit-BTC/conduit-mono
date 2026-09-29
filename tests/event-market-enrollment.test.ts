import { describe, expect, it } from "bun:test"
import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  buildDirectMessageRumor,
  parseDirectMessageRumor,
  type PublishWithPlannerResult,
} from "@conduit/core"
import {
  getEventMarketEnrollmentDisplayContent,
  loadEventMarketEnrollmentDelivery,
  parseEventMarketEnrollmentMessage,
  publishEventMarketEnrollment,
  reduceEventMarketEnrollment,
  retryEventMarketEnrollmentDelivery,
  type EventMarketEnrollmentPayload,
  type EventMarketEnrollmentMessage,
} from "../packages/core/src/protocol/event-market-enrollment"

const organizer = getPublicKey(generateSecretKey())
const merchant = getPublicKey(generateSecretKey())
const marketCoordinate = `30409:${organizer}:fair`
const signer = {} as NDKSigner
function payload(
  action: EventMarketEnrollmentPayload["action"] = "request",
  createdAt = 100
): EventMarketEnrollmentPayload {
  return {
    version: 1,
    action,
    marketCoordinate,
    merchantPubkey: merchant,
    organizerPubkey: organizer,
    createdAt,
  }
}
function rumor(value = payload()) {
  const merchantAction =
    value.action === "request" || value.action === "withdraw"
  return buildDirectMessageRumor({
    senderPubkey: merchantAction ? merchant : organizer,
    recipientPubkey: merchantAction ? organizer : merchant,
    content: `Event Market participation v1\n${JSON.stringify(value)}`,
    createdAt: value.createdAt,
    appId: "merchant",
  })
}
function wrap(recipient: string) {
  return new NDKEvent(
    undefined,
    finalizeEvent(
      {
        kind: 1059,
        content: "encrypted-fixture",
        created_at: 80,
        tags: [["p", recipient]],
      },
      generateSecretKey()
    )
  )
}
function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}
function delivery(ack = true): PublishWithPlannerResult {
  return {
    plan: {} as never,
    attemptedRelayUrls: ["wss://inbox.example"],
    successfulRelayUrls: ack ? ["wss://inbox.example"] : [],
    failedRelayUrls: ack ? [] : ["wss://inbox.example"],
    relayFailureMessages: {},
  }
}

describe("Event Market private enrollment", () => {
  it("shows readable participation summaries without altering the signed content", () => {
    const labels = {
      request: "Requested to join an event.",
      invite: "Invited a merchant to join an event.",
      decline: "Declined a request to join an event.",
      withdraw: "Withdrew a request to join an event.",
    } as const
    for (const action of Object.keys(labels) as (keyof typeof labels)[]) {
      const message = rumor(payload(action))
      const original = message.content
      expect(getEventMarketEnrollmentDisplayContent(original)).toBe(
        labels[action]
      )
      expect(message.content).toBe(original)
      expect(
        parseEventMarketEnrollmentMessage(parseDirectMessageRumor(message))
          ?.action
      ).toBe(action)
    }
    for (const content of [
      "Ordinary chat",
      "Event Market participation v1\n{}",
      "Event Market participation v1\ninvalid",
      rumor({
        ...payload(),
        marketCoordinate: `30409:${merchant}:different-host`,
      }).content,
    ]) {
      expect(getEventMarketEnrollmentDisplayContent(content)).toBe(content)
    }
  })

  it("authenticates actor, exact market, timestamp and NIP-17 transport", () => {
    const message = parseDirectMessageRumor(rumor())
    expect(parseEventMarketEnrollmentMessage(message)?.action).toBe("request")
    expect(
      parseEventMarketEnrollmentMessage({ ...message, senderPubkey: organizer })
    ).toBeNull()
    expect(
      parseEventMarketEnrollmentMessage({ ...message, transport: "nip04" })
    ).toBeNull()
    expect(
      parseEventMarketEnrollmentMessage({
        ...message,
        createdAt: message.createdAt + 1000,
      })
    ).toBeNull()
    expect(
      parseEventMarketEnrollmentMessage(
        parseDirectMessageRumor(
          rumor({ ...payload(), marketCoordinate: `30409:${merchant}:fake` })
        )
      )
    ).toBeNull()
    expect(
      parseEventMarketEnrollmentMessage(
        parseDirectMessageRumor(rumor({ ...payload(), action: "invite" }))
      )?.action
    ).toBe("invite")
  })

  it("keeps request/decline/withdraw states across reload without granting admission", () => {
    const messages = [
      payload("request", 100),
      payload("decline", 101),
      payload("request", 102),
      payload("withdraw", 103),
    ].map((value) =>
      parseEventMarketEnrollmentMessage(parseDirectMessageRumor(rumor(value)))!
    )
    const state = reduceEventMarketEnrollment({
      marketCoordinate,
      messages: JSON.parse(
        JSON.stringify(messages)
      ) as EventMarketEnrollmentMessage[],
    })
    expect(state[0]?.status).toBe("withdrawn")
    expect(Object.keys(state[0]!)).not.toContain("approved")
    expect(
      reduceEventMarketEnrollment({
        marketCoordinate: `30409:${organizer}:other`,
        messages,
      })
    ).toEqual([])
    expect(
      reduceEventMarketEnrollment({
        marketCoordinate,
        messages: messages.slice(0, 2),
      })[0]?.status
    ).toBe("declined")
  })

  it("persists ciphertext before relay I/O and retries the exact wraps after lost ACK", async () => {
    const persistence = memoryStorage()
    const recipient = wrap(organizer)
    const self = wrap(merchant)
    let sends = 0
    let capturedRumor: NDKEvent | undefined
    const attempted: string[] = []
    const cached: string[] = []
    const dependencies = {
      send: (async (input) => {
        sends += 1
        capturedRumor = input.rumor
        await input.onWrapped!({
          rumorId: input.rumor.id,
          wrappedToRecipient: recipient,
          wrappedToSelf: self,
        })
        expect(
          loadEventMarketEnrollmentDelivery(
            merchant,
            marketCoordinate,
            persistence
          )?.signedRecipientWrap.id
        ).toBe(recipient.id)
        throw new Error("ACK lost")
      }) as typeof import("../packages/core/src/protocol/messaging").publishPrivateMessage,
      cache: async (message: ReturnType<typeof parseDirectMessageRumor>) => {
        cached.push(message.id)
      },
      inbox: async (owner: string) => ({
        state: "ready" as const,
        organizerPubkey: owner,
        relayUrls: ["wss://inbox.example"],
      }),
      publish: (async (event) => {
        attempted.push(event.id)
        return delivery()
      }) as typeof import("../packages/core/src/protocol/relay-publish").publishWithPlanner,
      unwrap: (async () => ({
        status: "ok" as const,
        wrapId: self.id,
        rumor: capturedRumor!,
        category: "direct" as const,
      })) as typeof import("../packages/core/src/protocol/messaging").unwrapGiftWrap,
    }
    await expect(
      publishEventMarketEnrollment(
        {
          payload: payload(),
          authenticatedPubkey: merchant,
          signer,
          persistence,
        },
        dependencies
      )
    ).rejects.toThrow("ACK lost")
    const record = loadEventMarketEnrollmentDelivery(
      merchant,
      marketCoordinate,
      persistence
    )!
    await expect(
      publishEventMarketEnrollment(
        {
          payload: payload(),
          authenticatedPubkey: merchant,
          signer,
          persistence,
        },
        dependencies
      )
    ).rejects.toThrow("Retry saved")
    await retryEventMarketEnrollmentDelivery(
      {
        record: JSON.parse(JSON.stringify(record)),
        authenticatedPubkey: merchant,
        signer,
        persistence,
      },
      dependencies
    )
    expect(sends).toBe(1)
    expect(attempted).toEqual([recipient.id, self.id])
    expect(cached).toEqual([record.rumorId])
    expect(
      loadEventMarketEnrollmentDelivery(merchant, marketCoordinate, persistence)
    ).toBeNull()
  })

  it("rejects a tampered descriptor before sending an authenticated different self-copy", async () => {
    const persistence = memoryStorage()
    const self = wrap(merchant)
    const originalRumor = rumor()
    const record = {
      version: 1 as const,
      payload: payload("withdraw"),
      rumorId: originalRumor.id,
      signedRecipientWrap: wrap(organizer).rawEvent() as never,
      signedSelfWrap: self.rawEvent() as never,
    }
    let published = 0
    const dependencies = {
      send: async () => {
        throw new Error("must not sign")
      },
      cache: async () => {},
      inbox: async (owner: string) => ({
        state: "ready" as const,
        organizerPubkey: owner,
        relayUrls: ["wss://inbox.example"],
      }),
      publish: (async () => {
        published += 1
        return delivery()
      }) as typeof import("../packages/core/src/protocol/relay-publish").publishWithPlanner,
      unwrap: (async () => ({
        status: "ok" as const,
        wrapId: self.id,
        rumor: originalRumor,
        category: "direct" as const,
      })) as typeof import("../packages/core/src/protocol/messaging").unwrapGiftWrap,
    }
    await expect(
      retryEventMarketEnrollmentDelivery(
        { record, authenticatedPubkey: merchant, signer, persistence },
        dependencies
      )
    ).rejects.toThrow("authenticated recovery")
    expect(published).toBe(0)
  })
})
