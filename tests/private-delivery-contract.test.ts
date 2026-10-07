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
} from "../packages/core/src/protocol/private-message-primitives"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../packages/core/src/protocol/protected-read-authorization"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"
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
    operationTimeoutMs?: number
  } = {}
) {
  const senderSecret = generateSecretKey()
  const recipientSecret = generateSecretKey()
  const sender = getPublicKey(senderSecret)
  const recipient = getPublicKey(recipientSecret)
  const rawSigner = keySigner(senderSecret)
  let signCalls = 0
  const signer = new SessionSigner(
    {
      ...rawSigner,
      signEvent: async (event) => {
        signCalls++
        return await rawSigner.signEvent(event)
      },
      encryptNip44: async (peer, plaintext) =>
        peer === sender && options.selfEncrypt
          ? await options.selfEncrypt(plaintext)
          : await rawSigner.encryptNip44(peer, plaintext),
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
