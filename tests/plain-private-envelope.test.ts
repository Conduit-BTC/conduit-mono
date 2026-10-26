import { describe, expect, it, spyOn } from "bun:test"
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
  it("identifies the failing wrapping operation without replacing its error", async () => {
    const sender = provider()
    const recipient = provider()
    const failure = new Error("controlled encryption failure")
    const operations: string[] = []
    sender.signer.encryptNip44 = async function () {
      expect(this === sender.signer).toBe(true)
      sender.calls.push("encrypt")
      throw failure
    }
    const params = {
      rumorKind: 14,
      onOperation: (operation: string) => operations.push(operation),
    }
    await expect(
      wrapPrivateMessage(
        rumor(sender.pubkey, recipient.pubkey),
        recipient,
        sender.signer,
        params
      )
    ).rejects.toBe(failure)
    expect(sender.calls).toEqual(["encrypt"])
    expect(operations).toEqual(["identity", "preparation", "encryption"])
  })

  it("observes the real wrap without changing signer identity or nested clock and method evaluation", async () => {
    const sender = provider()
    const recipient = provider()
    const draft = rumor(sender.pubkey, recipient.pubkey)
    const trace: string[] = []
    sender.signer.getPublicKey = async function () {
      expect(this === sender.signer).toBe(true)
      trace.push("get_public_key")
      return sender.pubkey
    }
    Object.defineProperty(sender.signer, "signEvent", {
      get() {
        trace.push("sign_member")
        return async function (
          this: NostrKeySigner,
          event: Parameters<NostrKeySigner["signEvent"]>[0]
        ) {
          expect(this === sender.signer).toBe(true)
          trace.push("sign")
          return finalizeEvent(event, sender.secret)
        }
      },
    })
    Object.defineProperty(sender.signer, "encryptNip44", {
      get() {
        trace.push("encrypt_member")
        return async function (
          this: NostrKeySigner,
          peer: string,
          value: string
        ) {
          expect(this === sender.signer).toBe(true)
          trace.push("encrypt")
          return v2.encrypt(
            value,
            v2.utils.getConversationKey(sender.secret, peer)
          )
        }
      },
    })
    const clock = spyOn(Date, "now").mockImplementation(() => {
      trace.push("clock")
      return 1_700_000_000_000
    })
    const random = spyOn(Math, "random").mockImplementation(() => {
      trace.push("random")
      return 0.5
    })
    try {
      const wrap = await wrapPrivateMessage(draft, recipient, sender.signer, {
        onOperation: (operation) => {
          trace.push(`operation:${operation}`)
        },
      })
      expect(trace).toEqual([
        "operation:identity",
        "get_public_key",
        "operation:preparation",
        "sign_member",
        "clock",
        "random",
        "encrypt_member",
        "operation:encryption",
        "encrypt",
        "operation:seal_signing",
        "sign",
        "operation:seal_validation",
        "operation:local_wrap",
        "clock",
        "random",
      ])
      expect(verifyEvent(wrap)).toBe(true)
      expect(
        unwrapEvent(wrap, recipient.secret).content === draft.content
      ).toBe(true)
    } finally {
      clock.mockRestore()
      random.mockRestore()
    }
  })

  for (const stage of [
    "identity",
    "preparation",
    "seal_signing",
    "local_wrap",
  ] as const) {
    it(`retains the original failure at the ${stage} wrapping operation`, async () => {
      const sender = provider()
      const recipient = provider()
      const draft = rumor(sender.pubkey, recipient.pubkey)
      const failure = new Error("controlled wrapping operation failure")
      const operations: string[] = []
      if (stage === "identity")
        sender.signer.getPublicKey = async () => {
          throw failure
        }
      if (stage === "preparation")
        Object.defineProperty(draft, "tags", {
          get() {
            throw failure
          },
        })
      if (stage === "seal_signing")
        sender.signer.signEvent = async function () {
          expect(this === sender.signer).toBe(true)
          sender.calls.push("sign")
          throw failure
        }
      const state = { recipientReads: 0 }
      const target = {
        get pubkey() {
          if (stage === "local_wrap" && ++state.recipientReads === 2)
            throw failure
          return recipient.pubkey
        },
      }
      await expect(
        wrapPrivateMessage(draft, target, sender.signer, {
          onOperation: (operation) => {
            operations.push(operation)
          },
        })
      ).rejects.toBe(failure)
      expect(operations.at(-1)).toBe(stage)
      expect(sender.calls).toEqual(
        stage === "identity" || stage === "preparation"
          ? []
          : ["encrypt", "sign"]
      )
    })
  }

  it("reports seal validation without accepting an invalid provider response", async () => {
    const sender = provider()
    const recipient = provider()
    const operations: string[] = []
    sender.signer.signEvent = async () => ({}) as never
    await expect(
      wrapPrivateMessage(
        rumor(sender.pubkey, recipient.pubkey),
        recipient,
        sender.signer,
        {
          onOperation: (operation) => {
            operations.push(operation)
          },
        }
      )
    ).rejects.toMatchObject({ code: "invalid_response" })
    expect(operations.at(-1)).toBe("seal_validation")
    expect(operations.includes("local_wrap")).toBe(false)
  })

  for (const observer of ["throw", "reject", "getter"] as const) {
    for (const failing of [false, true]) {
      it(`does not let a ${observer} observer change wrapping ${failing ? "failure" : "success"}`, async () => {
        const sender = provider()
        const recipient = provider()
        const failure = new Error("controlled provider failure")
        if (failing)
          sender.signer.encryptNip44 = async function () {
            sender.calls.push("encrypt")
            throw failure
          }
        const params = {
          rumorKind: 14,
          onOperation: (): void | Promise<void> => {
            if (observer === "reject")
              return Promise.reject(new Error("controlled observer failure"))
            throw new Error("controlled observer failure")
          },
        }
        if (observer === "getter")
          Object.defineProperty(params, "onOperation", {
            get() {
              throw new Error("controlled observer access failure")
            },
          })
        const result = wrapPrivateMessage(
          rumor(sender.pubkey, recipient.pubkey),
          recipient,
          sender.signer,
          params
        )
        if (failing) {
          await expect(result).rejects.toBe(failure)
          expect(sender.calls).toEqual(["encrypt"])
        } else {
          expect(verifyEvent(await result)).toBe(true)
          expect(sender.calls).toEqual(["encrypt", "sign"])
        }
      })
    }
  }

  it("wraps with the plain provider and is decryptable by the independent library", async () => {
    const sender = provider()
    const recipient = provider()
    const draft = rumor(sender.pubkey, recipient.pubkey)
    const wrap = await wrapPrivateMessage(draft, recipient, sender.signer)
    expect(verifyEvent(wrap)).toBe(true)
    expect(wrap.kind).toBe(1059)
    expect(wrap.pubkey).not.toBe(sender.pubkey)
    expect(sender.calls).toEqual(["encrypt", "sign"])
    const decoded = unwrapEvent(wrap, recipient.secret)
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
    expect(decoded.id).toBe(getEventHash(decoded))
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
