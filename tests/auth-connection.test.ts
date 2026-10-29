import { afterEach, describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools"
import { AuthConnection } from "../packages/core/src/protocol/auth-connection"
import type { LocalKeySigner } from "../packages/core/src/protocol/local-key"
import type { NostrKeySigner } from "../packages/core/src/protocol/nostr-event-signer"
import { getAccountSigner } from "../packages/core/src/protocol/session-signer"
import {
  getProtectedReadAuthorization,
  hasProtectedReadAuthority,
} from "../packages/core/src/protocol/protected-read-authorization"

const secret = generateSecretKey()
const pubkey = getPublicKey(secret)
const draft = {
  pubkey,
  kind: 1,
  created_at: 1_700_000_000,
  tags: [],
  content: "synthetic",
}
const connections: AuthConnection[] = []
function connection() {
  const signal = new AbortController()
  const state = {
    current: true,
    authority: true,
    invalidations: 0,
    rollbacks: 0,
  }
  const owner = new AuthConnection(
    () => state.current,
    signal.signal,
    () => {
      state.rollbacks++
    }
  )
  connections.push(owner)
  const provider: NostrKeySigner = {
    pubkey,
    getPublicKey: async () => pubkey,
    signEvent: async (event) => finalizeEvent(event, secret),
    encryptNip44: async () => "synthetic",
    decryptNip44: async () => "synthetic",
    decryptLegacy: async () => "synthetic",
  }
  const local: LocalKeySigner = {
    ...provider,
    reference: { userPubkey: pubkey, localKeyRevision: crypto.randomUUID() },
    commit: async () => {},
    invalidate: () => {
      state.invalidations++
    },
  }
  const install = () => {
    owner.ownLocal(local)
    owner.install(
      local,
      {
        version: 1,
        type: "local",
        ...local.reference,
        authClaim: crypto.randomUUID(),
      },
      {
        getCapabilities: () => ({
          signEvent: true,
          nip44: true,
          nip04Decrypt: true,
        }),
        hasAuthority: () => state.authority,
      }
    )
    return getAccountSigner()!
  }
  return { owner, state, signal, local, install }
}
afterEach(() => connections.splice(0).forEach((owner) => owner.retire()))

describe("auth connection ownership transitions", () => {
  it("revokes published authority and pending/queued operations before provider work settles", async () => {
    const candidate = connection()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    candidate.local.signEvent = async (event) => {
      entered()
      await barrier
      return finalizeEvent(event, secret)
    }
    const signer = candidate.install()
    const grant = getProtectedReadAuthorization(pubkey)!
    const running = signer.signEvent(draft).then(
      () => false,
      () => true
    )
    await started
    const queued = signer.signEvent(draft).then(
      () => false,
      () => true
    )
    candidate.signal.abort()
    expect(getAccountSigner()).toBeUndefined()
    expect(getProtectedReadAuthorization(pubkey)).toBeNull()
    expect(hasProtectedReadAuthority(grant)).toBe(false)
    expect(candidate.state.invalidations).toBe(1)
    expect(candidate.state.rollbacks).toBe(1)
    expect(await running).toBe(true)
    expect(await queued).toBe(true)
    await expect(signer.getPublicKey()).rejects.toMatchObject({
      code: "authority_changed",
    })
    release()
    await Promise.resolve()
    expect(() => candidate.owner.complete()).toThrow()
    expect(getAccountSigner()).toBeUndefined()
  })

  it("fences an epoch change even before explicit retirement", async () => {
    const candidate = connection()
    const signer = candidate.install()
    const grant = getProtectedReadAuthorization(pubkey)!
    candidate.state.current = false
    expect(getProtectedReadAuthorization(pubkey)).toBeNull()
    expect(hasProtectedReadAuthority(grant)).toBe(false)
    await expect(signer.signEvent(draft)).rejects.toMatchObject({
      code: "authority_changed",
    })
    expect(() => candidate.owner.complete()).toThrow()
  })

  it("hands off once and remains usable after attempt completion, but not session revocation", async () => {
    const candidate = connection()
    const provisional = candidate.install()
    const installed = candidate.owner.complete()
    expect(installed).toBe(provisional)
    candidate.state.current = false
    candidate.signal.abort()
    expect(verifyEvent(await installed.signEvent(draft))).toBe(true)
    expect(getProtectedReadAuthorization(pubkey)?.signer).toBe(installed)
    candidate.state.authority = false
    await expect(installed.signEvent(draft)).rejects.toMatchObject({
      code: "authority_changed",
    })
    expect(getProtectedReadAuthorization(pubkey)).toBeNull()
  })

  it("retires a provider that arrives after cancellation without installing it", () => {
    const candidate = connection()
    candidate.signal.abort()
    expect(() => candidate.owner.ownLocal(candidate.local)).toThrow()
    expect(candidate.state.invalidations).toBe(1)
    expect(getAccountSigner()).toBeUndefined()
  })

  it("late cleanup and cancellation cannot revoke a replacement's exact resources", async () => {
    const stale = connection()
    const previous = stale.install()
    stale.signal.abort()
    const replacement = connection()
    replacement.install()
    const current = replacement.owner.complete()
    const grant = getProtectedReadAuthorization(pubkey)!
    stale.owner.retire()
    stale.signal.abort()
    expect(stale.state.rollbacks).toBe(1)
    expect(() => stale.owner.complete()).toThrow()
    expect(getAccountSigner()).toBe(current)
    expect(hasProtectedReadAuthority(grant)).toBe(true)
    expect(verifyEvent(await current.signEvent(draft))).toBe(true)
    await expect(previous.getPublicKey()).rejects.toMatchObject({
      code: "authority_changed",
    })
  })

  it("failed installation retires its provider without exposing authority", () => {
    const candidate = connection()
    Object.defineProperty(candidate.local, "pubkey", { value: "b".repeat(64) })
    expect(() => candidate.install()).toThrow()
    expect(getAccountSigner()).toBeUndefined()
    expect(getProtectedReadAuthorization(pubkey)).toBeNull()
    expect(candidate.state.invalidations).toBe(1)
  })

  it("retirement after handoff revokes the installed signer and read grant synchronously", () => {
    const candidate = connection()
    candidate.install()
    candidate.owner.complete()
    const grant = getProtectedReadAuthorization(pubkey)!
    candidate.owner.retire()
    expect(getAccountSigner()).toBeUndefined()
    expect(hasProtectedReadAuthority(grant)).toBe(false)
    expect(candidate.state.invalidations).toBe(1)
    expect(candidate.state.rollbacks).toBe(0)
  })
})
