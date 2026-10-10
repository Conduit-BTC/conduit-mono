import {
  isValidSparkMnemonic,
  normalizeSparkMnemonic,
  isValidSparkAccountNumber,
} from "./spark-recovery"
export {
  generateSparkMnemonic,
  isValidSparkMnemonic,
  normalizeSparkMnemonic,
  isValidSparkAccountNumber,
} from "./spark-recovery"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { z } from "zod"
import { generateId } from "../utils"
import {
  NostrSignerError,
  type AccountSigner,
  type SignedNostrEvent,
} from "../protocol/nostr-event-signer"
import { isValidSignedPublicNostrEvent } from "../protocol/signed-event"

export const SPARK_RECOVERY_KIND = 30078
export const SPARK_RECOVERY_PREFIX = "conduit:spark:wallet:v1:"
export const SPARK_PRIMARY_D_TAG = "conduit:spark:primary:v1"
export const MAX_SPARK_ACCOUNT_NUMBER = 0x7fffffff
export const MAX_SPARK_RECOVERY_BYTES = 2048
const MAX_CIPHERTEXT_CHARS = 4096
const opaqueId = z.uuid()
const pubkey = z.string().regex(/^[0-9a-f]{64}$/)
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const network = z.enum(["mainnet", "testnet", "signet", "regtest"])
const accountNumber = z.number().int().min(0).max(MAX_SPARK_ACCOUNT_NUMBER)

export const sparkRecoveryEnvelopeSchema = z.strictObject({
  format: z.literal("conduit.spark.recovery"),
  version: z.literal(1),
  walletId: opaqueId,
  rootBackupEventId: pubkey.optional(),
  ownerPubkey: pubkey,
  provider: z.literal("spark"),
  network,
  accountNumber,
  mnemonic: z
    .string()
    .max(512)
    .refine(isValidSparkMnemonic)
    .transform(normalizeSparkMnemonic),
  // Encrypted only. The provider must derive and match this before attachment.
  identityPublicKey: z.string().regex(/^(02|03)[0-9a-f]{64}$/),
  createdAt: timestamp,
})
export type SparkRecoveryEnvelope = z.infer<typeof sparkRecoveryEnvelopeSchema>
export const sparkPrimaryPointerSchema = z.strictObject({
  format: z.literal("conduit.spark.primary"),
  version: z.literal(1),
  ownerPubkey: pubkey,
  walletId: opaqueId,
  backupEventId: pubkey,
  createdAt: timestamp,
})
export type SparkPrimaryPointer = z.infer<typeof sparkPrimaryPointerSchema>
export type SparkRecoveryBundle = Pick<
  SparkRecoveryEnvelope,
  "mnemonic" | "network" | "accountNumber"
>
export type SparkIdentityDeriver = (
  bundle: SparkRecoveryBundle
) => Promise<string>
export type SparkRecoveryFailure =
  | "invalid_record"
  | "unsupported_version"
  | "identity_mismatch"
  | "conflict"
  | "incomplete_discovery"
  | "storage_unavailable"
  | "transport_unavailable"
export class SparkRecoveryError extends Error {
  constructor(readonly code: SparkRecoveryFailure) {
    super(`Spark recovery failed: ${code}`)
    this.name = "SparkRecoveryError"
  }
}

/** Captures the established account owner; never installs another signer. */
export function bindSparkRecoveryAccount(
  signer: AccountSigner,
  current: () => AccountSigner | undefined
) {
  const owner = signer.pubkey
  const revision = signer.revision
  const assertCurrent = () => {
    if (
      current() !== signer ||
      signer.pubkey !== owner ||
      signer.revision !== revision
    )
      throw new NostrSignerError("authority_changed")
  }
  assertCurrent()
  return { owner, revision, assertCurrent }
}

export function validateSparkCiphertext(
  value: unknown
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 132 ||
    value.length > MAX_CIPHERTEXT_CHARS ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new SparkRecoveryError("invalid_record")
  const bytes = atob(value)
  if (bytes.charCodeAt(0) !== 2)
    throw new SparkRecoveryError("unsupported_version")
  if (bytes.length < 99 || btoa(bytes) !== value)
    throw new SparkRecoveryError("invalid_record")
}

/** Validate before decrypting; snapshot strips untrusted properties and mutations. */
export function validateSparkRecoveryEvent(
  input: SignedNostrEvent,
  owner: string
): SignedNostrEvent {
  try {
    if (
      input.kind !== SPARK_RECOVERY_KIND ||
      input.pubkey !== owner ||
      input.tags.length > 8 ||
      input.tags.some(
        (t) =>
          t.length > 3 || t.some((v) => typeof v !== "string" || v.length > 160)
      )
    )
      throw new SparkRecoveryError("invalid_record")
    const event = {
      id: input.id,
      pubkey: input.pubkey,
      kind: input.kind,
      created_at: input.created_at,
      tags: input.tags.map((t) => [...t]),
      content: input.content,
      sig: input.sig,
    }
    if (!isValidSignedPublicNostrEvent(event))
      throw new SparkRecoveryError("invalid_record")
    const tags = event.tags.filter((t) => t[0] === "d")
    if (
      tags.length !== 1 ||
      tags[0].length !== 2 ||
      !isSparkRecoveryAddress(tags[0][1])
    )
      throw new SparkRecoveryError("invalid_record")
    if (event.tags.some((t) => t[0] === "deleted"))
      throw new SparkRecoveryError("invalid_record")
    validateSparkCiphertext(event.content)
    return event
  } catch (error) {
    if (error instanceof SparkRecoveryError) throw error
    throw new SparkRecoveryError("invalid_record")
  }
}
export function isSparkRecoveryAddress(value: string): boolean {
  return (
    value === SPARK_PRIMARY_D_TAG ||
    value === "spark-wallet-backup" ||
    /^spark-wallet-backup:[0-9a-f]{16}$/.test(value) ||
    (value.startsWith(SPARK_RECOVERY_PREFIX) &&
      opaqueId.safeParse(value.slice(SPARK_RECOVERY_PREFIX.length)).success)
  )
}

function parsePayload(value: string): unknown {
  if (new TextEncoder().encode(value).length > MAX_SPARK_RECOVERY_BYTES)
    throw new SparkRecoveryError("invalid_record")
  try {
    return JSON.parse(value)
  } catch {
    throw new SparkRecoveryError("invalid_record")
  }
}
export function parseSparkRecoveryEnvelope(
  value: string,
  event: SignedNostrEvent
): SparkRecoveryEnvelope {
  const parsed = parsePayload(value)
  if (
    parsed &&
    typeof parsed === "object" &&
    "version" in parsed &&
    parsed.version !== 1
  )
    throw new SparkRecoveryError("unsupported_version")
  const result = sparkRecoveryEnvelopeSchema.safeParse(parsed)
  if (!result.success) throw new SparkRecoveryError("invalid_record")
  const envelope = result.data
  if (
    envelope.ownerPubkey !== event.pubkey ||
    event.tags.find((t) => t[0] === "d")?.[1] !==
      SPARK_RECOVERY_PREFIX + envelope.walletId ||
    envelope.createdAt > event.created_at
  )
    throw new SparkRecoveryError("invalid_record")
  return envelope
}
export function parseSparkPrimaryPointer(
  value: string,
  event: SignedNostrEvent
): SparkPrimaryPointer {
  const parsed = parsePayload(value)
  if (
    parsed &&
    typeof parsed === "object" &&
    "version" in parsed &&
    parsed.version !== 1
  )
    throw new SparkRecoveryError("unsupported_version")
  const result = sparkPrimaryPointerSchema.safeParse(parsed)
  if (
    !result.success ||
    result.data.ownerPubkey !== event.pubkey ||
    event.tags.find((t) => t[0] === "d")?.[1] !== SPARK_PRIMARY_D_TAG ||
    result.data.createdAt !== event.created_at
  )
    throw new SparkRecoveryError("invalid_record")
  return result.data
}

/** Validates the bare legacy phrase and its optional mnemonic-derived address. */
export function validateAddySparkMnemonic(
  plaintext: string,
  event: SignedNostrEvent
): string {
  const mnemonic = normalizeSparkMnemonic(plaintext)
  const d = event.tags.find((t) => t[0] === "d")?.[1]
  if (
    !isValidSparkMnemonic(mnemonic) ||
    (d !== "spark-wallet-backup" &&
      d !==
        "spark-wallet-backup:" +
          bytesToHex(sha256(new TextEncoder().encode(mnemonic))).slice(0, 16))
  )
    throw new SparkRecoveryError("invalid_record")
  return mnemonic
}
/** Addy stores no network/account. Require explicit source parameters; never infer a primary. */
export function parseAddySparkMnemonic(
  plaintext: string,
  event: SignedNostrEvent,
  source: Pick<SparkRecoveryBundle, "network" | "accountNumber">
): SparkRecoveryBundle {
  if (
    !network.safeParse(source.network).success ||
    !isValidSparkAccountNumber(source.accountNumber)
  )
    throw new SparkRecoveryError("invalid_record")
  return {
    mnemonic: validateAddySparkMnemonic(plaintext, event),
    network: source.network,
    accountNumber: source.accountNumber,
  }
}

/** Real disposable encrypt/sign/decrypt operations, never persisted or published. */
export async function proveSparkRecoveryCapability(
  signer: AccountSigner,
  current: () => AccountSigner | undefined
): Promise<{ ownerPubkey: string; revision: string }> {
  const scope = bindSparkRecoveryAccount(signer, current)
  if (!signer.capabilities.nip44 || !signer.capabilities.signEvent)
    throw new NostrSignerError("unsupported_operation")
  const plaintext = `conduit.spark.capability.v1:${generateId()}`
  const content = await signer.encryptNip44(scope.owner, plaintext)
  scope.assertCurrent()
  validateSparkCiphertext(content)
  const signed = await signer.signEvent({
    kind: SPARK_RECOVERY_KIND,
    pubkey: scope.owner,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", `conduit:spark:probe:v1:${generateId()}`]],
    content,
  })
  scope.assertCurrent()
  if (
    !isValidSignedPublicNostrEvent(signed) ||
    signed.pubkey !== scope.owner ||
    signed.content !== content
  )
    throw new NostrSignerError("invalid_response")
  const decrypted = await signer.decryptNip44(scope.owner, signed.content)
  scope.assertCurrent()
  if (decrypted !== plaintext) throw new NostrSignerError("invalid_response")
  return { ownerPubkey: scope.owner, revision: scope.revision }
}
