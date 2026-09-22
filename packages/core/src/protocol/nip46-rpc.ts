import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type Event,
  type EventTemplate,
  type Filter,
  type VerifiedEvent,
} from "nostr-tools"
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44"
import type { BunkerPointer } from "nostr-tools/nip46"
import { SimplePool } from "nostr-tools/pool"

import { generateId } from "../utils"

const NIP46_EVENT_KIND = 24133
const RESPONSE_REPLAY_WINDOW_SECONDS = 10

export type Nip46TransportErrorCode =
  "unavailable" | "invalid_response" | "rejected" | "unsupported"

export class Nip46TransportError extends Error {
  constructor(
    readonly code: Nip46TransportErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, { cause: options?.cause })
    this.name = "Nip46TransportError"
  }
}

export interface Nip46RpcRequestOptions {
  signal?: AbortSignal
}

export interface Nip46RpcSubscription {
  onevent: (event: Event) => void
  onclose?: (reasons: { url: string; reason: string }[]) => void
}

export interface Nip46RpcPool {
  subscribe(
    relays: string[],
    filter: Filter,
    params: Nip46RpcSubscription
  ): { close: (reason?: string) => void }
  publish(relays: string[], event: Event): Promise<string>[]
  destroy(): void
}

export interface ConduitNip46SignerOptions {
  pool?: Nip46RpcPool
  now?: () => number
  onauth?: (url: string) => void
}

interface PendingRequest {
  generation: number
  resolve: (result: string | null) => void
  reject: (error: Nip46TransportError) => void
  removeAbortListener: () => void
}

type TransportState = "active" | "unavailable" | "closed"

/**
 * Conduit-owned NIP-46 request lifecycle.
 *
 * nostr-tools still supplies the audited NIP-44/event primitives and relay
 * pool. This class owns request correlation, response validation, cleanup,
 * per-relay subscriptions, and lifecycle fencing so a late response cannot
 * revive an obsolete request or session.
 */
export class ConduitNip46Signer {
  readonly bp: BunkerPointer
  private readonly pool: Nip46RpcPool
  private readonly ownsPool: boolean
  private readonly now: () => number
  private readonly clientPubkey: string
  private readonly conversationKey: Uint8Array
  private readonly subscriptions = new Map<
    string,
    { close: (reason?: string) => void; generation: number }
  >()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly lifecycleListeners = new Set<
    (failure: Nip46TransportError) => void
  >()
  private readonly seenResponseIds = new Set<string>()
  private readonly seenResponseOrder: string[] = []
  private generation = 0
  private state: TransportState = "active"
  private restartingSubscriptions = false
  private responseSince: number

  constructor(
    private readonly clientSecretKey: Uint8Array,
    pointer: BunkerPointer,
    private readonly options: ConduitNip46SignerOptions = {}
  ) {
    this.bp = {
      pubkey: pointer.pubkey,
      relays: [...new Set(pointer.relays)],
      secret: pointer.secret,
    }
    this.pool = options.pool ?? new SimplePool({ enableReconnect: true })
    this.ownsPool = !options.pool
    this.now = options.now ?? Date.now
    this.clientPubkey = getPublicKey(clientSecretKey)
    this.conversationKey = getConversationKey(clientSecretKey, this.bp.pubkey)
    this.responseSince = this.currentReplayCursor()
    try {
      this.startSubscriptions()
    } catch (cause) {
      this.state = "closed"
      this.closeSubscriptions()
      if (this.ownsPool) this.pool.destroy()
      throw cause
    }
  }

  hasPendingRequests(): boolean {
    return this.pending.size > 0
  }

  isTransportAvailable(): boolean {
    return this.state === "active"
  }

  onLifecycleFailure(
    listener: (failure: Nip46TransportError) => void
  ): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  private currentReplayCursor(): number {
    return Math.max(
      0,
      Math.floor(this.now() / 1_000) - RESPONSE_REPLAY_WINDOW_SECONDS
    )
  }

  private startSubscriptions(): void {
    if (this.state === "closed") return
    let subscriptionFailure: unknown = null
    for (const relay of this.bp.relays) {
      if (this.subscriptions.has(relay)) continue
      const subscriptionGeneration = this.generation
      const record: {
        close: (reason?: string) => void
        generation: number
      } = {
        close: (_reason?: string) => undefined,
        generation: subscriptionGeneration,
      }
      this.subscriptions.set(relay, record)
      try {
        const closer = this.pool.subscribe(
          [relay],
          {
            kinds: [NIP46_EVENT_KIND],
            authors: [this.bp.pubkey],
            "#p": [this.clientPubkey],
            since: this.responseSince,
          },
          {
            onevent: (event) => this.handleResponse(event),
            onclose: () =>
              this.handleSubscriptionClose(relay, subscriptionGeneration),
          }
        )
        if (this.subscriptions.get(relay) === record) {
          record.close = closer.close
        } else {
          closer.close("NIP-46 response subscription closed during setup")
        }
      } catch (cause) {
        if (this.subscriptions.get(relay) === record) {
          this.subscriptions.delete(relay)
        }
        subscriptionFailure ??= cause
      }
    }
    if (this.subscriptions.size === 0) {
      throw new Nip46TransportError(
        "unavailable",
        "The remote signer has no usable response subscription.",
        { cause: subscriptionFailure }
      )
    }
  }

  private handleSubscriptionClose(relay: string, generation: number): void {
    if (this.subscriptions.get(relay)?.generation !== generation) return
    this.subscriptions.delete(relay)
    if (
      this.restartingSubscriptions ||
      this.state !== "active" ||
      this.subscriptions.size > 0
    ) {
      return
    }
    this.failTransport(
      new Nip46TransportError(
        "unavailable",
        "Every remote signer response subscription closed."
      )
    )
  }

  private closeSubscriptions(): void {
    this.restartingSubscriptions = true
    try {
      for (const subscription of this.subscriptions.values()) {
        subscription.close("NIP-46 transport lifecycle changed")
      }
      this.subscriptions.clear()
    } finally {
      this.restartingSubscriptions = false
    }
  }

  private rememberResponse(eventId: string): boolean {
    if (this.seenResponseIds.has(eventId)) return false
    this.seenResponseIds.add(eventId)
    this.seenResponseOrder.push(eventId)
    if (this.seenResponseOrder.length > 256) {
      const oldest = this.seenResponseOrder.shift()
      if (oldest) this.seenResponseIds.delete(oldest)
    }
    return true
  }

  private handleResponse(event: Event): void {
    if (this.state !== "active") return
    let signatureIsValid = false
    try {
      signatureIsValid = verifyEvent(event)
    } catch {
      return
    }
    if (
      event.kind !== NIP46_EVENT_KIND ||
      event.pubkey !== this.bp.pubkey ||
      !Array.isArray(event.tags) ||
      !event.tags.some(
        (tag) =>
          Array.isArray(tag) && tag[0] === "p" && tag[1] === this.clientPubkey
      ) ||
      !signatureIsValid ||
      !this.rememberResponse(event.id)
    ) {
      return
    }

    let response: unknown
    try {
      response = JSON.parse(decrypt(event.content, this.conversationKey))
    } catch (cause) {
      this.failTransport(
        new Nip46TransportError(
          "invalid_response",
          "The remote signer returned an unreadable response.",
          { cause }
        )
      )
      return
    }

    if (typeof response !== "object" || response === null) {
      this.failTransport(
        new Nip46TransportError(
          "invalid_response",
          "The remote signer returned a malformed response."
        )
      )
      return
    }

    const record = response as Record<string, unknown>
    const id = record.id
    if (typeof id !== "string" || id.length === 0) {
      this.failTransport(
        new Nip46TransportError(
          "invalid_response",
          "The remote signer response did not identify its request."
        )
      )
      return
    }

    const pending = this.pending.get(id)
    // An authenticated response for a completed generation is late, not a new
    // instruction. Ignore it without touching current requests.
    if (!pending || pending.generation !== this.generation) return

    const hasResult = Object.prototype.hasOwnProperty.call(record, "result")
    const hasError = Object.prototype.hasOwnProperty.call(record, "error")
    if (
      record.result === "auth_url" &&
      hasError &&
      typeof record.error === "string"
    ) {
      this.options.onauth?.(record.error)
      return
    }

    if (hasError && record.error !== null && record.error !== "") {
      if (typeof record.error !== "string") {
        this.failTransport(
          new Nip46TransportError(
            "invalid_response",
            "The remote signer returned a malformed error response."
          )
        )
        return
      }
      const code = /unsupported|unknown method|not implemented/i.test(
        record.error
      )
        ? "unsupported"
        : "rejected"
      this.settleRequest(
        id,
        new Nip46TransportError(
          code,
          code === "unsupported"
            ? "The remote signer does not support this request."
            : "The remote signer rejected the request."
        )
      )
      return
    }

    if (
      !hasResult ||
      (typeof record.result !== "string" && record.result !== null)
    ) {
      this.failTransport(
        new Nip46TransportError(
          "invalid_response",
          "The remote signer returned an invalid result."
        )
      )
      return
    }

    this.settleRequest(id, null, record.result)
  }

  private settleRequest(
    id: string,
    error: Nip46TransportError | null,
    result?: string | null
  ): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.removeAbortListener()
    if (error) pending.reject(error)
    else pending.resolve(result ?? null)
  }

  private rejectPending(error: Nip46TransportError): void {
    for (const id of [...this.pending.keys()]) {
      this.settleRequest(id, error)
    }
  }

  private failTransport(error: Nip46TransportError): void {
    if (this.state !== "active") return
    this.state = "unavailable"
    this.generation += 1
    this.closeSubscriptions()
    this.rejectPending(error)
    for (const listener of this.lifecycleListeners) {
      try {
        listener(error)
      } catch {
        // A consumer cannot replace the first causal transport failure.
      }
    }
  }

  sendRequest(
    method: string,
    params: string[],
    options: Nip46RpcRequestOptions = {}
  ): Promise<string | null> {
    if (this.state !== "active") {
      return Promise.reject(
        new Nip46TransportError(
          "unavailable",
          "The remote signer transport is unavailable."
        )
      )
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new Nip46TransportError(
          "unavailable",
          "The remote signer request was canceled."
        )
      )
    }

    try {
      this.startSubscriptions()
    } catch (cause) {
      const error =
        cause instanceof Nip46TransportError
          ? cause
          : new Nip46TransportError(
              "unavailable",
              "The remote signer response route could not be opened.",
              { cause }
            )
      this.failTransport(error)
      return Promise.reject(error)
    }
    const id = `${this.generation}:${generateId()}`
    const event = finalizeEvent(
      {
        kind: NIP46_EVENT_KIND,
        tags: [["p", this.bp.pubkey]],
        content: encrypt(
          JSON.stringify({ id, method, params }),
          this.conversationKey
        ),
        created_at: Math.floor(this.now() / 1_000),
      },
      this.clientSecretKey
    )

    return new Promise<string | null>((resolve, reject) => {
      const abort = () => {
        this.settleRequest(
          id,
          new Nip46TransportError(
            "unavailable",
            "The remote signer request was canceled."
          )
        )
      }
      options.signal?.addEventListener("abort", abort, { once: true })
      this.pending.set(id, {
        generation: this.generation,
        resolve,
        reject,
        removeAbortListener: () =>
          options.signal?.removeEventListener("abort", abort),
      })

      let publications: Promise<string>[]
      try {
        publications = this.pool.publish(this.bp.relays, event)
      } catch (cause) {
        this.failTransport(
          new Nip46TransportError(
            "unavailable",
            "The remote signer request could not be published.",
            { cause }
          )
        )
        return
      }
      if (publications.length === 0) {
        this.failTransport(
          new Nip46TransportError(
            "unavailable",
            "The remote signer has no usable relay route."
          )
        )
        return
      }
      void Promise.any(publications).catch((cause) => {
        if (!this.pending.has(id)) return
        this.failTransport(
          new Nip46TransportError(
            "unavailable",
            "The remote signer request failed on every relay.",
            { cause }
          )
        )
      })
    })
  }

  /** Restart response subscriptions without replaying any in-flight action. */
  resume(): void {
    if (this.state === "closed") {
      throw new Nip46TransportError(
        "unavailable",
        "The remote signer transport is closed."
      )
    }
    this.generation += 1
    this.rejectPending(
      new Nip46TransportError(
        "unavailable",
        "The remote signer connection changed before the request completed."
      )
    )
    this.closeSubscriptions()
    this.responseSince = this.currentReplayCursor()
    this.state = "active"
    try {
      this.startSubscriptions()
    } catch (cause) {
      const error =
        cause instanceof Nip46TransportError
          ? cause
          : new Nip46TransportError(
              "unavailable",
              "The remote signer response route could not be restored.",
              { cause }
            )
      this.failTransport(error)
      throw error
    }
  }

  async ping(options?: Nip46RpcRequestOptions): Promise<void> {
    const result = await this.sendRequest("ping", [], options)
    if (result !== "pong") {
      throw new Nip46TransportError(
        "invalid_response",
        "The remote signer returned an invalid ping response."
      )
    }
  }

  async getPublicKey(options?: Nip46RpcRequestOptions): Promise<string> {
    const result = await this.sendRequest("get_public_key", [], options)
    if (typeof result !== "string") {
      throw new Nip46TransportError(
        "invalid_response",
        "The remote signer returned an invalid public key response."
      )
    }
    return result
  }

  async signEvent(
    event: EventTemplate,
    options?: Nip46RpcRequestOptions
  ): Promise<VerifiedEvent> {
    const result = await this.sendRequest(
      "sign_event",
      [JSON.stringify(event)],
      options
    )
    if (typeof result !== "string") {
      throw new Nip46TransportError(
        "invalid_response",
        "The remote signer returned an invalid signed event."
      )
    }
    let signed: unknown
    try {
      signed = JSON.parse(result)
    } catch (cause) {
      throw new Nip46TransportError(
        "invalid_response",
        "The remote signer returned a malformed signed event.",
        { cause }
      )
    }
    let valid = false
    try {
      valid = verifyEvent(signed as Event)
    } catch {
      valid = false
    }
    if (!valid) {
      throw new Nip46TransportError(
        "invalid_response",
        "The remote signer returned an invalid signature."
      )
    }
    return signed as VerifiedEvent
  }

  private async requireStringResult(
    method: string,
    params: string[],
    options?: Nip46RpcRequestOptions
  ): Promise<string> {
    const result = await this.sendRequest(method, params, options)
    if (typeof result !== "string") {
      throw new Nip46TransportError(
        "invalid_response",
        "The remote signer returned an invalid encryption response."
      )
    }
    return result
  }

  nip04Encrypt(
    pubkey: string,
    plaintext: string,
    options?: Nip46RpcRequestOptions
  ): Promise<string> {
    return this.requireStringResult(
      "nip04_encrypt",
      [pubkey, plaintext],
      options
    )
  }

  nip04Decrypt(
    pubkey: string,
    ciphertext: string,
    options?: Nip46RpcRequestOptions
  ): Promise<string> {
    return this.requireStringResult(
      "nip04_decrypt",
      [pubkey, ciphertext],
      options
    )
  }

  nip44Encrypt(
    pubkey: string,
    plaintext: string,
    options?: Nip46RpcRequestOptions
  ): Promise<string> {
    return this.requireStringResult(
      "nip44_encrypt",
      [pubkey, plaintext],
      options
    )
  }

  nip44Decrypt(
    pubkey: string,
    ciphertext: string,
    options?: Nip46RpcRequestOptions
  ): Promise<string> {
    return this.requireStringResult(
      "nip44_decrypt",
      [pubkey, ciphertext],
      options
    )
  }

  async logout(options?: Nip46RpcRequestOptions): Promise<void> {
    const result = await this.sendRequest("logout", [], options)
    if (result !== "ack") {
      throw new Nip46TransportError(
        "invalid_response",
        "The remote signer returned an invalid logout response."
      )
    }
    await this.close()
  }

  async close(): Promise<void> {
    if (this.state === "closed") return
    this.state = "closed"
    this.generation += 1
    this.closeSubscriptions()
    this.rejectPending(
      new Nip46TransportError(
        "unavailable",
        "The remote signer transport was closed."
      )
    )
    this.lifecycleListeners.clear()
    if (this.ownsPool) this.pool.destroy()
  }
}
