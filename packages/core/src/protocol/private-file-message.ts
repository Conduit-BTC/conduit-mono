import { normalizePublicHttpsUrl } from "../network-target-safety"
/** NIP-17 kind-15 AES-GCM byte handling. Callers own upload and explicit download UI. */
export const MAX_PRIVATE_FILE_BYTES = 8 * 1024 * 1024

export interface PrivateFileEnvelope {
  algorithm: "aes-gcm"
  key: string
  nonce: string
  encryptedSha256: string
  originalSha256: string
  encryptedSize: number
}

/** NIP-17 allows peers to omit size and the original-file hash. */
export type PrivateFileReadEnvelope = Omit<
  PrivateFileEnvelope,
  "encryptedSize" | "originalSha256"
> &
  Partial<Pick<PrivateFileEnvelope, "encryptedSize" | "originalSha256">>

/** Form the NIP-17 kind-15 rumor after an explicit upload has returned its URL. */
export function buildPrivateFileRumor(input: {
  recipientPubkeys: string[]
  url: string
  mimeType: string
  envelope: PrivateFileEnvelope
  replyTo?: string
  subject?: string
}): { kind: 15; tags: string[][]; content: string } {
  if (
    !input.recipientPubkeys.length ||
    input.recipientPubkeys.some((pubkey) => !pubkey.trim()) ||
    !/^https:\/\//i.test(input.url) ||
    !input.mimeType.trim()
  ) {
    throw new Error(
      "Private file recipient, HTTPS URL, and MIME type are required"
    )
  }
  const { envelope } = input
  if (
    envelope.algorithm !== "aes-gcm" ||
    !Number.isSafeInteger(envelope.encryptedSize) ||
    envelope.encryptedSize < 17 ||
    envelope.encryptedSize > MAX_PRIVATE_FILE_BYTES + 16
  ) {
    throw new Error("Invalid private file metadata")
  }
  fromHex(envelope.key, 32)
  fromHex(envelope.nonce, 12)
  fromHex(envelope.encryptedSha256, 32)
  fromHex(envelope.originalSha256, 32)
  const tags: string[][] = input.recipientPubkeys.map((pubkey) => ["p", pubkey])
  if (input.replyTo) tags.push(["e", input.replyTo, "", "reply"])
  if (input.subject) tags.push(["subject", input.subject])
  tags.push(
    ["file-type", input.mimeType],
    ["encryption-algorithm", "aes-gcm"],
    ["decryption-key", envelope.key],
    ["decryption-nonce", envelope.nonce],
    ["x", envelope.encryptedSha256],
    ["ox", envelope.originalSha256],
    ["size", String(envelope.encryptedSize)]
  )
  return { kind: 15, tags, content: input.url }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

function fromHex(hex: string, bytes: number): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "i").test(hex)) {
    throw new Error("Invalid private file key, nonce, or hash")
  }
  return new Uint8Array(
    hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16))
  )
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
  )
}

/** Encrypt before upload. The URL is deliberately outside this boundary. */
export async function encryptPrivateFileBytes(plaintext: Uint8Array): Promise<{
  ciphertext: Uint8Array
  envelope: PrivateFileEnvelope
}> {
  if (
    plaintext.byteLength === 0 ||
    plaintext.byteLength > MAX_PRIVATE_FILE_BYTES
  ) {
    throw new Error("Private file size is outside the supported range")
  }
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
  ])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonceBytes },
      key,
      new Uint8Array(plaintext)
    )
  )
  return {
    ciphertext,
    envelope: {
      algorithm: "aes-gcm",
      key: toHex(keyBytes),
      nonce: toHex(nonceBytes),
      encryptedSha256: await sha256(ciphertext),
      originalSha256: await sha256(plaintext),
      encryptedSize: ciphertext.byteLength,
    },
  }
}

/** Verify ciphertext before decrypting and plaintext before returning it. */
export async function decryptPrivateFileBytes(
  ciphertext: Uint8Array,
  envelope: PrivateFileReadEnvelope
): Promise<Uint8Array> {
  if (
    envelope.algorithm !== "aes-gcm" ||
    ciphertext.byteLength < 17 ||
    ciphertext.byteLength > MAX_PRIVATE_FILE_BYTES + 16 ||
    (envelope.encryptedSize !== undefined &&
      ciphertext.byteLength !== envelope.encryptedSize)
  ) {
    throw new Error("Unsupported or oversized private file")
  }
  const keyBytes = fromHex(envelope.key, 32)
  const nonceBytes = fromHex(envelope.nonce, 12)
  fromHex(envelope.encryptedSha256, 32)
  if (envelope.originalSha256 !== undefined)
    fromHex(envelope.originalSha256, 32)
  if ((await sha256(ciphertext)) !== envelope.encryptedSha256.toLowerCase()) {
    throw new Error("Encrypted private file hash mismatch")
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    "AES-GCM",
    false,
    ["decrypt"]
  )
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(nonceBytes) },
      key,
      new Uint8Array(ciphertext)
    )
  )
  if (
    plaintext.byteLength > MAX_PRIVATE_FILE_BYTES ||
    (envelope.originalSha256 !== undefined &&
      (await sha256(plaintext)) !== envelope.originalSha256.toLowerCase())
  ) {
    throw new Error("Private file plaintext hash mismatch")
  }
  return plaintext
}

/** The only network path is an explicit caller invocation; no metadata fetches. */
export async function downloadAndDecryptPrivateFile(
  url: string,
  envelope: PrivateFileReadEnvelope,
  fetchFile: (url: string) => Promise<Response>
): Promise<Uint8Array> {
  const publicUrl = normalizePublicHttpsUrl(url)
  if (!publicUrl) throw new Error("Private file URL must use public HTTPS")
  if (
    envelope.encryptedSize !== undefined &&
    (!Number.isSafeInteger(envelope.encryptedSize) ||
      envelope.encryptedSize < 17 ||
      envelope.encryptedSize > MAX_PRIVATE_FILE_BYTES + 16)
  ) {
    throw new Error("Unsupported private file size")
  }
  const response = await fetchFile(publicUrl)
  if (!response.ok || !response.body)
    throw new Error("Private file download failed")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_PRIVATE_FILE_BYTES + 16)
        throw new Error("Private file exceeds supported size")
      if (
        envelope.encryptedSize !== undefined &&
        length > envelope.encryptedSize
      )
        throw new Error("Private file exceeds declared size")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (envelope.encryptedSize !== undefined && length !== envelope.encryptedSize)
    throw new Error("Private file size mismatch")
  const ciphertext = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    ciphertext.set(chunk, offset)
    offset += chunk.byteLength
  }
  return decryptPrivateFileBytes(ciphertext, envelope)
}
