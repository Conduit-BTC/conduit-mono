import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { argon2idAsync } from "@noble/hashes/argon2.js"
import {
  default as NDK,
  NDKEvent,
  type NDKFilter,
  type NDKSigner,
} from "@nostr-dev-kit/ndk"
import { z } from "zod"
import { config } from "../config"
import {
  DEFAULT_SHOPPER_PRICE_PREFERENCE,
  SUPPORTED_SHOPPER_DISPLAY_CURRENCIES,
  type ShopperPricePreference,
} from "../pricing"
import { SHIPPING_COUNTRIES } from "./countries"
import { EVENT_KINDS } from "./kinds"
import {
  fetchEventsFanoutDetailed,
  getEventSourceRelayUrls,
  getNdk,
} from "./ndk"
import { appendConduitClientTag, type ConduitAppId } from "./nip89"
import { getRelayLists } from "./relay-list"
import { planRelayReads } from "./relay-planner"
import {
  publishWithPlanner,
  type PublishWithPlannerResult,
} from "./relay-publish"
import { getCommerceWriteRelayUrls, normalizeRelayUrl } from "./relay-settings"
import { signNdkEventWithTransientNip07Retry } from "./signing-retry"

export const SHOPPER_PRESETS_D_TAG = "conduit/shopper-presets"
export const SHOPPER_PRESETS_FORMAT = "nostr-shopper-presets"
export const SHOPPER_PRESETS_VERSION = 1
export const SHOPPER_PRESETS_KDF = {
  memoryKiB: 19_456,
  iterations: 2,
  parallelism: 1,
  keyLength: 32,
  saltLength: 16,
} as const
export const SHOPPER_PRESETS_NONCE_LENGTH = 24
export const MAX_SHOPPER_PRESETS_PLAINTEXT_BYTES = 8_192
export const MAX_SHOPPER_PRESETS_ENVELOPE_BYTES = 16_384
export const SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS = 16
export const SHOPPER_PRESET_PASSWORD_MAX_BYTES = 1_024
const SHOPPER_PRESETS_MAX_READ_RELAYS = 6
const SHOPPER_PRESETS_CONNECT_TIMEOUT_MS = 2_000
const SHOPPER_PRESETS_FETCH_TIMEOUT_MS = 3_000
const SHOPPER_PRESETS_CONVERGENCE_ATTEMPTS = 3
const SHOPPER_PRESETS_CONVERGENCE_RETRY_MS = 100

export const SHOPPER_PAYMENT_RAILS = [
  "automatic",
  "nwc",
  "webln",
  "manual",
] as const

export type ShopperPaymentRail = (typeof SHOPPER_PAYMENT_RAILS)[number]

const countryCodes = new Set(SHIPPING_COUNTRIES.map(({ code }) => code))
const optionalText = (max: number) => z.string().trim().max(max).optional()

export const shopperShippingPresetSchema = z
  .object({
    recipientName: z.string().trim().min(1).max(100),
    addressLine1: z.string().trim().min(1).max(200),
    addressLine2: optionalText(200),
    city: z.string().trim().min(1).max(100),
    stateOrRegion: optionalText(100),
    postalCode: z.string().trim().min(1).max(32),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .refine((country) => countryCodes.has(country), "Unsupported country"),
    email: optionalText(320),
    phone: optionalText(80),
  })
  .strict()

export type ShopperShippingPreset = z.infer<typeof shopperShippingPresetSchema>

export const shopperPresetsDocumentSchema = z
  .object({
    format: z.literal(SHOPPER_PRESETS_FORMAT),
    version: z.literal(SHOPPER_PRESETS_VERSION),
    updatedAt: z.number().int().positive(),
    enabled: z.boolean(),
    shipping: shopperShippingPresetSchema.optional(),
    payment: z
      .object({ preferredRail: z.enum(SHOPPER_PAYMENT_RAILS) })
      .strict()
      .optional(),
    display: z
      .object({
        currency: z.enum(SUPPORTED_SHOPPER_DISPLAY_CURRENCIES),
        bitcoinUnit: z.enum(["bitcoin", "sats"]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((document, context) => {
    if (document.enabled && !document.shipping) {
      context.addIssue({
        code: "custom",
        path: ["shipping"],
        message: "An active preset requires a shipping address",
      })
    }
    if (
      !document.enabled &&
      (document.shipping || document.payment || document.display)
    ) {
      context.addIssue({
        code: "custom",
        message: "A cleared preset cannot contain shopper data",
      })
    }
  })

export type ShopperPresetsDocument = z.infer<
  typeof shopperPresetsDocumentSchema
>

export type ShopperPresetsValue = {
  shipping: ShopperShippingPreset | null
  preferredRail: ShopperPaymentRail
  display: ShopperPricePreference
}

export const DEFAULT_SHOPPER_PRESETS: ShopperPresetsValue = {
  shipping: null,
  preferredRail: "automatic",
  display: DEFAULT_SHOPPER_PRICE_PREFERENCE,
}

const base64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid base64url value")

export const shopperPresetsEnvelopeSchema = z
  .object({
    format: z.literal(SHOPPER_PRESETS_FORMAT),
    version: z.literal(SHOPPER_PRESETS_VERSION),
    encryption: z
      .object({
        kdf: z.literal("argon2id"),
        parameters: z
          .object({
            memoryKiB: z.literal(SHOPPER_PRESETS_KDF.memoryKiB),
            iterations: z.literal(SHOPPER_PRESETS_KDF.iterations),
            parallelism: z.literal(SHOPPER_PRESETS_KDF.parallelism),
            keyLength: z.literal(SHOPPER_PRESETS_KDF.keyLength),
          })
          .strict(),
        salt: base64UrlSchema,
        cipher: z.literal("xchacha20-poly1305"),
        nonce: base64UrlSchema,
      })
      .strict(),
    ciphertext: base64UrlSchema,
  })
  .strict()

export type ShopperPresetsEnvelope = z.infer<
  typeof shopperPresetsEnvelopeSchema
>

export type ShopperPresetsRevision = { eventId: string; createdAt: number }

export type ShopperPresetsReadResult =
  | {
      state: "found"
      envelope: ShopperPresetsEnvelope
      revision: ShopperPresetsRevision
    }
  | { state: "not_found" }
  | { state: "unavailable"; reason: "relay_read" }
  | {
      state: "unavailable"
      reason: "invalid_envelope"
      revision: ShopperPresetsRevision
    }

export type ShopperPresetsWriteResult = {
  document: ShopperPresetsDocument
  envelope: ShopperPresetsEnvelope
  revision: ShopperPresetsRevision
  publish: PublishWithPlannerResult
}

export type ShopperPresetsProtocolDependencies = {
  ndk?: NDK
  signer?: NDKSigner
  fetchEvents?: typeof fetchEventsFanoutDetailed
  getRelayLists?: typeof getRelayLists
  publishEvent?: typeof publishWithPlanner
  readRelayUrls?: readonly string[]
  now?: () => number
  randomBytes?: (length: number) => Uint8Array
  waitForConvergenceRetry?: () => Promise<void>
}

function normalizePubkey(pubkey: string): string {
  const normalized = pubkey.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Connected shopper identity is invalid.")
  }
  return normalized
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "")
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function secureRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random values are unavailable")
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

export function getShopperPresetPasswordError(password: string): string | null {
  if (Array.from(password).length < SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS) {
    return `Password must contain ${SHOPPER_PRESET_PASSWORD_MIN_CHARACTERS} or more characters.`
  }
  if (!/[0-9]/u.test(password)) {
    return "Password must contain at least one number."
  }
  if (byteLength(password) > SHOPPER_PRESET_PASSWORD_MAX_BYTES) {
    return "Password is too long."
  }
  return null
}

function validatePassword(password: string): Uint8Array {
  const error = getShopperPresetPasswordError(password)
  if (error) throw new Error(error)
  const encoded = new TextEncoder().encode(password)
  return encoded
}

async function deriveShopperPresetsKey(
  password: string,
  salt: Uint8Array
): Promise<Uint8Array> {
  return argon2idAsync(validatePassword(password), salt, {
    m: SHOPPER_PRESETS_KDF.memoryKiB,
    t: SHOPPER_PRESETS_KDF.iterations,
    p: SHOPPER_PRESETS_KDF.parallelism,
    dkLen: SHOPPER_PRESETS_KDF.keyLength,
  })
}

export function parseShopperPresetsEnvelope(
  content: string
): ShopperPresetsEnvelope {
  if (
    byteLength(content) === 0 ||
    byteLength(content) > MAX_SHOPPER_PRESETS_ENVELOPE_BYTES
  ) {
    throw new Error("Invalid shopper preset envelope size")
  }
  const envelope = shopperPresetsEnvelopeSchema.parse(JSON.parse(content))
  const salt = base64UrlToBytes(envelope.encryption.salt)
  const nonce = base64UrlToBytes(envelope.encryption.nonce)
  const ciphertext = base64UrlToBytes(envelope.ciphertext)
  if (bytesToBase64Url(salt) !== envelope.encryption.salt) {
    throw new Error("Invalid shopper preset salt encoding")
  }
  if (bytesToBase64Url(nonce) !== envelope.encryption.nonce) {
    throw new Error("Invalid shopper preset nonce encoding")
  }
  if (bytesToBase64Url(ciphertext) !== envelope.ciphertext) {
    throw new Error("Invalid shopper preset ciphertext encoding")
  }
  if (salt.length !== SHOPPER_PRESETS_KDF.saltLength) {
    throw new Error("Invalid shopper preset salt length")
  }
  if (nonce.length !== SHOPPER_PRESETS_NONCE_LENGTH) {
    throw new Error("Invalid shopper preset nonce length")
  }
  if (ciphertext.length < 16)
    throw new Error("Invalid shopper preset ciphertext")
  return envelope
}

export function serializeShopperPresetsEnvelope(
  envelope: ShopperPresetsEnvelope
): string {
  const parsed = shopperPresetsEnvelopeSchema.parse(envelope)
  return JSON.stringify(parsed)
}

export function parseShopperPresetsPlaintext(
  plaintext: string
): ShopperPresetsDocument {
  if (
    byteLength(plaintext) === 0 ||
    byteLength(plaintext) > MAX_SHOPPER_PRESETS_PLAINTEXT_BYTES
  ) {
    throw new Error("Invalid shopper preset document size")
  }
  return shopperPresetsDocumentSchema.parse(JSON.parse(plaintext))
}

export function getShopperPresetsValue(
  document: ShopperPresetsDocument
): ShopperPresetsValue {
  if (!document.enabled) return DEFAULT_SHOPPER_PRESETS
  return {
    shipping: document.shipping ?? null,
    preferredRail: document.payment?.preferredRail ?? "automatic",
    display: document.display ?? DEFAULT_SHOPPER_PRICE_PREFERENCE,
  }
}

export function getShopperDiscoveryDestination(
  value: ShopperPresetsValue
): { country: string; postalCode: string } | null {
  return value.shipping
    ? { country: value.shipping.country, postalCode: value.shipping.postalCode }
    : null
}

export function buildShopperPresetsDocument({
  value,
  updatedAt,
}: {
  value: ShopperPresetsValue | null
  updatedAt: number
}): ShopperPresetsDocument {
  return shopperPresetsDocumentSchema.parse(
    value
      ? {
          format: SHOPPER_PRESETS_FORMAT,
          version: SHOPPER_PRESETS_VERSION,
          updatedAt,
          enabled: true,
          shipping: value.shipping,
          payment: { preferredRail: value.preferredRail },
          display: value.display,
        }
      : {
          format: SHOPPER_PRESETS_FORMAT,
          version: SHOPPER_PRESETS_VERSION,
          updatedAt,
          enabled: false,
        }
  )
}

export async function encryptShopperPresetsDocument(
  document: ShopperPresetsDocument,
  password: string,
  randomBytes: (length: number) => Uint8Array = secureRandomBytes
): Promise<ShopperPresetsEnvelope> {
  const plaintext = JSON.stringify(shopperPresetsDocumentSchema.parse(document))
  if (byteLength(plaintext) > MAX_SHOPPER_PRESETS_PLAINTEXT_BYTES) {
    throw new Error("Shopper preset document is too large")
  }
  const salt = randomBytes(SHOPPER_PRESETS_KDF.saltLength)
  const nonce = randomBytes(SHOPPER_PRESETS_NONCE_LENGTH)
  const key = await deriveShopperPresetsKey(password, salt)
  try {
    const ciphertext = xchacha20poly1305(key, nonce).encrypt(
      new TextEncoder().encode(plaintext)
    )
    return {
      format: SHOPPER_PRESETS_FORMAT,
      version: SHOPPER_PRESETS_VERSION,
      encryption: {
        kdf: "argon2id",
        parameters: {
          memoryKiB: SHOPPER_PRESETS_KDF.memoryKiB,
          iterations: SHOPPER_PRESETS_KDF.iterations,
          parallelism: SHOPPER_PRESETS_KDF.parallelism,
          keyLength: SHOPPER_PRESETS_KDF.keyLength,
        },
        salt: bytesToBase64Url(salt),
        cipher: "xchacha20-poly1305",
        nonce: bytesToBase64Url(nonce),
      },
      ciphertext: bytesToBase64Url(ciphertext),
    }
  } finally {
    key.fill(0)
  }
}

export async function decryptShopperPresetsDocument(
  input: ShopperPresetsEnvelope | string,
  password: string
): Promise<ShopperPresetsDocument> {
  const envelope = parseShopperPresetsEnvelope(
    typeof input === "string" ? input : serializeShopperPresetsEnvelope(input)
  )
  const salt = base64UrlToBytes(envelope.encryption.salt)
  const nonce = base64UrlToBytes(envelope.encryption.nonce)
  const ciphertext = base64UrlToBytes(envelope.ciphertext)
  const key = await deriveShopperPresetsKey(password, salt)
  try {
    const plaintext = xchacha20poly1305(key, nonce).decrypt(ciphertext)
    return parseShopperPresetsPlaintext(new TextDecoder().decode(plaintext))
  } finally {
    key.fill(0)
  }
}

function getDTag(event: Pick<NDKEvent, "tags">): string | null {
  return event.tags.find((tag) => tag[0] === "d")?.[1] ?? null
}

export function selectLatestShopperPresetsEvent<
  T extends Pick<NDKEvent, "id" | "kind" | "pubkey" | "created_at" | "tags">,
>(events: readonly T[], pubkey: string): T | null {
  const owner = normalizePubkey(pubkey)
  return (
    events
      .filter(
        (event) =>
          event.kind === EVENT_KINDS.APPLICATION_DATA &&
          event.pubkey.toLowerCase() === owner &&
          getDTag(event) === SHOPPER_PRESETS_D_TAG
      )
      .sort((left, right) => {
        const timestamp = (right.created_at ?? 0) - (left.created_at ?? 0)
        return timestamp !== 0 ? timestamp : left.id.localeCompare(right.id)
      })[0] ?? null
  )
}

async function requireMatchingSigner(
  pubkey: string,
  signer: NDKSigner
): Promise<void> {
  const user = await signer.user()
  if (user.pubkey.toLowerCase() !== normalizePubkey(pubkey)) {
    throw new Error("The active signer does not match the shopper identity.")
  }
}

export async function fetchShopperPresets(
  pubkey: string,
  dependencies: ShopperPresetsProtocolDependencies = {}
): Promise<ShopperPresetsReadResult> {
  const owner = normalizePubkey(pubkey)
  const resolveRelayLists = dependencies.getRelayLists ?? getRelayLists
  const relayListDiscoveryUrls = Array.from(
    new Set([
      ...config.appWriteRelayUrls,
      ...config.corePublicFallbackRelayUrls,
    ])
  ).slice(0, SHOPPER_PRESETS_MAX_READ_RELAYS)
  const relayLists = await resolveRelayLists([owner], {
    cacheOnly: false,
    relayUrls: relayListDiscoveryUrls,
    allowInsecureRelayUrlsForPubkey: owner,
  })
  const plan = planRelayReads({
    intent: "general",
    authors: [owner],
    relayLists,
    authenticatedPubkey: owner,
    maxRelays: 12,
  })
  const relayUrls = dependencies.readRelayUrls
    ? Array.from(new Set(dependencies.readRelayUrls))
    : Array.from(
        new Set([
          ...config.appWriteRelayUrls,
          ...plan.hintRelayUrls,
          ...getCommerceWriteRelayUrls(),
          ...plan.relayUrls,
          ...config.corePublicFallbackRelayUrls,
        ])
      ).slice(0, SHOPPER_PRESETS_MAX_READ_RELAYS)
  if (relayUrls.length === 0)
    return { state: "unavailable", reason: "relay_read" }

  const filter: NDKFilter = {
    kinds: [EVENT_KINDS.APPLICATION_DATA],
    authors: [owner],
    "#d": [SHOPPER_PRESETS_D_TAG],
    limit: 12,
  }
  const fetchEvents = dependencies.fetchEvents ?? fetchEventsFanoutDetailed
  let result: Awaited<ReturnType<typeof fetchEventsFanoutDetailed>>
  try {
    result = await fetchEvents(filter, {
      relayUrls,
      connectTimeoutMs: SHOPPER_PRESETS_CONNECT_TIMEOUT_MS,
      fetchTimeoutMs: SHOPPER_PRESETS_FETCH_TIMEOUT_MS,
    })
  } catch {
    return { state: "unavailable", reason: "relay_read" }
  }
  const hasRelaySuccess =
    result.relays.some(({ status }) => status === "success") ||
    result.events.length > 0
  const latest = selectLatestShopperPresetsEvent(result.events, owner)
  if (!latest) {
    return hasRelaySuccess
      ? { state: "not_found" }
      : { state: "unavailable", reason: "relay_read" }
  }
  try {
    return {
      state: "found",
      envelope: parseShopperPresetsEnvelope(latest.content),
      revision: {
        eventId: latest.id,
        createdAt: latest.created_at ?? 0,
      },
    }
  } catch {
    return {
      state: "unavailable",
      reason: "invalid_envelope",
      revision: {
        eventId: latest.id,
        createdAt: latest.created_at ?? 0,
      },
    }
  }
}

async function verifyShopperPresetsConvergence({
  owner,
  eventId,
  createdAt,
  relayUrls,
  fetchEvents,
  waitForRetry,
}: {
  owner: string
  eventId: string
  createdAt: number
  relayUrls: readonly string[]
  fetchEvents: typeof fetchEventsFanoutDetailed
  waitForRetry: () => Promise<void>
}): Promise<Extract<ShopperPresetsReadResult, { state: "found" }> | null> {
  const targets = Array.from(
    new Set(relayUrls.map((relayUrl) => normalizeRelayUrl(relayUrl)))
  )
  if (targets.length === 0) return null

  for (
    let attempt = 0;
    attempt < SHOPPER_PRESETS_CONVERGENCE_ATTEMPTS;
    attempt += 1
  ) {
    let result: Awaited<ReturnType<typeof fetchEventsFanoutDetailed>>
    try {
      result = await fetchEvents(
        {
          kinds: [EVENT_KINDS.APPLICATION_DATA],
          authors: [owner],
          "#d": [SHOPPER_PRESETS_D_TAG],
          limit: 12,
        },
        {
          relayUrls: targets,
          connectTimeoutMs: SHOPPER_PRESETS_CONNECT_TIMEOUT_MS,
          fetchTimeoutMs: SHOPPER_PRESETS_FETCH_TIMEOUT_MS,
        }
      )
    } catch {
      if (attempt < SHOPPER_PRESETS_CONVERGENCE_ATTEMPTS - 1) {
        await waitForRetry()
      }
      continue
    }

    const latest = selectLatestShopperPresetsEvent(result.events, owner)
    if (latest) {
      if (latest.id !== eventId) {
        if ((latest.created_at ?? 0) >= createdAt) return null
      } else {
        try {
          const envelope = parseShopperPresetsEnvelope(latest.content)
          const sourceRelayUrls = new Set(
            getEventSourceRelayUrls(latest).map((relayUrl) =>
              normalizeRelayUrl(relayUrl)
            )
          )
          const completedTargets = new Set(
            result.relays
              .filter(
                ({ status }) => status === "success" || status === "partial"
              )
              .map(({ relayUrl }) => normalizeRelayUrl(relayUrl))
          )
          if (
            targets.some(
              (relayUrl) =>
                completedTargets.has(relayUrl) && sourceRelayUrls.has(relayUrl)
            )
          ) {
            return {
              state: "found",
              envelope,
              revision: {
                eventId: latest.id,
                createdAt: latest.created_at ?? 0,
              },
            }
          }
        } catch {
          return null
        }
      }
    }

    if (attempt < SHOPPER_PRESETS_CONVERGENCE_ATTEMPTS - 1) {
      await waitForRetry()
    }
  }

  return null
}

function getAcceptedRevisionTimestampFloor(
  acceptedRevision: ShopperPresetsRevision | null | undefined
): number {
  if (!acceptedRevision) return 0
  if (
    !Number.isSafeInteger(acceptedRevision.createdAt) ||
    acceptedRevision.createdAt < 0 ||
    acceptedRevision.createdAt === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("The accepted shopper preset revision is invalid.")
  }
  return acceptedRevision.createdAt
}

export async function publishShopperPresets({
  pubkey,
  value,
  password,
  appId,
  acceptedRevision,
  dependencies = {},
}: {
  pubkey: string
  value: ShopperPresetsValue | null
  password: string
  appId: ConduitAppId
  acceptedRevision?: ShopperPresetsRevision | null
  dependencies?: ShopperPresetsProtocolDependencies
}): Promise<ShopperPresetsWriteResult> {
  const owner = normalizePubkey(pubkey)
  const ndk = dependencies.ndk ?? getNdk()
  const signer = dependencies.signer ?? ndk.signer
  if (!signer) {
    throw new Error("Connect a signer before syncing shopper presets.")
  }

  const current = await fetchShopperPresets(owner, { ...dependencies, ndk })
  if (current.state === "unavailable") {
    throw new Error(
      "A complete fresh preset read is required before publishing."
    )
  }

  const now = Math.floor((dependencies.now?.() ?? Date.now()) / 1_000)
  const previousCreatedAt =
    current.state === "found" ? current.revision.createdAt : 0
  const acceptedCreatedAt = getAcceptedRevisionTimestampFloor(acceptedRevision)
  const createdAt = Math.max(now, previousCreatedAt + 1, acceptedCreatedAt + 1)
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    createdAt >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("The shopper preset revision timestamp is invalid.")
  }
  const document = buildShopperPresetsDocument({ value, updatedAt: createdAt })
  const envelope = await encryptShopperPresetsDocument(
    document,
    password,
    dependencies.randomBytes
  )
  const event = new NDKEvent(ndk)
  event.kind = EVENT_KINDS.APPLICATION_DATA
  event.pubkey = owner
  event.created_at = createdAt
  event.tags = appendConduitClientTag([["d", SHOPPER_PRESETS_D_TAG]], appId)
  event.content = serializeShopperPresetsEnvelope(envelope)
  await requireMatchingSigner(owner, signer)
  await signNdkEventWithTransientNip07Retry(event, signer)

  const publishEvent = dependencies.publishEvent ?? publishWithPlanner
  const publish = await publishEvent(event, {
    intent: "author_event",
    authorPubkey: owner,
    authenticatedPubkey: owner,
    refreshRelayLists: false,
    deliveryMode: "standard",
  })

  const convergence = await verifyShopperPresetsConvergence({
    owner,
    eventId: event.id,
    createdAt,
    relayUrls: publish.successfulRelayUrls,
    fetchEvents: dependencies.fetchEvents ?? fetchEventsFanoutDetailed,
    waitForRetry:
      dependencies.waitForConvergenceRetry ??
      (() =>
        new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, SHOPPER_PRESETS_CONVERGENCE_RETRY_MS)
        })),
  })
  if (!convergence) {
    throw new Error(
      "The published shopper preset did not converge on relay storage."
    )
  }

  return {
    document,
    envelope: convergence.envelope,
    revision: convergence.revision,
    publish,
  }
}
