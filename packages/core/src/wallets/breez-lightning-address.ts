import { secp256k1 } from "@noble/curves/secp256k1.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"

// Breez SDK/server eb8be531d1bdb9e9d08cdf39e7800fbbded67397:
// lnurl-models/src/signed_message.rs and core/src/lnurl.rs. No wallet is opened here.
export type BreezAddressFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>

export interface BreezAddressSigner {
  getIdentityPublicKey(): Promise<string>
  signDigest(digest: Uint8Array): Promise<Uint8Array>
  assertActive(): void
}

export interface BreezAddressCheckpoint {
  username: string
  attempts: number
  phase: "selected" | "registering"
}

export interface BreezAddressStore {
  read(scope: string): Promise<BreezAddressCheckpoint | null>
  write(scope: string, checkpoint: BreezAddressCheckpoint | null): Promise<void>
}

export type BreezAddressFailure =
  | "unconfigured"
  | "unsupported_network"
  | "locked"
  | "identity_mismatch"
  | "storage_unavailable"
  | "coordination_unavailable"
  | "invalid_configuration"
  | "invalid_api_key"
  | "domain_unavailable"
  | "provider_unavailable"
  | "invalid_response"
  | "registration_pending"
  | "names_exhausted"
  | "name_unavailable"
  | "invalid_username"

export type BreezAddressState =
  | { status: "unavailable"; reason: BreezAddressFailure }
  | { status: "absent" }
  | {
      status: "registered"
      address: string
      username: string
      lnurl: string
      publicLookup: "verified" | "unavailable"
      zapAdvertised: boolean
      // Registration and public lookup are not live/offline settlement evidence.
      receiveEvidence: "unverified"
    }

const MAX_ATTEMPTS = 5
const RESERVED_NAMES = new Set([
  "admin",
  "support",
  "conduit",
  "security",
  "help",
  "www",
  "root",
])
const USERNAME_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/

// Provider/LUD-16 syntax for an existing address, independent of selection policy.
function isBreezUsername(username: string): boolean {
  return (
    username.length >= 1 &&
    username.length <= 64 &&
    USERNAME_PATTERN.test(username)
  )
}

// Conduit's policy for selecting new names. No email tags or protected names.
export function normalizeBreezUsername(value: string): string | null {
  const username = value.trim().toLowerCase()
  return username.length >= 3 &&
    isBreezUsername(username) &&
    !RESERVED_NAMES.has(username)
    ? username
    : null
}

export function generateBreezUsername(
  scope = bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  attempt = 1
): string {
  // Same wallet/domain on another device chooses the same initial candidate.
  // Hash only its public identity scope, never the mnemonic or Nostr account.
  const digest = sha256(
    new TextEncoder().encode(`conduit:breez-name:v1:${scope}:${attempt}`)
  )
  return `wallet-${bytesToHex(digest).slice(0, 20)}`
}

export function breezAddressMessage(input: {
  operation: "recover" | "available" | "register"
  domain: string
  identity: string
  username?: string
  description?: string
  timestamp: number
}): string {
  const base = ["breez-lnurl:v2", input.operation, input.domain]
  if (input.operation === "register") {
    base.push(
      input.username!,
      bytesToHex(sha256(new TextEncoder().encode(input.description!)))
    )
  } else {
    base.push(input.identity)
    if (input.operation === "available") base.push(input.username!)
  }
  return [...base, String(input.timestamp)].join("\n")
}

class AddressError extends Error {
  constructor(
    readonly reason: BreezAddressFailure,
    readonly registrationMayHaveCommitted = false
  ) {
    super("Lightning address setup is unavailable.")
  }
}

export class BreezLightningAddressClient {
  readonly #domain: string
  readonly #apiKey: string
  readonly #signer: BreezAddressSigner
  readonly #store: BreezAddressStore
  readonly #fetch: BreezAddressFetch
  readonly #now: () => number
  readonly #generate: (scope: string, attempt: number) => string
  readonly #runExclusive: <T>(
    scope: string,
    operation: () => Promise<T>
  ) => Promise<T>

  constructor(input: {
    domain: string
    apiKey: string
    signer: BreezAddressSigner
    store: BreezAddressStore
    runExclusive: <T>(scope: string, operation: () => Promise<T>) => Promise<T>
    fetch?: BreezAddressFetch
    now?: () => number
    generateUsername?: (scope: string, attempt: number) => string
  }) {
    this.#domain = input.domain
    this.#apiKey = input.apiKey
    this.#signer = input.signer
    this.#store = input.store
    this.#runExclusive = input.runExclusive
    this.#fetch = input.fetch ?? globalThis.fetch.bind(globalThis)
    this.#now = input.now ?? Date.now
    this.#generate = input.generateUsername ?? generateBreezUsername
  }

  // A read never registers. Every restore uses this endpoint, not a local address cache.
  lookup(): Promise<BreezAddressState> {
    return this.#run(false)
  }
  ensure(username?: string): Promise<BreezAddressState> {
    return this.#run(true, username)
  }

  async #run(
    register: boolean,
    requestedUsername?: string
  ): Promise<BreezAddressState> {
    try {
      if (this.#domain !== "conduit.cash")
        throw new AddressError("invalid_configuration")
      if (!this.#apiKey.trim()) throw new AddressError("unconfigured")
      this.#assertActive()
      const identity = await this.#signer.getIdentityPublicKey()
      if (!/^(02|03)[a-f0-9]{64}$/.test(identity))
        throw new AddressError("identity_mismatch")
      this.#assertActive()
      const scope = bytesToHex(
        sha256(new TextEncoder().encode(`${this.#domain}\0${identity}`))
      )
      return await this.#runExclusive(scope, async () => {
        const existing = await this.#recover(identity)
        if (existing) return this.#present(existing)
        if (!register) return { status: "absent" }
        const selected =
          requestedUsername === undefined
            ? undefined
            : normalizeBreezUsername(requestedUsername)
        if (selected === null) throw new AddressError("invalid_username")
        let checkpoint = await this.#read(scope)
        if (
          checkpoint &&
          (!normalizeBreezUsername(checkpoint.username) ||
            !Number.isInteger(checkpoint.attempts) ||
            checkpoint.attempts < 1 ||
            checkpoint.attempts > MAX_ATTEMPTS ||
            !["selected", "registering"].includes(checkpoint.phase))
        ) {
          throw new AddressError("storage_unavailable")
        }
        if (selected && checkpoint?.username !== selected) {
          if (checkpoint?.phase === "registering")
            throw new AddressError("registration_pending")
          checkpoint = { username: selected, attempts: 1, phase: "selected" }
        }
        for (
          let attempt = checkpoint?.attempts ?? 1;
          attempt <= MAX_ATTEMPTS;
          attempt++
        ) {
          const username =
            checkpoint?.username ?? this.#generate(scope, attempt)
          if (normalizeBreezUsername(username) !== username)
            throw new AddressError("invalid_configuration")
          const pending: BreezAddressCheckpoint = {
            username,
            attempts: attempt,
            phase: checkpoint?.phase ?? "selected",
          }
          await this.#save(scope, pending)
          const available = await this.#request(identity, "available", {
            username,
          })
          if (typeof available?.available !== "boolean")
            throw new AddressError("invalid_response")
          if (!available.available) {
            const recovered = await this.#recover(identity)
            if (recovered) return this.#present(recovered)
            // An earlier request may still be in flight. Never advance its name.
            if (pending.phase === "registering")
              throw new AddressError("registration_pending")
            if (selected) throw new AddressError("name_unavailable")
            if (attempt === MAX_ATTEMPTS)
              throw new AddressError("names_exhausted")
            checkpoint = {
              username: this.#generate(scope, attempt + 1),
              attempts: attempt + 1,
              phase: "selected",
            }
            await this.#save(scope, checkpoint)
            continue
          }
          // Another device may have registered while availability was checked.
          const raced = await this.#recover(identity)
          if (raced) return this.#present(raced)
          await this.#save(scope, { ...pending, phase: "registering" })
          try {
            await this.#request(identity, "register", {
              username,
              description: `Pay to ${username}@${this.#domain}`,
            })
          } catch (error) {
            // Clear only this fresh attempt's uncertainty, before recovery can fail.
            // A definite rejection cannot disprove an earlier ambiguous submission.
            if (
              pending.phase === "selected" &&
              error instanceof AddressError &&
              !error.registrationMayHaveCommitted
            )
              await this.#save(scope, pending)
            // A conflict may be a collision, replay, or another device's success.
            // Resolve identity ownership before making any decision to change name.
            const recovered = await this.#recover(identity)
            if (recovered) return this.#present(recovered)
            if (
              error instanceof AddressError &&
              error.reason === "names_exhausted"
            ) {
              // A retry conflict cannot disprove a prior ambiguous commit.
              if (pending.phase === "registering")
                throw new AddressError("registration_pending")
              if (selected) throw new AddressError("name_unavailable")
              if (attempt === MAX_ATTEMPTS) throw error
              checkpoint = {
                username: this.#generate(scope, attempt + 1),
                attempts: attempt + 1,
                phase: "selected",
              }
              await this.#save(scope, checkpoint)
              continue
            }
            throw error
          }
          const confirmed = await this.#recover(identity)
          if (!confirmed) throw new AddressError("registration_pending")
          return this.#present(confirmed)
        }
        throw new AddressError("names_exhausted")
      })
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof AddressError ? error.reason : "provider_unavailable",
      }
    }
  }

  #assertActive(): void {
    try {
      this.#signer.assertActive()
    } catch {
      throw new AddressError("locked")
    }
  }

  async #read(scope: string): Promise<BreezAddressCheckpoint | null> {
    try {
      return await this.#store.read(scope)
    } catch {
      throw new AddressError("storage_unavailable")
    }
  }
  async #save(scope: string, value: BreezAddressCheckpoint): Promise<void> {
    try {
      await this.#store.write(scope, value)
    } catch {
      throw new AddressError("storage_unavailable")
    }
  }

  async #recover(
    identity: string
  ): Promise<{ username: string; address: string } | null> {
    const result = await this.#request(identity, "recover")
    if (result === null) return null
    const username =
      typeof result.username === "string" && isBreezUsername(result.username)
        ? result.username
        : null
    if (
      !username ||
      result.lightning_address !== `${username}@${this.#domain}` ||
      result.lnurl !== `lnurlp://${this.#domain}/lnurlp/${username}`
    ) {
      throw new AddressError("invalid_response")
    }
    return { username, address: result.lightning_address as string }
  }

  async #request(
    identity: string,
    operation: "recover" | "available" | "register",
    fields: { username?: string; description?: string } = {}
  ): Promise<Record<string, unknown> | null> {
    let registrationMayHaveCommitted = false
    try {
      this.#assertActive()
      const timestamp = Math.floor(this.#now() / 1000)
      if (!Number.isSafeInteger(timestamp) || timestamp < 0)
        throw new AddressError("invalid_configuration")
      const message = breezAddressMessage({
        operation,
        domain: this.#domain,
        identity,
        timestamp,
        ...fields,
      })
      const digest = sha256(new TextEncoder().encode(message))
      const signature = await this.#signer.signDigest(digest)
      this.#assertActive()
      if ((await this.#signer.getIdentityPublicKey()) !== identity)
        throw new AddressError("identity_mismatch")
      try {
        if (
          !secp256k1.verify(signature, digest, hexToBytes(identity), {
            prehash: false,
            format: "der",
          })
        )
          throw new Error()
      } catch {
        throw new AddressError("identity_mismatch")
      }
      this.#assertActive()
      const url = `https://${this.#domain}/lnurlpay/${identity}${operation === "register" ? "" : `/${operation}`}`
      const request: RequestInit = {
        method: "POST",
        headers: {
          // Intentionally public client integration credential; wallet authority
          // comes from the signed Spark identity request, not secrecy of this key.
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...fields,
          signature: bytesToHex(signature),
          timestamp,
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }
      let response: Response
      registrationMayHaveCommitted = operation === "register"
      try {
        response = await this.#fetch(url, request)
      } catch {
        throw new AddressError(
          operation === "register"
            ? "registration_pending"
            : "provider_unavailable"
        )
      }
      // Definite admission/validation rejections cannot commit this submission.
      // Transport timeouts, server errors and unknown conflicts remain uncertain.
      if ([400, 401, 403, 404, 405, 422, 429].includes(response.status))
        registrationMayHaveCommitted = false
      this.#assertActive()
      if (response.status === 401 || response.status === 403) {
        throw new AddressError("invalid_api_key")
      }
      let body: unknown
      try {
        const text = await response.text()
        if (text.length > 16_384) throw new Error()
        body = JSON.parse(text)
      } catch {
        throw new AddressError("invalid_response")
      }
      // Unknown/disallowed domains also return 404. Only the provider's explicit
      // authenticated 'user not found' response is evidence of address absence.
      if (response.status === 404) {
        if (operation === "recover" && body === "user not found") return null
        throw new AddressError("domain_unavailable")
      }
      if (operation === "register" && response.status === 409) {
        if (body === "name already taken" || body === "name is reserved") {
          registrationMayHaveCommitted = false
          throw new AddressError("names_exhausted")
        }
        throw new AddressError("registration_pending")
      }
      if (!response.ok) throw new AddressError("provider_unavailable")
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new AddressError("invalid_response")
      return body as Record<string, unknown>
    } catch (error) {
      throw new AddressError(
        error instanceof AddressError ? error.reason : "provider_unavailable",
        registrationMayHaveCommitted
      )
    }
  }

  async #present(value: {
    username: string
    address: string
  }): Promise<BreezAddressState> {
    const publicEvidence = await verifyBreezPublicLookup(
      value.username,
      this.#fetch
    )
    this.#assertActive()
    return {
      status: "registered",
      ...value,
      lnurl: `https://${this.#domain}/.well-known/lnurlp/${value.username}`,
      publicLookup: publicEvidence.status,
      zapAdvertised: publicEvidence.zapAdvertised,
      receiveEvidence: "unverified",
    }
  }
}

export async function verifyBreezPublicLookup(
  username: string,
  fetcher: BreezAddressFetch = fetch
): Promise<{ status: "verified" | "unavailable"; zapAdvertised: boolean }> {
  try {
    if (!isBreezUsername(username)) throw new Error()
    const response = await fetcher(
      `https://conduit.cash/.well-known/lnurlp/${username}`,
      {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }
    )
    const text = await response.text()
    if (!response.ok || text.length > 16_384) throw new Error()
    const data = JSON.parse(text)
    const callback = new URL(data.callback)
    const metadata: unknown = JSON.parse(data.metadata)
    if (
      data.tag !== "payRequest" ||
      callback.origin !== "https://conduit.cash" ||
      callback.pathname !== `/lnurlp/${username}/invoice` ||
      callback.search ||
      callback.hash ||
      callback.username ||
      callback.password ||
      !Number.isSafeInteger(data.minSendable) ||
      !Number.isSafeInteger(data.maxSendable) ||
      data.minSendable < 1 ||
      data.maxSendable < data.minSendable ||
      !Array.isArray(metadata) ||
      !metadata.some(
        (entry: unknown) =>
          Array.isArray(entry) &&
          entry[0] === "text/identifier" &&
          entry[1] === `${username}@conduit.cash`
      )
    )
      throw new Error()
    return {
      status: "verified",
      zapAdvertised:
        data.allowsNostr === true &&
        typeof data.nostrPubkey === "string" &&
        /^[a-f0-9]{64}$/.test(data.nostrPubkey),
    }
  } catch {
    return { status: "unavailable", zapAdvertised: false }
  }
}
