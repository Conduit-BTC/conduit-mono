import { describe, expect, it } from "bun:test"
import { NDKEvent } from "@nostr-dev-kit/ndk"
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import { createWrap, unwrapEvent, wrapEvent } from "nostr-tools/nip59"
import {
  wrapPrivateMessage,
  unwrapPrivateMessageEnvelope,
} from "../packages/core/src/protocol/messaging"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"

function provider(secret = generateSecretKey()) {
  const pubkey = getPublicKey(secret)
  const calls: string[] = []
  const signer: NostrKeySigner = {
    pubkey,
    getPublicKey: async () => pubkey,
    signEvent: async (event) => {
      calls.push("sign")
      return finalizeEvent(event, secret)
    },
    encryptNip44: async (peer, value) => {
      calls.push("encrypt")
      return v2.encrypt(value, v2.utils.getConversationKey(secret, peer))
    },
    decryptNip44: async (peer, value) => {
      calls.push("decrypt")
      return v2.decrypt(value, v2.utils.getConversationKey(secret, peer))
    },
    decryptLegacy: async () => {
      throw new Error("Not used by NIP-59")
    },
  }
  return { secret, pubkey, calls, signer }
}

function rumor(pubkey: string, recipient: string) {
  return new NDKEvent(undefined, {
    pubkey,
    kind: 14,
    created_at: 1_700_000_000,
    tags: [["p", recipient]],
    content: "synthetic",
  })
}

describe("plain private envelope contract", () => {
  it("wraps with the plain provider and is decryptable by the independent library", async () => {
    const sender = provider()
    const recipient = provider()
    const draft = rumor(sender.pubkey, recipient.pubkey)
    const wrap = await wrapPrivateMessage(draft, recipient, sender.signer)
    expect(verifyEvent(wrap.rawEvent())).toBe(true)
    expect(wrap.kind).toBe(1059)
    expect(wrap.pubkey).not.toBe(sender.pubkey)
    expect(sender.calls).toEqual(["encrypt", "sign"])
    const decoded = unwrapEvent(wrap.rawEvent(), recipient.secret)
    expect(decoded.content).toBe(draft.content)
    expect(decoded.pubkey).toBe(sender.pubkey)
    expect(decoded.tags).toEqual(draft.tags)
    expect(decoded.id).toBe(getEventHash(decoded))
    expect("sig" in decoded).toBe(false)
  })

  it("unwraps a library envelope through two account-bound NIP-44 operations", async () => {
    const sender = provider()
    const recipient = provider()
    const draft = rumor(sender.pubkey, recipient.pubkey).rawEvent()
    const wrap = wrapEvent(draft, sender.secret, recipient.pubkey)
    const decoded = await unwrapPrivateMessageEnvelope(
      new NDKEvent(undefined, wrap),
      recipient.signer
    )
    expect(decoded.content).toBe(draft.content)
    expect(decoded.pubkey).toBe(sender.pubkey)
    expect(decoded.id).toBe(getEventHash(decoded.rawEvent()))
    expect(recipient.calls).toEqual(["decrypt", "decrypt"])
  })

  it("does not send a different account rumor to the provider", async () => {
    const sender = provider()
    const recipient = provider()
    await expect(
      wrapPrivateMessage(
        rumor(recipient.pubkey, sender.pubkey),
        recipient,
        sender.signer
      )
    ).rejects.toMatchObject({ code: "authority_changed" })
    expect(sender.calls).toEqual([])
  })

  it("rejects outer tampering and another recipient before decryption", async () => {
    const sender = provider()
    const recipient = provider()
    const other = provider()
    const wrap = wrapEvent(
      rumor(sender.pubkey, recipient.pubkey).rawEvent(),
      sender.secret,
      recipient.pubkey
    )
    await expect(
      unwrapPrivateMessageEnvelope(
        new NDKEvent(undefined, { ...wrap, content: wrap.content + "x" }),
        recipient.signer
      )
    ).rejects.toMatchObject({ code: "invalid_response" })
    await expect(
      unwrapPrivateMessageEnvelope(new NDKEvent(undefined, wrap), other.signer)
    ).rejects.toMatchObject({ code: "invalid_response" })
    expect(recipient.calls).toEqual([])
    expect(other.calls).toEqual([])
  })

  it("rejects an invalid seal even inside a valid outer wrap", async () => {
    const sender = provider()
    const recipient = provider()
    const seal = finalizeEvent(
      { kind: 13, created_at: 1_700_000_000, tags: [], content: "synthetic" },
      sender.secret
    )
    const wrap = createWrap({ ...seal, sig: "0".repeat(128) }, recipient.pubkey)
    await expect(
      unwrapPrivateMessageEnvelope(
        new NDKEvent(undefined, wrap),
        recipient.signer
      )
    ).rejects.toMatchObject({ code: "invalid_response" })
    expect(recipient.calls).toEqual(["decrypt"])
  })

  it("rejects signed, mismatched-author and altered-hash rumors inside valid seals", async () => {
    const sender = provider()
    const recipient = provider()
    const draft = rumor(sender.pubkey, recipient.pubkey).rawEvent()
    const plain = { ...draft, id: getEventHash(draft) }
    for (const malformed of [
      { ...plain, sig: "0".repeat(128) },
      { ...plain, sig: "" },
      { ...plain, pubkey: recipient.pubkey },
      { ...plain, id: "0".repeat(64) },
    ]) {
      const content = v2.encrypt(
        JSON.stringify(malformed),
        v2.utils.getConversationKey(sender.secret, recipient.pubkey)
      )
      const seal = finalizeEvent(
        { kind: 13, created_at: 1_700_000_000, tags: [], content },
        sender.secret
      )
      const wrap = createWrap(seal, recipient.pubkey)
      await expect(
        unwrapPrivateMessageEnvelope(
          new NDKEvent(undefined, wrap),
          recipient.signer
        )
      ).rejects.toMatchObject({ code: "invalid_response" })
    }
  })
})
