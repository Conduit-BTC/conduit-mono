import { finalizeEvent, getPublicKey } from "nostr-tools/pure"
import { decode } from "nostr-tools/nip19"
import { v2 } from "nostr-tools/nip44"
import { decrypt } from "nostr-tools/nip04"
import {
  NostrSignerError,
  type NostrKeySigner,
  type SignedNostrEvent,
  type UnsignedNostrEvent,
} from "../nostr-event-signer"
import {
  LocalKeyStorage,
  clearRecord,
  type LocalKeyStorageOptions,
} from "./storage"

export const LOCAL_KEY_CAPABILITIES = Object.freeze({
  signEvent: true,
  nip44: true,
  nip04Decrypt: true,
})

export interface LocalKeyReference {
  readonly userPubkey: string
  readonly localKeyRevision: string
}

export interface LocalKeySignerOptions extends LocalKeyStorageOptions {
  onInvalidated?: (
    reference: LocalKeyReference,
    failure: NostrSignerError
  ) => void
}

/** An opaque, one-use import capability. It cannot return/serialize key bytes. */
export interface LocalKeyImport {
  readonly reference: LocalKeyReference
  persist(
    isCurrent: () => boolean,
    signal?: AbortSignal
  ): Promise<LocalKeySigner>
  dispose(): void
}

/** Consume import text here, before any await; never put it in React state. */
export function prepareLocalKeyImport(
  input: HTMLInputElement,
  options: LocalKeySignerOptions = {}
): LocalKeyImport {
  let secret: Uint8Array | undefined
  let pubkey: string
  // Scope import text separately from the capability's closure. Strings cannot
  // be zeroed; the input is cleared immediately and this binding ends here.
  {
    const encoded = input.value
    input.value = ""
    try {
      if (encoded.trim().length !== 63) throw new Error()
      const decoded = decode(encoded.trim())
      if (decoded.type !== "nsec") throw new Error()
      secret = decoded.data
      pubkey = getPublicKey(secret)
    } catch {
      secret?.fill(0)
      throw new NostrSignerError("invalid_response")
    }
  }
  const storage = new LocalKeyStorage(options)
  const revision = crypto.randomUUID()
  const dispose = () => {
    secret?.fill(0)
    secret = undefined
  }
  return Object.freeze({
    reference: Object.freeze({
      userPubkey: pubkey,
      localKeyRevision: revision,
    }),
    dispose,
    async persist(isCurrent: () => boolean, signal?: AbortSignal) {
      if (!secret) throw new NostrSignerError("disconnected")
      const bytes = secret
      secret = undefined
      try {
        await storage.write(
          { version: 1, revision, secret: bytes },
          isCurrent,
          signal
        )
        const signer = new ContainedLocalKeySigner(
          { userPubkey: pubkey, localKeyRevision: revision },
          storage,
          options.onInvalidated
        )
        if (signal?.aborted || !isCurrent()) {
          signer.invalidate()
          await storage.remove(revision)
          throw new NostrSignerError("authority_changed")
        }
        return signer
      } finally {
        bytes.fill(0)
      }
    },
  })
}

/**
 * Security-critical in-process adapter. Only this area and storage possess the
 * account secret. Same-origin compromise is outside this containment guarantee.
 */
export interface LocalKeySigner extends NostrKeySigner {
  readonly reference: LocalKeyReference
  invalidate(): void
}

class ContainedLocalKeySigner implements LocalKeySigner {
  readonly authMethod = "local" as const
  readonly #reference: LocalKeyReference
  readonly #storage: LocalKeyStorage
  readonly #onInvalidated: LocalKeySignerOptions["onInvalidated"]
  readonly #buffers = new Set<Uint8Array>()
  #generation = 0
  #closed = false

  constructor(
    reference: LocalKeyReference,
    storage: LocalKeyStorage,
    onInvalidated?: LocalKeySignerOptions["onInvalidated"]
  ) {
    this.#reference = Object.freeze({ ...reference })
    this.#storage = storage
    this.#onInvalidated = onInvalidated
  }

  get reference(): LocalKeyReference {
    return this.#reference
  }
  get pubkey(): string {
    this.#assertCurrent(this.#generation)
    return this.#reference.userPubkey
  }

  invalidate(): void {
    this.#closed = true
    this.#generation++
    for (const bytes of this.#buffers) bytes.fill(0)
    this.#buffers.clear()
  }

  async getPublicKey(): Promise<string> {
    return this.#run(() => this.#reference.userPubkey)
  }

  async signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent> {
    if (event.pubkey !== this.pubkey)
      throw new NostrSignerError("authority_changed")
    const draft = { ...event, tags: event.tags.map((tag) => [...tag]) }
    return this.#run((secret) => finalizeEvent(draft, secret))
  }

  encryptNip44(peer: string, plaintext: string): Promise<string> {
    return this.#nip44(peer, (key) => v2.encrypt(plaintext, key))
  }

  decryptNip44(peer: string, ciphertext: string): Promise<string> {
    return this.#nip44(peer, (key) => v2.decrypt(ciphertext, key))
  }

  decryptLegacy(peer: string, ciphertext: string): Promise<string> {
    return this.#run((secret) => decrypt(secret, peer, ciphertext))
  }

  #nip44<T>(peer: string, operation: (key: Uint8Array) => T): Promise<T> {
    return this.#run((secret) => {
      const key = v2.utils.getConversationKey(secret, peer)
      this.#buffers.add(key)
      try {
        return operation(key)
      } finally {
        key.fill(0)
        this.#buffers.delete(key)
      }
    })
  }

  #assertCurrent(generation: number): void {
    if (this.#closed || generation !== this.#generation)
      throw new NostrSignerError("authority_changed")
  }

  async #readCurrent(): Promise<Uint8Array> {
    let record
    try {
      record = await this.#storage.read()
      if (!record) throw new NostrSignerError("disconnected")
      if (
        record.revision !== this.#reference.localKeyRevision ||
        getPublicKey(record.secret) !== this.#reference.userPubkey
      )
        throw new NostrSignerError("authority_changed")
      return record.secret
    } catch (error) {
      clearRecord(record)
      const failure =
        error instanceof NostrSignerError
          ? error
          : new NostrSignerError("unavailable")
      if (!this.#closed) {
        this.invalidate()
        this.#onInvalidated?.(this.#reference, failure)
      }
      throw failure
    }
  }

  async #run<T>(operation: (secret: Uint8Array) => T | Promise<T>): Promise<T> {
    const generation = this.#generation
    let secret: Uint8Array | undefined
    let current: Uint8Array | undefined
    try {
      this.#assertCurrent(generation)
      secret = await this.#readCurrent()
      this.#assertCurrent(generation)
      this.#buffers.add(secret)
      const result = await operation(secret)
      this.#assertCurrent(generation)
      current = await this.#readCurrent()
      this.#assertCurrent(generation)
      return result
    } catch (error) {
      throw error instanceof NostrSignerError
        ? error
        : new NostrSignerError("invalid_response")
    } finally {
      current?.fill(0)
      if (secret) {
        secret.fill(0)
        this.#buffers.delete(secret)
      }
    }
  }
}

export async function restoreLocalKeySigner(
  reference: LocalKeyReference,
  options: LocalKeySignerOptions = {}
): Promise<LocalKeySigner> {
  const signer = new ContainedLocalKeySigner(
    reference,
    new LocalKeyStorage(options),
    options.onInvalidated
  )
  try {
    await signer.getPublicKey()
    return signer
  } catch (error) {
    signer.invalidate()
    throw error
  }
}

export function removeLocalKeyRecord(
  reference: LocalKeyReference,
  options: LocalKeyStorageOptions = {}
): Promise<void> {
  return new LocalKeyStorage(options).remove(reference.localKeyRevision)
}
