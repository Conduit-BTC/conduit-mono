import { describe, expect, it } from "bun:test"
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { v2 } from "nostr-tools/nip44"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(
  input: {
    decrypt?: (peer: string, ciphertext: string) => Promise<string>
    timeoutMs?: number
    maxQueuedOperations?: number
    hasAuthority?: () => boolean
  } = {}
) {
  const secret = generateSecretKey()
  const peerSecret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const peer = getPublicKey(peerSecret)
  const calls: string[] = []
  const provider: NostrKeySigner = {
    pubkey,
    getPublicKey: async () => pubkey,
    signEvent: async (draft) => {
      calls.push("sign")
      return finalizeEvent(draft, secret)
    },
    encryptNip44: async (recipient, plaintext) => {
      calls.push("encrypt")
      return v2.encrypt(
        plaintext,
        v2.utils.getConversationKey(secret, recipient)
      )
    },
    decryptNip44: async (sender, ciphertext) => {
      calls.push("decrypt")
      if (input.decrypt) return input.decrypt(sender, ciphertext)
      return v2.decrypt(ciphertext, v2.utils.getConversationKey(secret, sender))
    },
    decryptLegacy: async () => {
      throw new Error("Legacy decryption is outside this fixture")
    },
  }
  const signer = new SessionSigner(provider, {
    expectedPubkey: pubkey,
    revision: "synthetic-revision",
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: input.hasAuthority ?? (() => true),
    operationTimeoutMs: input.timeoutMs,
    maxQueuedOperations: input.maxQueuedOperations,
  })
  const ciphertext = (message: string) =>
    v2.encrypt(message, v2.utils.getConversationKey(peerSecret, pubkey))
  const draft = () => ({
    pubkey,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [] as string[][],
    content: "synthetic",
  })
  return { signer, peer, calls, ciphertext, draft, secret }
}

describe("session signer scheduling", () => {
  it("lets queued signing pass history decrypts and starts each deadline at dispatch", async () => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    let decrypts = 0
    const f = fixture({
      timeoutMs: 150,
      decrypt: async (sender, ciphertext) => {
        if (++decrypts === 1) {
          entered.resolve()
          await gate.promise
        }
        return v2.decrypt(
          ciphertext,
          v2.utils.getConversationKey(f.secret, sender)
        )
      },
    })
    const first = f.signer.decryptNip44(f.peer, f.ciphertext("first"))
    await entered.promise
    const second = f.signer.decryptNip44(f.peer, f.ciphertext("second"))
    const signing = f.signer.signEvent(f.draft())
    await Bun.sleep(100)
    gate.resolve()
    expect(await first).toBe("first")
    expect((await signing).content).toBe("synthetic")
    expect(await second).toBe("second")
    expect(f.calls).toEqual(["decrypt", "sign", "decrypt"])
  })

  it("reserves queue space for signing when history decryption fills its share", async () => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    const f = fixture({
      maxQueuedOperations: 4,
      decrypt: async (sender, ciphertext) => {
        entered.resolve()
        await gate.promise
        return v2.decrypt(
          ciphertext,
          v2.utils.getConversationKey(f.secret, sender)
        )
      },
    })
    const active = f.signer.decryptNip44(f.peer, f.ciphertext("active"))
    await entered.promise
    const queued = [1, 2, 3].map((n) =>
      f.signer.decryptNip44(f.peer, f.ciphertext(String(n)))
    )
    await expect(
      f.signer.decryptNip44(f.peer, f.ciphertext("overflow"))
    ).rejects.toMatchObject({ code: "queue_full" })
    const signing = f.signer.signEvent(f.draft())
    gate.resolve()
    expect(await active).toBe("active")
    expect((await signing).content).toBe("synthetic")
    expect(await Promise.all(queued)).toEqual(["1", "2", "3"])
    expect(f.calls).toEqual([
      "decrypt",
      "sign",
      "decrypt",
      "decrypt",
      "decrypt",
    ])
  })

  it("still dispatches background work during sustained foreground signing", async () => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    let decrypts = 0
    const f = fixture({
      decrypt: async (sender, ciphertext) => {
        if (++decrypts === 1) {
          entered.resolve()
          await gate.promise
        }
        return v2.decrypt(
          ciphertext,
          v2.utils.getConversationKey(f.secret, sender)
        )
      },
    })
    const active = f.signer.decryptNip44(f.peer, f.ciphertext("active"))
    await entered.promise
    const signs = Array.from({ length: 5 }, () => f.signer.signEvent(f.draft()))
    const history = f.signer.decryptNip44(f.peer, f.ciphertext("history"))
    gate.resolve()
    expect(await active).toBe("active")
    expect(await history).toBe("history")
    expect(await Promise.all(signs)).toHaveLength(5)
    expect(f.calls).toEqual([
      "decrypt",
      "sign",
      "sign",
      "sign",
      "sign",
      "decrypt",
      "sign",
    ])
  })

  it("keeps a timed-out noncancelable provider request unavailable until completion", async () => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    const f = fixture({
      timeoutMs: 12,
      decrypt: async (sender, ciphertext) => {
        entered.resolve()
        await gate.promise
        return v2.decrypt(
          ciphertext,
          v2.utils.getConversationKey(f.secret, sender)
        )
      },
    })
    const stale = f.signer
      .decryptNip44(f.peer, f.ciphertext("late"))
      .catch((error: unknown) => error)
    await entered.promise
    const queued = f.signer
      .signEvent(f.draft())
      .catch((error: unknown) => error)
    expect(await stale).toMatchObject({ code: "timeout" })
    expect(await queued).toMatchObject({ code: "provider_unavailable" })
    await expect(f.signer.signEvent(f.draft())).rejects.toMatchObject({
      code: "provider_unavailable",
    })
    expect(f.calls).toEqual(["decrypt"])
    gate.resolve()
    await Bun.sleep(0)
    expect(await f.signer.decryptNip44(f.peer, f.ciphertext("fresh"))).toBe(
      "fresh"
    )
    expect(f.calls).toEqual(["decrypt", "decrypt"])
  })

  it("pauses background work after a refusal until deliberate resume", async () => {
    let attempts = 0
    const f = fixture({
      decrypt: async (sender, ciphertext) => {
        if (++attempts === 1)
          throw { code: 4001, message: "private-provider-detail" }
        return v2.decrypt(
          ciphertext,
          v2.utils.getConversationKey(f.secret, sender)
        )
      },
    })
    const first = f.signer
      .decryptNip44(f.peer, f.ciphertext("one"))
      .catch((error: unknown) => error)
    const queued = f.signer
      .decryptNip44(f.peer, f.ciphertext("two"))
      .catch((error: unknown) => error)
    expect(await first).toMatchObject({
      code: "authorization_denied",
      message: "Nostr signer failed: authorization_denied",
    })
    expect(await queued).toMatchObject({ code: "background_paused" })
    await expect(
      f.signer.decryptNip44(f.peer, f.ciphertext("three"))
    ).rejects.toMatchObject({ code: "background_paused" })
    expect(attempts).toBe(1)
    expect((await f.signer.signEvent(f.draft())).content).toBe("synthetic")
    f.signer.resumeBackgroundOperations()
    expect(await f.signer.decryptNip44(f.peer, f.ciphertext("retry"))).toBe(
      "retry"
    )
    expect(attempts).toBe(2)
  })

  it("fences active and queued decrypts after session revocation", async () => {
    const gate = deferred<void>()
    const entered = deferred<void>()
    let current = true
    const f = fixture({
      hasAuthority: () => current,
      decrypt: async (sender, ciphertext) => {
        entered.resolve()
        await gate.promise
        return v2.decrypt(
          ciphertext,
          v2.utils.getConversationKey(f.secret, sender)
        )
      },
    })
    const active = f.signer
      .decryptNip44(f.peer, f.ciphertext("active"))
      .catch((error: unknown) => error)
    await entered.promise
    const queued = f.signer
      .decryptNip44(f.peer, f.ciphertext("queued"))
      .catch((error: unknown) => error)
    current = false
    f.signer.invalidateLocal()
    expect(await active).toMatchObject({ code: "authority_changed" })
    expect(await queued).toMatchObject({ code: "authority_changed" })
    gate.resolve()
    await Bun.sleep(0)
    expect(f.calls).toEqual(["decrypt"])
    await expect(
      f.signer.decryptNip44(f.peer, f.ciphertext("fresh"))
    ).rejects.toMatchObject({
      code: "authority_changed",
    })
  })
})
