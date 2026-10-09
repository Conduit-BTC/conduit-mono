import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
} from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { createWrap } from "nostr-tools/nip59"
import { unwrapGiftWrap } from "../packages/core/src/protocol/messaging"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"

function fixture(tags: string[][] = [], kind = 14) {
  const sender = generateSecretKey()
  const receiver = generateSecretKey()
  const pubkey = getPublicKey(receiver)
  const draft = {
    kind,
    pubkey: getPublicKey(sender),
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", pubkey],
      ...(kind === 16
        ? [
            ["type", "future-commerce"],
            ["order", "synthetic-order"],
          ]
        : []),
    ],
    content: kind === 16 ? '{"version":99}' : "synthetic conversation",
  }
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: draft.created_at,
      tags,
      content: v2.encrypt(
        JSON.stringify({ ...draft, id: getEventHash(draft) }),
        v2.utils.getConversationKey(sender, pubkey)
      ),
    },
    sender
  )
  const wrapped = structuredClone(createWrap(seal, pubkey))
  const signer: NostrKeySigner = {
    pubkey,
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, receiver),
    encryptNip44: async (peer, value) =>
      v2.encrypt(value, v2.utils.getConversationKey(receiver, peer)),
    decryptNip44: async (peer, value) =>
      v2.decrypt(value, v2.utils.getConversationKey(receiver, peer)),
    decryptLegacy: async () => {
      throw new Error("not used")
    },
  }
  return { wrapped, signer }
}

describe("commerce inbox composed envelope regressions", () => {
  it("opens a genuinely signed client-tagged seal", async () => {
    const { wrapped, signer } = fixture([
      ["client", "Amethyst", "synthetic-client-reference"],
    ])
    const result = await unwrapGiftWrap(wrapped, signer)
    expect(result.status).toBe("ok")
  })

  it("retains a valid current-session decrypt after the UI wait deadline", async () => {
    const { wrapped, signer } = fixture()
    const decrypt = signer.decryptNip44
    signer.decryptNip44 = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return await decrypt(...args)
    }
    const result = await unwrapGiftWrap(wrapped, signer, { timeoutMs: 5 })
    expect(result.status).toBe("ok")
  })

  it("keeps authenticated unsupported commerce visible rather than handled and ignored", async () => {
    const { wrapped, signer } = fixture([], 16)
    const result = await unwrapGiftWrap(wrapped, signer)
    expect(result.status).toBe("external")
  })

  it("rejects routing tags on a seal even when it has a valid signature", async () => {
    const { wrapped, signer } = fixture([
      ["p", getPublicKey(generateSecretKey())],
    ])
    const result = await unwrapGiftWrap(wrapped, signer)
    expect(result.status).toBe("decrypt_failed")
  })
})
