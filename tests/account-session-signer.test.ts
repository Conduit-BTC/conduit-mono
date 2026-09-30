import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools"
import { NDKUser, type NDKSigner, type NostrEvent } from "@nostr-dev-kit/ndk"
import { SessionSigner } from "../packages/core/src/protocol/session-signer"
import { Nip07SessionSigner } from "../packages/core/src/protocol/nip07-signer"
import { createProtectedReadSessionLifecycle } from "../packages/core/src/protocol/protected-read-session-lifecycle"
import { getProtectedReadAuthorization } from "../packages/core/src/protocol/protected-read-authorization"
import type {
  AccountSignerCapabilities,
  SignedNostrEvent,
  UnsignedNostrEvent,
} from "../packages/core/src/protocol/nostr-event-signer"

const secret = generateSecretKey()
const principal = getPublicKey(secret)
const peer = getPublicKey(generateSecretKey())
const allCapabilities = { signEvent: true, nip44: true, nip04: true }
const template = (): UnsignedNostrEvent => ({
  pubkey: principal,
  kind: 1,
  created_at: 1_700_000_000,
  tags: [["t", "synthetic"]],
  content: "synthetic",
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(
  input: {
    sign?: (draft: NostrEvent) => Promise<string>
    encrypt?: () => Promise<string>
    hasAuthority?: () => boolean
    getCapabilities?: () => AccountSignerCapabilities
    operationTimeoutMs?: number
    onInvalidated?: () => void
    getProviderPubkey?: () => string
  } = {}
) {
  const user = new NDKUser({ pubkey: principal })
  const transport = {
    get pubkey() {
      return input.getProviderPubkey?.() ?? principal
    },
    userSync: user,
    user: async () => user,
    blockUntilReady: async () => user,
    sign: input.sign ?? (async (draft) => finalizeEvent(draft, secret).sig),
    encrypt: input.encrypt ?? (async () => "synthetic-ciphertext"),
    decrypt: async () => "synthetic-plaintext",
    encryptionEnabled: async () => ["nip44", "nip04"],
    toPayload: () => {
      throw new Error("Not serializable")
    },
  } as NDKSigner
  return new SessionSigner(transport, {
    expectedPubkey: principal,
    revision: "synthetic-revision",
    authMethod: "nip07",
    hasAuthority: input.hasAuthority ?? (() => true),
    getCapabilities: input.getCapabilities ?? (() => allCapabilities),
    operationTimeoutMs: input.operationTimeoutMs,
    onInvalidated: input.onInvalidated,
  })
}

describe("shared account session operations", () => {
  it("returns one bound principal/revision and a verified independent plain event", async () => {
    const signer = fixture()
    expect(await signer.getPublicKey()).toBe(principal)
    expect(signer.pubkey).toBe(principal)
    expect(signer.revision).toBe("synthetic-revision")
    const draft = template()
    const signed = await signer.signEvent(draft)
    expect(verifyEvent(signed)).toBe(true)
    expect(signed.constructor).toBe(Object)
    signed.tags[0][1] = "changed-output"
    expect(draft.tags[0][1]).toBe("synthetic")
  })

  it("snapshots caller consent before waiting in the prompt queue", async () => {
    const gate = deferred<string>()
    const entered = deferred<void>()
    const signer = fixture({
      encrypt: () => {
        entered.resolve()
        return gate.promise
      },
    })
    const encryption = signer.encryptNip44(peer, "synthetic")
    await entered.promise
    const draft = template()
    const signing = signer.signEvent(draft)
    draft.content = "changed-caller"
    draft.tags[0][1] = "changed-caller"
    gate.resolve("synthetic-ciphertext")
    await encryption
    const signed = await signing
    expect(signed.content).toBe("synthetic")
    expect(signed.tags).toEqual([["t", "synthetic"]])
    expect(verifyEvent(signed)).toBe(true)
  })

  it("rejects a provider-mutated template even when the new signature is valid", async () => {
    const signer = fixture({
      sign: async (draft) => {
        draft.tags[0][1] = "changed-provider"
        return finalizeEvent(draft, secret).sig
      },
    })
    await expect(signer.signEvent(template())).rejects.toMatchObject({
      code: "invalid_response",
    })
    await expect(signer.signEvent(template())).rejects.toMatchObject({
      code: "authority_changed",
    })
  })

  it("rejects invalid signatures and signatures by another principal", async () => {
    for (const sign of [
      async () => "0".repeat(128),
      async (draft: NostrEvent) =>
        finalizeEvent(draft, generateSecretKey()).sig,
    ]) {
      await expect(
        fixture({ sign }).signEvent(template())
      ).rejects.toMatchObject({ code: "invalid_response" })
    }
  })

  it("rejects malformed and wrong-account templates before provider dispatch", async () => {
    let calls = 0
    const signer = fixture({
      sign: async () => {
        calls++
        return ""
      },
    })
    await expect(
      signer.signEvent({
        ...template(),
        tags: null,
      } as unknown as UnsignedNostrEvent)
    ).rejects.toMatchObject({ code: "invalid_response" })
    await expect(
      signer.signEvent({ ...template(), pubkey: peer })
    ).rejects.toMatchObject({ code: "authority_changed" })
    expect(calls).toBe(0)
  })

  it("serializes signing and encryption through the same prompt slot", async () => {
    const gate = deferred<string>()
    const entered = deferred<void>()
    const calls: string[] = []
    const signer = fixture({
      encrypt: () => {
        calls.push("encrypt")
        entered.resolve()
        return gate.promise
      },
      sign: async (draft) => {
        calls.push("sign")
        return finalizeEvent(draft, secret).sig
      },
    })
    const encryption = signer.encryptNip44(peer, "synthetic")
    await entered.promise
    const signing = signer.signEvent(template())
    await Bun.sleep(0)
    expect(calls).toEqual(["encrypt"])
    gate.resolve("synthetic-ciphertext")
    await Promise.all([encryption, signing])
    expect(calls).toEqual(["encrypt", "sign"])
  })

  it("releases a denied prompt without retrying it or exposing provider error content", async () => {
    let calls = 0
    const signer = fixture({
      sign: async (draft) => {
        if (++calls === 1)
          throw { code: 4001, message: "private-provider-detail" }
        return finalizeEvent(draft, secret).sig
      },
    })
    const failure = await signer
      .signEvent(template())
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "authorization_denied",
      message: "Nostr signer failed: authorization_denied",
    })
    expect(verifyEvent(await signer.signEvent(template()))).toBe(true)
    expect(calls).toBe(2)
  })

  it("rejects missing or newly revoked encryption capability without committing a result", async () => {
    let calls = 0
    let capabilities = { ...allCapabilities, nip44: false }
    const signer = fixture({
      getCapabilities: () => capabilities,
      encrypt: async () => {
        calls++
        capabilities = { ...capabilities, nip44: false }
        return "synthetic-ciphertext"
      },
    })
    await expect(signer.encryptNip44(peer, "synthetic")).rejects.toMatchObject({
      code: "unsupported_operation",
    })
    expect(calls).toBe(0)
    capabilities = { ...capabilities, nip44: true }
    await expect(signer.encryptNip44(peer, "synthetic")).rejects.toMatchObject({
      code: "unsupported_operation",
    })
    expect(calls).toBe(1)
  })

  it("rejects account replacement during encryption and before queued dispatch", async () => {
    let current = true
    let signs = 0
    const gate = deferred<string>()
    const entered = deferred<void>()
    const signer = fixture({
      hasAuthority: () => current,
      encrypt: () => {
        entered.resolve()
        return gate.promise
      },
      sign: async () => {
        signs++
        return ""
      },
    })
    const encryption = signer.encryptNip44(peer, "synthetic")
    await entered.promise
    const signing = signer.signEvent(template())
    current = false
    gate.resolve("synthetic-ciphertext")
    const outcomes = await Promise.allSettled([encryption, signing])
    for (const result of outcomes)
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "authority_changed" },
      })
    expect(signs).toBe(0)
  })

  it("cancels a pending operation immediately and rejects its late response", async () => {
    const gate = deferred<string>()
    const entered = deferred<void>()
    const signer = fixture({
      sign: () => {
        entered.resolve()
        return gate.promise
      },
    })
    const signing = signer.signEvent(template())
    await entered.promise
    signer.invalidateLocal()
    await expect(signing).rejects.toMatchObject({ code: "authority_changed" })
    gate.resolve(finalizeEvent(template(), secret).sig)
    await expect(signer.signEvent(template())).rejects.toMatchObject({
      code: "authority_changed",
    })
  })

  it("bounds a stalled operation, retires queued work, and preserves the timeout reason", async () => {
    let calls = 0
    let invalidations = 0
    const signer = fixture({
      operationTimeoutMs: 10,
      sign: () => {
        calls++
        return new Promise<string>(() => undefined)
      },
      // Production invalidation also invokes local cleanup synchronously.
      onInvalidated: () => {
        invalidations++
        signer.invalidateLocal()
      },
    })
    const outcomes = await Promise.allSettled([
      signer.signEvent(template()),
      signer.signEvent(template()),
    ])
    for (const result of outcomes)
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "timeout" },
      })
    expect(calls).toBe(1)
    expect(invalidations).toBe(1)
  })

  it("preserves causal provider failures when auth cleanup cancels the owner", async () => {
    for (const [code, expected] of [
      ["invalid_response", "invalid_response"],
      ["identity_changed", "authority_changed"],
      ["timeout", "timeout"],
    ]) {
      const signer = fixture({
        sign: async () => {
          const cause = { code }
          signer.invalidateLocal(cause)
          throw cause
        },
      })
      await expect(signer.signEvent(template())).rejects.toMatchObject({
        code: expected,
      })
    }
  })

  it("fences a provider principal changed during approval", async () => {
    let providerPubkey = principal
    const signer = fixture({
      getProviderPubkey: () => providerPubkey,
      sign: async (draft) => {
        providerPubkey = peer
        return finalizeEvent(draft, secret).sig
      },
    })
    await expect(signer.signEvent(template())).rejects.toMatchObject({
      code: "authority_changed",
    })
  })

  it("retains the explicit legacy decrypt lane", async () => {
    expect(await fixture().decryptLegacy(peer, "synthetic-ciphertext")).toBe(
      "synthetic-plaintext"
    )
    await expect(
      fixture({
        getCapabilities: () => ({ ...allCapabilities, nip04: false }),
      }).decryptLegacy(peer, "synthetic-ciphertext")
    ).rejects.toMatchObject({ code: "unsupported_operation" })
  })

  it("uses the same account object for protected-read grant and current-revision fencing", async () => {
    let current = true
    const signer = fixture({ hasAuthority: () => current })
    const lifecycle = createProtectedReadSessionLifecycle()
    lifecycle.activate(signer, principal, () => current)
    try {
      const authorization = getProtectedReadAuthorization(principal)
      expect(authorization?.signer).toBe(signer)
      const signed = await authorization!.signer.signEvent({
        ...template(),
        kind: 22242,
        content: "",
      })
      expect(verifyEvent(signed)).toBe(true)
      current = false
      expect(getProtectedReadAuthorization(principal)).toBeNull()
      await expect(signer.signEvent(template())).rejects.toMatchObject({
        code: "authority_changed",
      })
    } finally {
      lifecycle.deactivate()
    }
  })

  it("does not add identity bridge calls to the NIP-07 signing path", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
    let keyReads = 0
    let signatures = 0
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        nostr: {
          getPublicKey: async () => {
            keyReads++
            return principal
          },
          signEvent: async (
            event: UnsignedNostrEvent
          ): Promise<SignedNostrEvent> => {
            signatures++
            return finalizeEvent(event, secret)
          },
        },
      },
    })
    try {
      const provider = new Nip07SessionSigner()
      await provider.blockUntilReady()
      const signer = new SessionSigner(provider, {
        expectedPubkey: principal,
        revision: "synthetic-revision",
        authMethod: "nip07",
        getCapabilities: () => allCapabilities,
        hasAuthority: () => true,
      })
      await signer.getPublicKey()
      await Promise.all([
        signer.signEvent(template()),
        signer.signEvent(template()),
      ])
      expect(signatures).toBe(2)
      // One connect read and existing before/after identity checks per signing.
      expect(keyReads).toBe(5)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})
