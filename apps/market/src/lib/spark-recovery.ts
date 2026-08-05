import { generateMnemonic, validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import type { WalletNetwork } from "@conduit/core"

const DEFAULT_PBKDF2_ITERATIONS = 600_000
const MIN_PBKDF2_ITERATIONS = 100_000
const MAX_PBKDF2_ITERATIONS = 2_000_000
const SALT_BYTES = 16
const IV_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const MAX_RECOVERY_PLAINTEXT_BYTES = 512
const MAX_CIPHERTEXT_BYTES = MAX_RECOVERY_PLAINTEXT_BYTES + AES_GCM_TAG_BYTES
const SALT_BASE64_LENGTH = 24
const IV_BASE64_LENGTH = 16
const MIN_CIPHERTEXT_BASE64_LENGTH = 24
const MAX_CIPHERTEXT_BASE64_LENGTH = Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4
const MAX_WALLET_ID_LENGTH = 128
const SPARK_RECOVERY_AAD_DOMAIN = "conduit:spark-recovery:v2"
export const MAX_SPARK_ACCOUNT_NUMBER = 0x7fffffff

export interface SparkEncryptedRecovery {
  version: 2
  kdf: "PBKDF2-SHA-256"
  cipher: "AES-GCM"
  iterations: number
  salt: string
  iv: string
  ciphertext: string
}

export interface SparkRecoveryEncryptionOptions {
  iterations?: number
  randomBytes?: (length: number) => Uint8Array
}

export interface SparkRecoveryBinding {
  walletId: string
  providerId: "spark"
  network: WalletNetwork
  accountNumber: number
}

export function generateSparkMnemonic(): string {
  return generateMnemonic(wordlist, 128)
}

export function normalizeSparkMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, " ")
}

export function isValidSparkMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeSparkMnemonic(mnemonic), wordlist)
}

export function isValidSparkAccountNumber(
  accountNumber: unknown
): accountNumber is number {
  return (
    typeof accountNumber === "number" &&
    Number.isSafeInteger(accountNumber) &&
    accountNumber >= 0 &&
    accountNumber <= MAX_SPARK_ACCOUNT_NUMBER
  )
}

export async function encryptSparkMnemonic(
  mnemonic: string,
  password: string,
  binding: SparkRecoveryBinding,
  options: SparkRecoveryEncryptionOptions = {}
): Promise<SparkEncryptedRecovery> {
  const normalizedMnemonic = normalizeSparkMnemonic(mnemonic)
  if (!isValidSparkMnemonic(normalizedMnemonic)) {
    throw new Error("Enter a valid BIP39 recovery phrase.")
  }
  if (password.length < 10) {
    throw new Error("Use at least 10 characters for the local wallet password.")
  }
  const additionalData = encodeSparkRecoveryBinding(binding)

  const randomBytes =
    options.randomBytes ??
    ((length: number) =>
      globalThis.crypto.getRandomValues(new Uint8Array(length)))
  const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < MIN_PBKDF2_ITERATIONS ||
    iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new Error("Portable Wallet recovery KDF settings are invalid.")
  }
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  if (salt.byteLength !== SALT_BYTES || iv.byteLength !== IV_BYTES) {
    throw new Error("Portable Wallet recovery randomness is invalid.")
  }
  const key = await deriveEncryptionKey(password, salt, iterations)
  const plaintext = new TextEncoder().encode(normalizedMnemonic)
  let ciphertext: ArrayBuffer
  try {
    ciphertext = await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(additionalData),
      },
      key,
      toArrayBuffer(plaintext)
    )
  } finally {
    plaintext.fill(0)
  }

  return {
    version: 2,
    kdf: "PBKDF2-SHA-256",
    cipher: "AES-GCM",
    iterations,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  }
}

export async function decryptSparkMnemonic(
  envelope: SparkEncryptedRecovery,
  password: string,
  binding: SparkRecoveryBinding
): Promise<string> {
  try {
    validateEnvelope(envelope)
    const additionalData = encodeSparkRecoveryBinding(binding)
    const salt = decodeBase64(envelope.salt)
    const iv = decodeBase64(envelope.iv)
    const ciphertext = decodeBase64(envelope.ciphertext)
    if (
      salt.byteLength !== SALT_BYTES ||
      iv.byteLength !== IV_BYTES ||
      ciphertext.byteLength < AES_GCM_TAG_BYTES ||
      ciphertext.byteLength > MAX_CIPHERTEXT_BYTES
    ) {
      throw new Error("Invalid Portable Wallet recovery envelope.")
    }
    const key = await deriveEncryptionKey(password, salt, envelope.iterations)
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(additionalData),
      },
      key,
      toArrayBuffer(ciphertext)
    )
    const plaintextBytes = new Uint8Array(plaintext)
    let mnemonic: string
    try {
      mnemonic = normalizeSparkMnemonic(
        new TextDecoder().decode(plaintextBytes)
      )
    } finally {
      plaintextBytes.fill(0)
    }
    if (!isValidSparkMnemonic(mnemonic)) {
      throw new Error("Invalid recovery phrase.")
    }
    return mnemonic
  } catch {
    throw new Error("Could not unlock Portable Wallet.")
  }
}

async function deriveEncryptionKey(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password)
  let keyMaterial: CryptoKey
  try {
    keyMaterial = await globalThis.crypto.subtle.importKey(
      "raw",
      toArrayBuffer(passwordBytes),
      "PBKDF2",
      false,
      ["deriveKey"]
    )
  } finally {
    passwordBytes.fill(0)
  }
  return globalThis.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

function validateEnvelope(
  envelope: SparkEncryptedRecovery
): asserts envelope is SparkEncryptedRecovery {
  if (!isSparkEncryptedRecoveryEnvelope(envelope)) {
    throw new Error("Invalid Portable Wallet recovery envelope.")
  }
}

export function isSparkEncryptedRecoveryEnvelope(
  envelope: unknown
): envelope is SparkEncryptedRecovery {
  if (typeof envelope !== "object" || envelope === null) {
    return false
  }
  const value = envelope as Partial<SparkEncryptedRecovery>
  return (
    value.version === 2 &&
    value.kdf === "PBKDF2-SHA-256" &&
    value.cipher === "AES-GCM" &&
    Number.isSafeInteger(value.iterations) &&
    (value.iterations ?? 0) >= MIN_PBKDF2_ITERATIONS &&
    (value.iterations ?? 0) <= MAX_PBKDF2_ITERATIONS &&
    isCanonicalBase64InRange(
      value.salt,
      SALT_BASE64_LENGTH,
      SALT_BASE64_LENGTH
    ) &&
    isCanonicalBase64InRange(value.iv, IV_BASE64_LENGTH, IV_BASE64_LENGTH) &&
    isCanonicalBase64InRange(
      value.ciphertext,
      MIN_CIPHERTEXT_BASE64_LENGTH,
      MAX_CIPHERTEXT_BASE64_LENGTH
    )
  )
}

function encodeSparkRecoveryBinding(binding: SparkRecoveryBinding): Uint8Array {
  if (
    !binding.walletId ||
    binding.walletId.length > MAX_WALLET_ID_LENGTH ||
    binding.providerId !== "spark" ||
    !isWalletNetwork(binding.network) ||
    !isValidSparkAccountNumber(binding.accountNumber)
  ) {
    throw new Error("Portable Wallet recovery binding is invalid.")
  }
  return new TextEncoder().encode(
    JSON.stringify([
      SPARK_RECOVERY_AAD_DOMAIN,
      binding.walletId,
      binding.providerId,
      binding.network,
      binding.accountNumber,
    ])
  )
}

function isCanonicalBase64InRange(
  value: unknown,
  minimumLength: number,
  maximumLength: number
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  )
}

function isWalletNetwork(value: unknown): value is WalletNetwork {
  return (
    value === "mainnet" ||
    value === "testnet" ||
    value === "signet" ||
    value === "regtest"
  )
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer) {
    if (
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
    ) {
      return bytes.buffer
    }
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    )
  }
  return bytes.slice().buffer as ArrayBuffer
}
