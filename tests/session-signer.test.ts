import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools"
import { describe, expect, it } from "bun:test"
import { NDKUser, type NDKSigner, type NostrEvent } from "@nostr-dev-kit/ndk"
import {
  SessionSigner,
  type SessionSignerError,
} from "../packages/core/src/protocol/session-signer"
import {
  AUTH_REVISION_STORAGE_KEY,
  AUTH_STORAGE_KEY,
  readAuthRevision,
  readAuthSession,
  revokeAuthSessionAuthority,
  type AuthSession,
  type AuthStorage,
} from "../packages/core/src/protocol/remote-signer"

const PRIVATE_KEY = generateSecretKey()
const PUBKEY_A = getPublicKey(PRIVATE_KEY)
const PUBKEY_B = "b".repeat(64)

function fakeSigner(
  input: {
    pubkey?: string
    onSign?: () => Promise<string>
    onEncrypt?: () => Promise<string>
  } = {}
): NDKSigner {
  const pubkey = input.pubkey ?? PUBKEY_A
  const user = new NDKUser({ pubkey })
  return {
    pubkey,
    userSync: user,
    blockUntilReady: async () => user,
    user: async () => user,
    sign: input.onSign ?? (async () => finalizeEvent(event(), PRIVATE_KEY).sig),
    encryptionEnabled: async () => ["nip44"],
    encrypt: input.onEncrypt ?? (async () => "ciphertext"),
    decrypt: async () => "plaintext",
    toPayload: () => "test",
  } as NDKSigner
}

function event(pubkey = PUBKEY_A): NostrEvent {
  return {
    pubkey,
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: "hello",
  }
}

function sharedAuthority(): {
  session: AuthSession
  storage: AuthStorage
} {
  const session: AuthSession = {
    version: 1,
    type: "nip07",
    userPubkey: PUBKEY_A,
    authClaim: "account-a-claim",
  }
  const values = new Map<string, string>([
    [AUTH_STORAGE_KEY, JSON.stringify(session)],
    [AUTH_REVISION_STORAGE_KEY, session.authClaim!],
  ])
  return {
    session,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => {
        values.delete(key)
      },
    },
  }
}

describe("session-bound external signer", () => {
  it("rejects a stale auth claim before exposing an event to the signer", async () => {
    let signCalls = 0
    const invalidations: SessionSignerError[] = []
    const signer = new SessionSigner(
      fakeSigner({
        onSign: async () => {
          signCalls += 1
          return "1".repeat(128)
        },
      }),
      {
        expectedPubkey: PUBKEY_A,
        revision: "test-claim",
        authMethod: "nip07",
        getCapabilities: () => ({ signEvent: true, nip44: true, nip04: false }),
        hasAuthority: () => false,
        onInvalidated: (error) => invalidations.push(error),
      }
    )

    await expect(signer.sign(event())).rejects.toMatchObject({
      code: "authority_changed",
    })
    expect(signCalls).toBe(0)
    expect(invalidations.map((error) => error.code)).toEqual([
      "authority_changed",
    ])
  })

  it("fences another tab before and after signer approval", async () => {
    const { session, storage } = sharedAuthority()
    let signCalls = 0
    let resolveSignature: ((signature: string) => void) | undefined
    const hasAuthority = () =>
      readAuthRevision(storage) === session.authClaim &&
      JSON.stringify(readAuthSession(storage)) === JSON.stringify(session)
    const signer = new SessionSigner(
      fakeSigner({
        onSign: () => {
          signCalls += 1
          return new Promise<string>((resolve) => {
            resolveSignature = resolve
          })
        },
      }),
      {
        expectedPubkey: PUBKEY_A,
        revision: "test-claim",
        authMethod: "nip07",
        getCapabilities: () => ({ signEvent: true, nip44: true, nip04: false }),
        hasAuthority,
      }
    )

    const inFlight = signer.sign(event())
    await Bun.sleep(0)
    const revocation = revokeAuthSessionAuthority(session, storage)
    resolveSignature?.("1".repeat(128))

    expect(revocation.freshRevisionPersisted).toBe(true)
    await expect(inFlight).rejects.toMatchObject({ code: "authority_changed" })
    await expect(signer.sign(event())).rejects.toThrow("session was replaced")
    expect(signCalls).toBe(1)
  })

  it("rejects a signature when auth authority changes during approval", async () => {
    let hasAuthority = true
    const signer = new SessionSigner(
      fakeSigner({
        onSign: async () => {
          hasAuthority = false
          return "1".repeat(128)
        },
      }),
      {
        expectedPubkey: PUBKEY_A,
        revision: "test-claim",
        authMethod: "nip07",
        getCapabilities: () => ({ signEvent: true, nip44: true, nip04: false }),
        hasAuthority: () => hasAuthority,
      }
    )

    await expect(signer.sign(event())).rejects.toMatchObject({
      code: "authority_changed",
    })
  })

  it("rejects an event whose declared author differs from the session", async () => {
    let signCalls = 0
    const signer = new SessionSigner(
      fakeSigner({
        onSign: async () => {
          signCalls += 1
          return "1".repeat(128)
        },
      }),
      {
        expectedPubkey: PUBKEY_A,
        revision: "test-claim",
        authMethod: "nip07",
        getCapabilities: () => ({ signEvent: true, nip44: true, nip04: false }),
        hasAuthority: () => true,
      }
    )

    await expect(signer.sign(event(PUBKEY_B))).rejects.toThrow(
      "active signer does not match"
    )
    expect(signCalls).toBe(0)
  })

  it("does not expose encryption plaintext under a stale auth claim", async () => {
    let encryptCalls = 0
    const signer = new SessionSigner(
      fakeSigner({
        onEncrypt: async () => {
          encryptCalls += 1
          return "ciphertext"
        },
      }),
      {
        expectedPubkey: PUBKEY_A,
        revision: "test-claim",
        authMethod: "nip07",
        getCapabilities: () => ({ signEvent: true, nip44: true, nip04: false }),
        hasAuthority: () => false,
      }
    )

    await expect(
      signer.encrypt(new NDKUser({ pubkey: PUBKEY_B }), "private", "nip44")
    ).rejects.toMatchObject({ code: "authority_changed" })
    expect(encryptCalls).toBe(0)
  })

  it("delegates operations while identity and authority remain current", async () => {
    const signer = new SessionSigner(fakeSigner(), {
      expectedPubkey: PUBKEY_A,
      revision: "test-claim",
      authMethod: "nip07",
      getCapabilities: () => ({ signEvent: true, nip44: true, nip04: false }),
      hasAuthority: () => true,
    })

    expect((await signer.user()).pubkey).toBe(PUBKEY_A)
    expect(await signer.sign(event())).toHaveLength(128)
    expect(
      await signer.encrypt(
        new NDKUser({ pubkey: PUBKEY_B }),
        "private",
        "nip44"
      )
    ).toBe("ciphertext")
  })

  it("rejects an in-flight signature after its local session is revoked", async () => {
    let resolveSignature: ((signature: string) => void) | undefined
    const signer = new SessionSigner(
      fakeSigner({
        onSign: () =>
          new Promise<string>((resolve) => {
            resolveSignature = resolve
          }),
      }),
      {
        expectedPubkey: PUBKEY_A,
        revision: "test-claim",
        authMethod: "nip07",
        getCapabilities: () => ({ signEvent: true, nip44: true, nip04: false }),
        hasAuthority: () => true,
      }
    )

    const signing = signer.sign(event())
    await Bun.sleep(0)
    signer.invalidateLocal()
    resolveSignature?.("1".repeat(128))

    await expect(signing).rejects.toMatchObject({ code: "authority_changed" })
  })
})
