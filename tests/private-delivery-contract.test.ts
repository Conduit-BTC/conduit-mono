import { afterEach, describe, expect, it } from "bun:test"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { ConduitDB } from "../packages/core/src/db"
import { CommerceInboxStore } from "../packages/core/src/protocol/commerce-inbox-store"
import { CommerceInbox } from "../packages/core/src/protocol/commerce-inbox"
import { createInMemoryAccountNetworkLocalStateRepository } from "../packages/core/src/protocol/account-network-local-state"
import { buildPrivateFileRumor } from "../packages/core/src/protocol/private-file-message"
import { sendAccountInboxRumor } from "../packages/core/src/protocol/inbox-send"
import {
  publishPrivateMessage,
  retryPrivateDeliveries,
  retryPrivateMessageWraps,
  type PublishPrivateMessageInput,
  type PrivateDeliveryJob,
} from "../packages/core/src/protocol/private-message-delivery"
import {
  createPrivateMessageRumor,
  unwrapPrivateMessageEnvelope,
  wrapPrivateMessage,
} from "../packages/core/src/protocol/private-message-primitives"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"
import {
  __resetRelayPublishTestOverrides,
  __setRelayPublishTestOverrides,
} from "../packages/core/src/protocol/relay-publish"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"

const RECIPIENT_RELAY = "wss://recipient.inbox.conduit.market"
const SELF_RELAY = "wss://sender.inbox.conduit.market"
const fixtures: Array<{ database: ConduitDB; signer: SessionSigner }> = []

function keySigner(secret: Uint8Array): NostrKeySigner {
  const pubkey = getPublicKey(secret)
  return {
    pubkey,
    authMethod: "nip07",
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, secret),
    encryptNip44: async (peer, plaintext) =>
      v2.encrypt(plaintext, v2.utils.getConversationKey(secret, peer)),
    decryptNip44: async (peer, ciphertext) =>
      v2.decrypt(ciphertext, v2.utils.getConversationKey(secret, peer)),
    decryptLegacy: async () => "",
  }
}

function setup(
  options: {
    selfEncrypt?: (plaintext: string) => Promise<string>
    selfSign?: () => Promise<void>
    operationTimeoutMs?: number
  } = {}
) {
  const senderSecret = generateSecretKey()
  const recipientSecret = generateSecretKey()
  const sender = getPublicKey(senderSecret)
  const recipient = getPublicKey(recipientSecret)
  const rawSigner = keySigner(senderSecret)
  let signCalls = 0
  let sealRecipient: string | null = null
  const signer = new SessionSigner(
    {
      ...rawSigner,
      signEvent: async (event) => {
        signCalls++
        if (event.kind === 13 && sealRecipient === sender) {
          sealRecipient = null
          await options.selfSign?.()
        }
        return await rawSigner.signEvent(event)
      },
      encryptNip44: async (peer, plaintext) => {
        sealRecipient = peer
        return peer === sender && options.selfEncrypt
          ? await options.selfEncrypt(plaintext)
          : await rawSigner.encryptNip44(peer, plaintext)
      },
    },
    {
      expectedPubkey: sender,
      revision: crypto.randomUUID(),
      authMethod: "nip07",
      getCapabilities: () => ({
        signEvent: true,
        nip44: true,
        nip04Decrypt: true,
      }),
      hasAuthority: () => true,
      operationTimeoutMs: options.operationTimeoutMs,
    }
  )
  installProtectedReadSigner(signer, sender, () => true)
  const database = new ConduitDB(`delivery-contract-${crypto.randomUUID()}`, {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
  })
  const store = new CommerceInboxStore(
    getProtectedReadAuthorization(sender)!,
    database
  )
  const accountNetworkLocalStateRepository =
    createInMemoryAccountNetworkLocalStateRepository()
  fixtures.push({ database, signer })
  return {
    sender,
    recipient,
    signer,
    recipientSigner: keySigner(recipientSecret),
    store,
    database,
    accountNetworkLocalStateRepository,
    signCalls: () => signCalls,
  }
}

afterEach(async () => {
  __resetRelayPublishTestOverrides()
  __resetProtectedReadSigner()
  for (const { database, signer } of fixtures.splice(0)) {
    signer.invalidateLocal()
    await database.delete()
  }
})

function rumor(sender: string, recipient: string, kind: 14 | 15 | 16) {
  return createPrivateMessageRumor({
    pubkey: sender,
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", recipient],
      ...(kind === 16
        ? [
            ["type", "message"],
            ["order", "contract-order"],
          ]
        : []),
    ],
    content:
      kind === 16 ? JSON.stringify({ note: "Order reply" }) : "Private reply",
  })
}

function sendInput(
  fixture: ReturnType<typeof setup>,
  kind: 14 | 15 | 16
): PublishPrivateMessageInput {
  return {
    rumor: rumor(fixture.sender, fixture.recipient, kind),
    senderPubkey: fixture.sender,
    recipientPubkey: fixture.recipient,
    accountPubkey: fixture.sender,
    authenticatedPubkey: fixture.sender,
    accountNetworkLocalStateRepository:
      fixture.accountNetworkLocalStateRepository,
    signer: fixture.signer,
    rumorKind: kind,
    recipientInboxRelays: [RECIPIENT_RELAY],
    senderInboxRelays: [SELF_RELAY],
    inspectOwnInboxReadiness: async () => ({
      state: "ready",
      eventId: "a".repeat(64),
      relayUrls: [SELF_RELAY],
      stale: false,
      distributionRepairable: false,
    }),
    deliveryStore: fixture.store,
  }
}

async function stageFailedRecipientWrap(fixture: ReturnType<typeof setup>) {
  const input = sendInput(fixture, 14)
  input.selfCopy = false
  input.publishFn = (async () => {
    throw new Error("recipient relay unavailable")
  }) as NonNullable<PublishPrivateMessageInput["publishFn"]>
  await expect(publishPrivateMessage(input)).rejects.toThrow(
    "recipient relay unavailable"
  )
  const row = (await fixture.database.commerceInboxDeliveries.toArray())[0]!
  const id = row.id.slice(fixture.sender.length + 1)
  const job = await fixture.store.open<PrivateDeliveryJob>(row.value, id)
  return { id, wrap: job.legs[0]!.event }
}

function acknowledged(relay: string) {
  return {
    successfulRelayUrls: [relay],
    failedRelayUrls: [],
    attemptedRelayUrls: [relay],
    relayFailureMessages: {},
    plan: {} as never,
  }
}

describe("private delivery composed contract", () => {
  for (const kind of [16, 14, 15] as const) {
    it(`preserves recipient success for kind ${kind} when optional self delivery fails`, async () => {
      const fixture = setup()
      const published: Array<{ id: string; targets: readonly string[] }> = []
      const input = sendInput(fixture, kind)
      if (kind === 15) {
        const attachment = buildPrivateFileRumor({
          recipientPubkeys: [fixture.recipient],
          url: "https://files.conduit.market/encrypted",
          mimeType: "image/png",
          envelope: {
            algorithm: "aes-gcm",
            key: "1".repeat(64),
            nonce: "2".repeat(24),
            encryptedSha256: "3".repeat(64),
            originalSha256: "4".repeat(64),
            encryptedSize: 128,
          },
        })
        input.rumor = createPrivateMessageRumor({
          pubkey: fixture.sender,
          created_at: Math.floor(Date.now() / 1000),
          ...attachment,
        })
      }
      input.publishFn = (async (event, options) => {
        published.push({
          id: event.id,
          targets: options.exclusiveRelayUrls ?? [],
        })
        if (options.exclusiveRelayUrls?.includes(SELF_RELAY))
          throw new Error("self transport failed")
        return acknowledged(RECIPIENT_RELAY)
      }) as NonNullable<PublishPrivateMessageInput["publishFn"]>
      const result = await publishPrivateMessage(input)
      expect(result.deliveryStatus).toBe("full_success")
      expect(result.selfCopyError).toContain("self transport failed")
      expect(published[0]).toEqual({
        id: result.wrappedToRecipient.id,
        targets: [RECIPIENT_RELAY],
      })
      expect(published[1]?.targets).toEqual([SELF_RELAY])
      const opened = await unwrapPrivateMessageEnvelope(
        result.wrappedToRecipient,
        fixture.recipientSigner
      )
      expect(opened.id).toBe(input.rumor.id)
      expect(opened.kind).toBe(kind)
      expect(opened.tags.filter((tag) => tag[0] === "p")).toEqual([
        ["p", fixture.recipient],
      ])
      expect(result.deliveryRoute).toBe("declared_inbox")
    })
  }

  for (const kind of [16, 14, 15] as const) {
    for (const failure of ["refusal", "provider_loss", "timeout"] as const) {
      it(`keeps kind ${kind} recipient ACK before optional self-wrap ${failure}`, async () => {
        let recipientAccepted = false
        const fixture = setup({
          selfEncrypt: async () => {
            expect(recipientAccepted).toBe(true)
            if (failure === "timeout")
              return await new Promise<string>(() => {})
            throw new Error(
              failure === "provider_loss"
                ? "provider unavailable"
                : "request refused"
            )
          },
          operationTimeoutMs: 150,
        })
        const published: string[] = []
        const result = await publishPrivateMessage({
          ...sendInput(fixture, kind),
          publishFn: (async (event, options) => {
            published.push(event.id)
            expect(options.exclusiveRelayUrls).toEqual([RECIPIENT_RELAY])
            // A protected recipient relay can still request a real signer operation.
            // Optional provider work has not yet had a chance to poison this session.
            await fixture.signer.signEvent({
              pubkey: fixture.sender,
              kind: 22242,
              created_at: Math.floor(Date.now() / 1000),
              tags: [
                ["relay", RECIPIENT_RELAY],
                ["challenge", "synthetic-auth"],
              ],
              content: "",
            })
            recipientAccepted = true
            return acknowledged(RECIPIENT_RELAY)
          }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
        })
        expect(result.deliveryStatus).toBe("full_success")
        expect(published).toEqual([result.wrappedToRecipient.id])
        expect(result.selfCopyError).toBeTruthy()
        expect(
          (
            await unwrapPrivateMessageEnvelope(
              result.wrappedToRecipient,
              fixture.recipientSigner
            )
          ).kind
        ).toBe(kind)
      })
    }
  }
  it("keeps recipient acceptance when the optional sender route is unavailable", async () => {
    const fixture = setup()
    const published: string[] = []
    const result = await publishPrivateMessage({
      ...sendInput(fixture, 16),
      senderInboxRelays: [],
      publishFn: (async (event, options) => {
        published.push(event.id)
        expect(options.exclusiveRelayUrls).toEqual([RECIPIENT_RELAY])
        return acknowledged(RECIPIENT_RELAY)
      }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
    })
    expect(result.deliveryStatus).toBe("full_success")
    expect(published).toEqual([result.wrappedToRecipient.id])
    expect(result.selfCopyError).toBeTruthy()
  })

  for (const kind of [16, 14, 15] as const) {
    it(`does not stage kind ${kind} when the caller rejects wrapped persistence`, async () => {
      const fixture = setup()
      let publishes = 0
      await expect(
        publishPrivateMessage({
          ...sendInput(fixture, kind),
          onWrapped: async () => {
            throw new Error("local persistence failed")
          },
          publishFn: (async () => {
            publishes++
            return acknowledged(RECIPIENT_RELAY)
          }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
        })
      ).rejects.toThrow("local persistence failed")
      expect(publishes).toBe(0)
      expect(await fixture.database.commerceInboxDeliveries.count()).toBe(0)
      await retryPrivateDeliveries(
        fixture.sender,
        (async () => {
          publishes++
          return acknowledged(RECIPIENT_RELAY)
        }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
        undefined,
        fixture.store
      )
      expect(publishes).toBe(0)
    })
  }
  it("retries the persisted signed wrap on original targets after transport failure", async () => {
    const fixture = setup()
    let persistedWrapId = ""
    let failedWrap = ""
    const input = sendInput(fixture, 14)
    input.selfCopy = false
    input.onWrapped = async ({ wrappedToRecipient }) => {
      persistedWrapId = wrappedToRecipient.id
    }
    input.publishFn = (async (event, options) => {
      failedWrap = event.id
      expect(options.exclusiveRelayUrls).toEqual([RECIPIENT_RELAY])
      throw new Error("recipient relay unavailable")
    }) as NonNullable<PublishPrivateMessageInput["publishFn"]>
    await expect(publishPrivateMessage(input)).rejects.toThrow(
      "recipient relay unavailable"
    )
    expect(failedWrap).toBe(persistedWrapId)
    const rows = await fixture.database.commerceInboxDeliveries.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe("failed")
    const logicalId = rows[0]!.id.slice(fixture.sender.length + 1)
    const job = await fixture.store.open<PrivateDeliveryJob>(
      rows[0]!.value,
      logicalId
    )
    expect(job.legs[0]?.event.id).toBe(persistedWrapId)
    expect(job.legs[0]?.relayUrls).toEqual([RECIPIENT_RELAY])
    const signCallsBeforeRetry = fixture.signCalls()
    let retryCount = 0
    await retryPrivateDeliveries(
      fixture.sender,
      (async () => {
        retryCount++
        return acknowledged(RECIPIENT_RELAY)
      }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
      logicalId,
      fixture.store,
      (async () => ({
        pubkey: fixture.recipient,
        state: "declared",
        relayUrls: ["wss://new-recipient.inbox.conduit.market"],
        stale: false,
        fetchedAt: Date.now(),
      })) as never
    )
    expect(retryCount).toBe(0)
    expect(
      (await fixture.database.commerceInboxDeliveries.get(rows[0]!.id))?.state
    ).toBe("failed")
    await retryPrivateDeliveries(
      fixture.sender,
      (async (event, options) => {
        retryCount++
        expect(event).toEqual(job.legs[0]?.event)
        expect(options.exclusiveRelayUrls).toEqual([RECIPIENT_RELAY])
        return acknowledged(RECIPIENT_RELAY)
      }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
      logicalId,
      fixture.store,
      (async () => ({
        pubkey: fixture.recipient,
        state: "declared",
        relayUrls: [RECIPIENT_RELAY],
        stale: false,
        fetchedAt: Date.now(),
      })) as never
    )
    expect(retryCount).toBe(1)
    expect(fixture.signCalls()).toBe(signCallsBeforeRetry)
    expect(
      (await fixture.database.commerceInboxDeliveries.get(rows[0]!.id))?.state
    ).toBe("accepted")
  })

  it("passes foreground NIP-42 capability for the exact saved wrap after visibility", async () => {
    const fixture = setup()
    const { id, wrap } = await stageFailedRecipientWrap(fixture)
    const signsBeforeRetry = fixture.signCalls()
    let visibilityEntered!: () => void
    let resumeVisibility!: () => void
    const entered = new Promise<void>((resolve) => {
      visibilityEntered = resolve
    })
    const visible = new Promise<void>((resolve) => {
      resumeVisibility = resolve
    })
    let publishes = 0
    const retry = retryPrivateDeliveries(
      fixture.sender,
      (async (event, options) => {
        publishes++
        expect(event).toEqual(wrap)
        expect(options.exclusiveRelayUrls).toEqual([RECIPIENT_RELAY])
        const auth = options.relayAuthentication!
        expect(auth.expectedPubkey).toBe(fixture.sender)
        expect(auth.signer).toBe(fixture.signer)
        expect(auth.sessionScope).toBe(fixture.signer)
        await auth.waitForSignerVisibility?.()
        await auth.signer.signEvent({
          kind: 22242,
          pubkey: fixture.sender,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", RECIPIENT_RELAY],
            ["challenge", "saved-retry-test"],
          ],
          content: "",
        })
        return acknowledged(RECIPIENT_RELAY)
      }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
      id,
      fixture.store,
      async () => ({
        pubkey: fixture.recipient,
        state: "declared",
        relayUrls: [RECIPIENT_RELAY],
        stale: false,
        fetchedAt: Date.now(),
      }),
      {
        foregroundRelayAuthentication: {
          signer: fixture.signer,
          method: fixture.signer.authMethod,
          waitForSignerVisibility: async () => {
            visibilityEntered()
            await visible
          },
        },
      }
    )
    await entered
    expect(fixture.signCalls()).toBe(signsBeforeRetry)
    resumeVisibility()
    await retry
    expect(publishes).toBe(1)
    expect(fixture.signCalls()).toBe(signsBeforeRetry + 1)
    expect(
      (
        await fixture.database.commerceInboxDeliveries.get(
          fixture.store.key(id)
        )
      )?.state
    ).toBe("accepted")
  })

  it("answers a relay NIP-42 challenge on foreground retry of the saved wrap", async () => {
    const fixture = setup()
    const { id, wrap } = await stageFailedRecipientWrap(fixture)
    __setRelayPublishTestOverrides({
      accountNetworkLocalStateRepository:
        fixture.accountNetworkLocalStateRepository,
    })
    const signsBeforeRetry = fixture.signCalls()
    const originalSocket = Object.getOwnPropertyDescriptor(
      globalThis,
      "WebSocket"
    )
    const frames: unknown[][] = []
    let authEventId: string | null = null
    let sockets = 0
    class ChallengingSocket {
      readyState = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: Event) => void) | null = null
      constructor(readonly url: string) {
        sockets++
        queueMicrotask(() => {
          this.readyState = 1
          this.onopen?.(new Event("open"))
        })
      }
      send(payload: string): void {
        const frame = JSON.parse(payload) as unknown[]
        frames.push(frame)
        if (frame[0] === "AUTH") {
          const event = frame[1] as { id: string }
          authEventId = event.id
          queueMicrotask(() => {
            this.onmessage?.({
              data: JSON.stringify(["OK", event.id, true, ""]),
            } as MessageEvent<string>)
          })
          return
        }
        const event = frame[1] as { id: string }
        queueMicrotask(() => {
          if (!authEventId) {
            this.onmessage?.({
              data: JSON.stringify([
                "OK",
                event.id,
                false,
                "auth-required: sign in",
              ]),
            } as MessageEvent<string>)
            this.onmessage?.({
              data: JSON.stringify(["AUTH", "saved-retry-challenge"]),
            } as MessageEvent<string>)
          } else {
            this.onmessage?.({
              data: JSON.stringify(["OK", event.id, true, ""]),
            } as MessageEvent<string>)
          }
        })
      }
      close(): void {
        this.readyState = 3
        this.onclose?.(new Event("close"))
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: ChallengingSocket,
    })
    try {
      const attempts = await retryPrivateDeliveries(
        fixture.sender,
        undefined,
        id,
        fixture.store,
        async () => ({
          pubkey: fixture.recipient,
          state: "declared",
          relayUrls: [RECIPIENT_RELAY],
          stale: false,
          fetchedAt: Date.now(),
        }),
        {
          foregroundRelayAuthentication: {
            signer: fixture.signer,
            method: fixture.signer.authMethod,
            waitForSignerVisibility: async () => {},
          },
        }
      )
      expect(sockets).toBe(1)
      expect(frames.map((frame) => frame[0])).toEqual([
        "EVENT",
        "AUTH",
        "EVENT",
      ])
      expect(frames[0]?.[1]).toEqual(wrap)
      expect(frames[2]?.[1]).toEqual(wrap)
      expect(frames[1]?.[1]).toMatchObject({
        kind: 22242,
        pubkey: fixture.sender,
        tags: [
          ["relay", RECIPIENT_RELAY],
          ["challenge", "saved-retry-challenge"],
        ],
      })
      expect(fixture.signCalls()).toBe(signsBeforeRetry + 1)
      expect(attempts.get(wrap.id)?.successfulRelayUrls).toEqual([
        RECIPIENT_RELAY,
      ])
    } finally {
      if (originalSocket)
        Object.defineProperty(globalThis, "WebSocket", originalSocket)
      else Reflect.deleteProperty(globalThis, "WebSocket")
    }
  })

  it("rejects mismatched foreground methods before replay and background retry stays prompt-free", async () => {
    const fixture = setup()
    const { id, wrap } = await stageFailedRecipientWrap(fixture)
    const signsBeforeRetry = fixture.signCalls()
    let publishes = 0
    const publisher = (async (event, options) => {
      publishes++
      expect(event).toEqual(wrap)
      expect(options.relayAuthentication).toBeUndefined()
      return acknowledged(RECIPIENT_RELAY)
    }) as NonNullable<PublishPrivateMessageInput["publishFn"]>
    const declaration = async () => ({
      pubkey: fixture.recipient,
      state: "declared" as const,
      relayUrls: [RECIPIENT_RELAY],
      stale: false,
      fetchedAt: Date.now(),
    })
    await expect(
      retryPrivateDeliveries(
        fixture.sender,
        publisher,
        id,
        fixture.store,
        declaration,
        {
          foregroundRelayAuthentication: {
            signer: fixture.signer,
            method: fixture.signer.authMethod === "nip07" ? "nip46" : "nip07",
          },
        }
      )
    ).rejects.toThrow(/active account signer/)
    expect(publishes).toBe(0)
    await retryPrivateDeliveries(
      fixture.sender,
      publisher,
      id,
      fixture.store,
      declaration
    )
    expect(publishes).toBe(1)
    expect(fixture.signCalls()).toBe(signsBeforeRetry)
  })

  it("drops foreground AUTH when the account session revokes during visibility", async () => {
    const fixture = setup()
    const { id } = await stageFailedRecipientWrap(fixture)
    const signsBeforeRetry = fixture.signCalls()
    let publishes = 0
    await expect(
      retryPrivateDeliveries(
        fixture.sender,
        (async (_event, options) => {
          publishes++
          await options.relayAuthentication?.waitForSignerVisibility?.()
          throw new Error("AUTH signer must not run after revocation")
        }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
        id,
        fixture.store,
        async () => ({
          pubkey: fixture.recipient,
          state: "declared",
          relayUrls: [RECIPIENT_RELAY],
          stale: false,
          fetchedAt: Date.now(),
        }),
        {
          foregroundRelayAuthentication: {
            signer: fixture.signer,
            method: fixture.signer.authMethod,
            waitForSignerVisibility: async () => {
              __resetProtectedReadSigner()
            },
          },
        }
      )
    ).rejects.toThrow()
    expect(publishes).toBe(1)
    expect(fixture.signCalls()).toBe(signsBeforeRetry)
  })

  for (const kind of [16, 14, 15] as const) {
    it(`retries kind ${kind} only on the unacknowledged overlap after relay rotation`, async () => {
      const fixture = setup()
      const removed = "wss://removed.inbox.conduit.market"
      const alreadyAccepted = "wss://accepted.inbox.conduit.market"
      const newlyAdded = "wss://added.inbox.conduit.market"
      const savedTargets = [removed, RECIPIENT_RELAY, alreadyAccepted]
      const input = sendInput(fixture, kind)
      input.selfCopy = false
      input.recipientInboxRelays = savedTargets
      input.publishFn = (async () => ({
        ...acknowledged(alreadyAccepted),
        attemptedRelayUrls: savedTargets,
        failedRelayUrls: [removed, RECIPIENT_RELAY],
      })) as NonNullable<PublishPrivateMessageInput["publishFn"]>
      const sent = await publishPrivateMessage(input)
      const signedBytes = JSON.stringify(sent.wrappedToRecipient)
      const signs = fixture.signCalls()
      const id = `delivery:${input.rumor.id}`
      const targets: string[] = []
      await retryPrivateDeliveries(
        fixture.sender,
        (async (event, options) => {
          expect(JSON.stringify(event)).toBe(signedBytes)
          targets.push(...options.exclusiveRelayUrls!)
          return acknowledged(RECIPIENT_RELAY)
        }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
        id,
        fixture.store,
        async () => ({
          pubkey: fixture.recipient,
          state: "declared",
          relayUrls: [RECIPIENT_RELAY, alreadyAccepted, newlyAdded],
          stale: false,
          fetchedAt: Date.now(),
        })
      )
      expect(targets).toEqual([RECIPIENT_RELAY])
      expect(fixture.signCalls()).toBe(signs)
      const row = await fixture.database.commerceInboxDeliveries.get(
        fixture.store.key(id)
      )
      const job = await fixture.store.open<PrivateDeliveryJob>(row!.value, id)
      expect(JSON.stringify(job.legs[0]!.event)).toBe(signedBytes)
      expect(job.legs[0]!.relayUrls).toEqual(savedTargets)
      expect(job.legs[0]!.acknowledged).toEqual([
        alreadyAccepted,
        RECIPIENT_RELAY,
      ])
    })
  }

  it("explicit domain replay republishes accepted exact wraps while resume skips them", async () => {
    const fixture = setup()
    const input = sendInput(fixture, 14)
    input.publishFn = (async (_event, options) =>
      acknowledged(options.exclusiveRelayUrls![0]!)) as NonNullable<
      PublishPrivateMessageInput["publishFn"]
    >
    const published = await publishPrivateMessage(input)
    const signs = fixture.signCalls()
    const publications: string[] = []
    const publisher = (async (event, options) => {
      publications.push(JSON.stringify(event))
      const self = event.id === published.wrappedToSelf?.id
      expect(options.exclusiveRelayUrls).toEqual([
        self ? SELF_RELAY : RECIPIENT_RELAY,
      ])
      return acknowledged(self ? SELF_RELAY : RECIPIENT_RELAY)
    }) as NonNullable<PublishPrivateMessageInput["publishFn"]>
    await retryPrivateDeliveries(
      fixture.sender,
      publisher,
      undefined,
      fixture.store
    )
    expect(publications).toHaveLength(0)
    const replay = {
      rumorId: input.rumor.id,
      senderPubkey: fixture.sender,
      recipientPubkey: fixture.recipient,
      accountPubkey: fixture.sender,
      authenticatedPubkey: fixture.sender,
      wrappedToRecipient: published.wrappedToRecipient,
      wrappedToSelf: published.wrappedToSelf!,
      deliveryStore: fixture.store,
      publishFn: publisher,
      resolveInboxRelays: async (pubkey: string) => [
        pubkey === fixture.sender ? SELF_RELAY : RECIPIENT_RELAY,
      ],
    }
    await retryPrivateMessageWraps(replay)
    expect(publications).toEqual([
      JSON.stringify(published.wrappedToRecipient),
      JSON.stringify(published.wrappedToSelf),
    ])
    expect(fixture.signCalls()).toBe(signs)
    await expect(
      retryPrivateMessageWraps({
        ...replay,
        resolveInboxRelays: async () => [
          "wss://replacement.inbox.conduit.market",
        ],
      })
    ).rejects.toThrow("Exact message replay did not obtain a relay ACK")
    expect(publications).toHaveLength(2)
    await expect(
      retryPrivateMessageWraps({
        ...replay,
        publishFn: (async () => ({
          ...acknowledged(RECIPIENT_RELAY),
          successfulRelayUrls: [],
          failedRelayUrls: [RECIPIENT_RELAY],
        })) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
      })
    ).rejects.toThrow("Exact message replay did not obtain a relay ACK")
    for (const row of await fixture.database.commerceInboxDeliveries.toArray())
      expect(row.state).toBe("accepted")
  })

  it("uses the conversation adapter for an ordinary reply and kind-15 file", async () => {
    const fixture = setup()
    const seenKinds: number[] = []
    const send = async (input: PublishPrivateMessageInput) => {
      const result = await publishPrivateMessage({
        ...input,
        deliveryStore: fixture.store,
        accountNetworkLocalStateRepository:
          fixture.accountNetworkLocalStateRepository,
        recipientInboxRelays: [RECIPIENT_RELAY],
        senderInboxRelays: [SELF_RELAY],
        inspectOwnInboxReadiness: sendInput(fixture, 14)
          .inspectOwnInboxReadiness,
        publishFn: (async (event, options) => {
          if (options.exclusiveRelayUrls?.includes(SELF_RELAY))
            throw new Error("self transport failed")
          expect(options.exclusiveRelayUrls).toEqual([RECIPIENT_RELAY])
          const opened = await unwrapPrivateMessageEnvelope(
            event,
            fixture.recipientSigner
          )
          seenKinds.push(opened.kind)
          return acknowledged(RECIPIENT_RELAY)
        }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
      })
      expect(result.deliveryStatus).toBe("full_success")
      return result
    }
    await sendAccountInboxRumor(
      {
        principal: fixture.sender,
        recipients: [fixture.recipient],
        content: "Ordinary reply",
      },
      { getSigner: () => fixture.signer, send }
    )
    const attachment = buildPrivateFileRumor({
      recipientPubkeys: [fixture.recipient],
      url: "https://files.conduit.market/encrypted",
      mimeType: "image/png",
      envelope: {
        algorithm: "aes-gcm",
        key: "1".repeat(64),
        nonce: "2".repeat(24),
        encryptedSha256: "3".repeat(64),
        originalSha256: "4".repeat(64),
        encryptedSize: 128,
      },
    })
    await sendAccountInboxRumor(
      {
        principal: fixture.sender,
        recipients: [fixture.recipient],
        ...attachment,
      },
      { getSigner: () => fixture.signer, send }
    )
    expect(seenKinds).toEqual([14, 15])
  })

  for (const kind of [14, 15] as const) {
    for (const failure of ["self_wrap", "self_sign", "self_publish"] as const) {
      it(`retains an accepted kind ${kind} sender projection after ${failure} failure`, async () => {
        const fixture = setup(
          failure === "self_sign"
            ? {
                selfSign: async () => {
                  throw new Error("self signing refused")
                },
              }
            : {}
        )
        const wire =
          kind === 15
            ? buildPrivateFileRumor({
                recipientPubkeys: [fixture.recipient],
                url: "https://files.conduit.market/encrypted",
                mimeType: "image/png",
                envelope: {
                  algorithm: "aes-gcm",
                  key: "1".repeat(64),
                  nonce: "2".repeat(24),
                  encryptedSha256: "3".repeat(64),
                  originalSha256: "4".repeat(64),
                  encryptedSize: 128,
                },
              })
            : { kind: 14 as const, tags: [["e", "reply-id"]], content: "Reply" }
        let recipientPublishes = 0
        let selfPublishes = 0
        let publishedRumorId = ""
        const result = await sendAccountInboxRumor(
          {
            principal: fixture.sender,
            recipients: [fixture.recipient],
            ...wire,
          },
          {
            getSigner: () => fixture.signer,
            persistProjection: async (projection) =>
              await fixture.store.putProjection(projection, 1),
            send: async (input) => {
              publishedRumorId = input.rumor.id
              return await publishPrivateMessage({
                ...input,
                deliveryStore: fixture.store,
                accountNetworkLocalStateRepository:
                  fixture.accountNetworkLocalStateRepository,
                recipientInboxRelays: [RECIPIENT_RELAY],
                senderInboxRelays: [SELF_RELAY],
                inspectOwnInboxReadiness: sendInput(fixture, kind)
                  .inspectOwnInboxReadiness,
                giftWrapFn: async (event, recipient, signer, params) => {
                  if (recipient.pubkey === fixture.sender)
                    expect(
                      await fixture.database.commerceInboxRecords.count()
                    ).toBe(1)
                  if (
                    failure === "self_wrap" &&
                    recipient.pubkey === fixture.sender
                  )
                    throw new Error("self wrapping refused")
                  return await wrapPrivateMessage(
                    event,
                    recipient,
                    signer,
                    params
                  )
                },
                publishFn: (async (event, options) => {
                  if (options.exclusiveRelayUrls?.includes(SELF_RELAY)) {
                    selfPublishes++
                    if (failure === "self_publish")
                      throw new Error("self relay unavailable")
                    return acknowledged(SELF_RELAY)
                  }
                  recipientPublishes++
                  const opened = await unwrapPrivateMessageEnvelope(
                    event,
                    fixture.recipientSigner
                  )
                  expect(opened.kind).toBe(kind)
                  return acknowledged(RECIPIENT_RELAY)
                }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
              })
            },
          }
        )
        expect(result).toEqual({
          recipient: "accepted",
          selfCopy: "pending",
          localHistory: "saved",
        })
        expect(recipientPublishes).toBe(1)
        expect(selfPublishes).toBe(failure === "self_publish" ? 1 : 0)
        const stored = await fixture.database.commerceInboxRecords.toArray()
        expect(stored).toHaveLength(1)
        expect(stored[0]?.logicalId).toBe(publishedRumorId)
        expect(JSON.stringify(stored[0])).not.toContain(wire.content)
        const authorization = getProtectedReadAuthorization(fixture.sender)!
        const reopened = new CommerceInbox(
          authorization,
          fixture.signer,
          new CommerceInboxStore(authorization, fixture.database)
        )
        try {
          await reopened.initialize()
          const messages = reopened.getSnapshot().directMessages
          expect(messages).toHaveLength(1)
          expect(messages[0]?.id).toBe(publishedRumorId)
          expect(messages[0]?.recipientPubkey).toBe(fixture.recipient)
          if (kind === 15) {
            expect(messages[0]?.file?.key).toBe("1".repeat(64))
            expect(messages[0]?.content).toBe("Encrypted file")
          } else {
            expect(messages[0]?.content).toBe("Reply")
            expect(messages[0]?.replyTo).toBe("reply-id")
          }
        } finally {
          reopened.stop()
        }
      })
    }

    it(`reports unavailable local history after an accepted kind ${kind} send`, async () => {
      const fixture = setup()
      const wire =
        kind === 15
          ? buildPrivateFileRumor({
              recipientPubkeys: [fixture.recipient],
              url: "https://files.conduit.market/encrypted",
              mimeType: "image/png",
              envelope: {
                algorithm: "aes-gcm",
                key: "1".repeat(64),
                nonce: "2".repeat(24),
                encryptedSha256: "3".repeat(64),
                originalSha256: "4".repeat(64),
                encryptedSize: 128,
              },
            })
          : { kind: 14 as const, tags: [], content: "Reply" }
      let recipientPublishes = 0
      const result = await sendAccountInboxRumor(
        { principal: fixture.sender, recipients: [fixture.recipient], ...wire },
        {
          getSigner: () => fixture.signer,
          persistProjection: async () => {
            throw new Error("device storage unavailable")
          },
          send: async (input) =>
            await publishPrivateMessage({
              ...input,
              deliveryStore: fixture.store,
              accountNetworkLocalStateRepository:
                fixture.accountNetworkLocalStateRepository,
              recipientInboxRelays: [RECIPIENT_RELAY],
              senderInboxRelays: [SELF_RELAY],
              inspectOwnInboxReadiness: sendInput(fixture, kind)
                .inspectOwnInboxReadiness,
              giftWrapFn: async (event, recipient, signer, params) => {
                if (recipient.pubkey === fixture.sender)
                  throw new Error("self wrapping refused")
                return await wrapPrivateMessage(
                  event,
                  recipient,
                  signer,
                  params
                )
              },
              publishFn: (async () => {
                recipientPublishes++
                return acknowledged(RECIPIENT_RELAY)
              }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
            }),
        }
      )
      expect(result).toEqual({
        recipient: "accepted",
        selfCopy: "pending",
        localHistory: "unavailable",
        checkpointFailure: true,
      })
      expect(recipientPublishes).toBe(1)
      expect(await fixture.database.commerceInboxRecords.count()).toBe(0)
    })
  }

  for (const kind of [14, 15] as const) {
    it(`keeps an accepted kind ${kind} send when the ACK checkpoint write fails`, async () => {
      const fixture = setup()
      const wire =
        kind === 15
          ? buildPrivateFileRumor({
              recipientPubkeys: [fixture.recipient],
              url: "https://files.conduit.market/encrypted",
              mimeType: "image/png",
              envelope: {
                algorithm: "aes-gcm",
                key: "1".repeat(64),
                nonce: "2".repeat(24),
                encryptedSha256: "3".repeat(64),
                originalSha256: "4".repeat(64),
                encryptedSize: 128,
              },
            })
          : { kind: 14 as const, tags: [], content: "Reply" }
      fixture.database.commerceInboxDeliveries.hook("updating", (changes) => {
        if (changes.state === "accepted")
          throw new Error("simulated ACK checkpoint write failure")
      })
      let recipientPublishes = 0
      const result = await sendAccountInboxRumor(
        { principal: fixture.sender, recipients: [fixture.recipient], ...wire },
        {
          getSigner: () => fixture.signer,
          persistProjection: async (projection) =>
            await fixture.store.putProjection(projection, 1),
          send: async (input) =>
            await publishPrivateMessage({
              ...input,
              deliveryStore: fixture.store,
              accountNetworkLocalStateRepository:
                fixture.accountNetworkLocalStateRepository,
              recipientInboxRelays: [RECIPIENT_RELAY],
              senderInboxRelays: [SELF_RELAY],
              inspectOwnInboxReadiness: sendInput(fixture, kind)
                .inspectOwnInboxReadiness,
              giftWrapFn: async (event, recipient, signer, params) => {
                if (recipient.pubkey === fixture.sender)
                  throw new Error("self wrapping refused")
                return await wrapPrivateMessage(
                  event,
                  recipient,
                  signer,
                  params
                )
              },
              publishFn: (async (event, options) => {
                expect(options.exclusiveRelayUrls).toEqual([RECIPIENT_RELAY])
                const opened = await unwrapPrivateMessageEnvelope(
                  event,
                  fixture.recipientSigner
                )
                expect(opened.kind).toBe(kind)
                recipientPublishes++
                return acknowledged(RECIPIENT_RELAY)
              }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
            }),
        }
      )
      expect(result).toEqual({
        recipient: "accepted",
        selfCopy: "pending",
        localHistory: "saved",
        checkpointFailure: true,
      })
      expect(recipientPublishes).toBe(1)
      expect(await fixture.database.commerceInboxRecords.count()).toBe(1)
    })
  }

  it("preserves accepted order updates when the delivery checkpoint write fails", async () => {
    const fixture = setup()
    fixture.database.commerceInboxDeliveries.hook("updating", (changes) => {
      if ("state" in changes && changes.state === "accepted")
        throw new Error("simulated order ACK checkpoint failure")
    })
    let checkpointCalls = 0
    let recipientPublishes = 0
    const result = await publishPrivateMessage({
      ...sendInput(fixture, 16),
      selfCopy: false,
      onRecipientAccepted: async () => {
        checkpointCalls++
      },
      publishFn: (async () => {
        recipientPublishes++
        return acknowledged(RECIPIENT_RELAY)
      }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
    })
    expect(result.recipientDelivery.successfulRelayUrls).toEqual([
      RECIPIENT_RELAY,
    ])
    expect(result.checkpointFailure).toBe(true)
    expect(checkpointCalls).toBe(1)
    expect(recipientPublishes).toBe(1)
  })

  it("reports a failed post-ACK callback without revoking recipient acceptance", async () => {
    const fixture = setup()
    const result = await publishPrivateMessage({
      ...sendInput(fixture, 14),
      onRecipientAccepted: async () => {
        throw new Error("local callback failed")
      },
      giftWrapFn: async (event, recipient, signer, params) => {
        if (recipient.pubkey === fixture.sender)
          throw new Error("self wrapping refused")
        return await wrapPrivateMessage(event, recipient, signer, params)
      },
      publishFn: (async () => acknowledged(RECIPIENT_RELAY)) as NonNullable<
        PublishPrivateMessageInput["publishFn"]
      >,
    })
    expect(result.recipientDelivery.successfulRelayUrls).toEqual([
      RECIPIENT_RELAY,
    ])
    expect(result.checkpointFailure).toBe(true)
  })

  it("keeps a zero-ACK conversation send rejected when checkpoint storage fails", async () => {
    const fixture = setup()
    fixture.database.commerceInboxDeliveries.hook("updating", (changes) => {
      if (changes.state === "failed")
        throw new Error("simulated checkpoint write failure")
    })
    await expect(
      publishPrivateMessage({
        ...sendInput(fixture, 14),
        onRecipientAccepted: async () => {},
        publishFn: (async () => ({
          ...acknowledged(RECIPIENT_RELAY),
          successfulRelayUrls: [],
          failedRelayUrls: [RECIPIENT_RELAY],
        })) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
      })
    ).rejects.toThrow()
  })

  it("keeps order checkpoint persistence mandatory without an accepted-result owner", async () => {
    const fixture = setup()
    fixture.database.commerceInboxDeliveries.hook("updating", (changes) => {
      if (changes.state === "accepted")
        throw new Error("simulated ACK checkpoint write failure")
    })
    await expect(
      publishPrivateMessage({
        ...sendInput(fixture, 16),
        publishFn: (async () => acknowledged(RECIPIENT_RELAY)) as NonNullable<
          PublishPrivateMessageInput["publishFn"]
        >,
      })
    ).rejects.toThrow(/simulated ACK checkpoint write failure/)
  })

  it("keeps recipient acceptance when the session guard throws during optional self-copy", async () => {
    const fixture = setup()
    let recipientPublishes = 0
    const result = await sendAccountInboxRumor(
      {
        principal: fixture.sender,
        recipients: [fixture.recipient],
        kind: 14,
        content: "Reply",
      },
      {
        getSigner: () => fixture.signer,
        persistProjection: async (projection) =>
          await fixture.store.putProjection(projection, 1),
        send: async (input) =>
          await publishPrivateMessage({
            ...input,
            deliveryStore: fixture.store,
            accountNetworkLocalStateRepository:
              fixture.accountNetworkLocalStateRepository,
            recipientInboxRelays: [RECIPIENT_RELAY],
            senderInboxRelays: [SELF_RELAY],
            inspectOwnInboxReadiness: sendInput(fixture, 14)
              .inspectOwnInboxReadiness,
            giftWrapFn: async (event, recipient, signer, params) => {
              if (recipient.pubkey === fixture.sender) {
                expect(
                  await fixture.database.commerceInboxRecords.count()
                ).toBe(1)
                __resetProtectedReadSigner()
                throw new Error("session changed")
              }
              return await wrapPrivateMessage(event, recipient, signer, params)
            },
            publishFn: (async (_event, options) => {
              if (options.exclusiveRelayUrls?.includes(SELF_RELAY))
                throw new Error("self publish should not start")
              recipientPublishes++
              return acknowledged(RECIPIENT_RELAY)
            }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
          }),
      }
    )
    expect(result).toEqual({
      recipient: "accepted",
      selfCopy: "pending",
      localHistory: "saved",
    })
    expect(recipientPublishes).toBe(1)
  })

  it("rejects extra conversation participants before signing or publishing", async () => {
    const fixture = setup()
    const third = getPublicKey(generateSecretKey())
    let publishes = 0
    await expect(
      sendAccountInboxRumor(
        {
          principal: fixture.sender,
          recipients: [fixture.recipient, third],
          content: "No group chat",
        },
        {
          getSigner: () => fixture.signer,
          send: (async () => {
            publishes++
          }) as never,
        }
      )
    ).rejects.toThrow("Invalid conversation participants")
    expect(publishes).toBe(0)
    await expect(
      publishPrivateMessage({
        ...sendInput(fixture, 14),
        rumor: createPrivateMessageRumor({
          pubkey: fixture.sender,
          kind: 14,
          created_at: 100,
          tags: [
            ["p", fixture.recipient],
            ["p", third],
          ],
          content: "No group chat",
        }),
        publishFn: (async () => {
          publishes++
          return acknowledged(RECIPIENT_RELAY)
        }) as NonNullable<PublishPrivateMessageInput["publishFn"]>,
      })
    ).rejects.toThrow("one explicit counterparty")
    expect(publishes).toBe(0)
    expect(await fixture.database.commerceInboxDeliveries.count()).toBe(0)
  })
})
