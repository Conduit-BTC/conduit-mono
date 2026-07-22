import { generateId } from "../utils"

const VAULT_DATABASE_NAME = "conduit-remote-signer"
const VAULT_DATABASE_VERSION = 1
const VAULT_STORE_NAME = "session-keys"
const WRAPPING_KEY_ID = "wrapping-key"
const VAULT_LOCK_NAME = "conduit-remote-signer-vault"
const AUTH_OPERATION_LOCK_NAME = "conduit-auth-operation"
const AUTH_OPERATION_LOCK_ID = "auth-operation-lock"
const AUTH_OPERATION_LEASE_MS = 240_000
const AUTH_OPERATION_WAIT_MS = AUTH_OPERATION_LEASE_MS + 5_000

let vaultQueue: Promise<void> = Promise.resolve()

interface EncryptedSessionKey {
  iv: Uint8Array
  ciphertext: ArrayBuffer
}

interface AuthOperationLease {
  token: string
  expiresAt: number
}

export interface RemoteSignerKeyVault {
  prepare(): Promise<void>
  store(id: string, clientPrivateKey: string): Promise<void>
  load(id: string): Promise<string | null>
  remove(id: string): Promise<void>
}

const SECURE_STORAGE_ERROR =
  "Encrypted remote signer storage is unavailable. Open Conduit over HTTPS in an updated browser, then try again."

function requireWebCrypto(): Crypto {
  if (
    (typeof globalThis.isSecureContext === "boolean" &&
      !globalThis.isSecureContext) ||
    typeof globalThis.crypto === "undefined" ||
    typeof globalThis.crypto.getRandomValues !== "function" ||
    !globalThis.crypto.subtle ||
    typeof globalThis.crypto.subtle.generateKey !== "function" ||
    typeof globalThis.crypto.subtle.encrypt !== "function" ||
    typeof globalThis.crypto.subtle.decrypt !== "function"
  ) {
    throw new Error(SECURE_STORAGE_ERROR)
  }
  return globalThis.crypto
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    })
    request.addEventListener("error", () => reject(request.error), {
      once: true,
    })
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true })
    transaction.addEventListener("abort", () => reject(transaction.error), {
      once: true,
    })
    transaction.addEventListener("error", () => reject(transaction.error), {
      once: true,
    })
  })
}

async function openVaultDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    throw new Error("Browser key storage is unavailable")
  }
  const request = indexedDB.open(VAULT_DATABASE_NAME, VAULT_DATABASE_VERSION)
  request.addEventListener("upgradeneeded", () => {
    if (!request.result.objectStoreNames.contains(VAULT_STORE_NAME)) {
      request.result.createObjectStore(VAULT_STORE_NAME)
    }
  })
  return requestResult(request)
}

async function getOrCreateWrappingKey(
  database: IDBDatabase
): Promise<CryptoKey> {
  const readTransaction = database.transaction(VAULT_STORE_NAME, "readonly")
  const readComplete = transactionComplete(readTransaction)
  const existing = await requestResult(
    readTransaction.objectStore(VAULT_STORE_NAME).get(WRAPPING_KEY_ID)
  )
  await readComplete
  if (isCryptoKey(existing)) return existing

  const webCrypto = requireWebCrypto()
  const key = await webCrypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
  const writeTransaction = database.transaction(VAULT_STORE_NAME, "readwrite")
  const writeComplete = transactionComplete(writeTransaction)
  try {
    await requestResult(
      writeTransaction.objectStore(VAULT_STORE_NAME).add(key, WRAPPING_KEY_ID)
    )
    await writeComplete
    return key
  } catch (error) {
    await writeComplete.catch(() => undefined)
    const retryTransaction = database.transaction(VAULT_STORE_NAME, "readonly")
    const retryComplete = transactionComplete(retryTransaction)
    const concurrentlyCreated = await requestResult(
      retryTransaction.objectStore(VAULT_STORE_NAME).get(WRAPPING_KEY_ID)
    )
    await retryComplete
    if (isCryptoKey(concurrentlyCreated)) return concurrentlyCreated
    throw error
  }
}

function isCryptoKey(value: unknown): value is CryptoKey {
  if (typeof CryptoKey !== "undefined") return value instanceof CryptoKey
  return Object.prototype.toString.call(value) === "[object CryptoKey]"
}

async function withVaultLock<T>(task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(VAULT_LOCK_NAME, task)
  }

  const previous = vaultQueue
  let release: () => void = () => undefined
  vaultQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await task()
  } finally {
    release()
  }
}

function isAuthOperationLease(value: unknown): value is AuthOperationLease {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AuthOperationLease).token === "string" &&
    typeof (value as AuthOperationLease).expiresAt === "number"
  )
}

async function tryAcquireAuthOperationLease(token: string): Promise<boolean> {
  const database = await openVaultDatabase()
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(VAULT_STORE_NAME, "readwrite")
      const store = transaction.objectStore(VAULT_STORE_NAME)
      let acquired = false
      const request = store.get(AUTH_OPERATION_LOCK_ID)
      request.addEventListener(
        "success",
        () => {
          const existing = request.result
          if (
            isAuthOperationLease(existing) &&
            existing.expiresAt > Date.now()
          ) {
            return
          }
          store.put(
            { token, expiresAt: Date.now() + AUTH_OPERATION_LEASE_MS },
            AUTH_OPERATION_LOCK_ID
          )
          acquired = true
        },
        { once: true }
      )
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      })
      transaction.addEventListener("complete", () => resolve(acquired), {
        once: true,
      })
      transaction.addEventListener("abort", () => reject(transaction.error), {
        once: true,
      })
      transaction.addEventListener("error", () => reject(transaction.error), {
        once: true,
      })
    })
  } finally {
    database.close()
  }
}

async function releaseAuthOperationLease(token: string): Promise<void> {
  const database = await openVaultDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(VAULT_STORE_NAME, "readwrite")
      const store = transaction.objectStore(VAULT_STORE_NAME)
      const request = store.get(AUTH_OPERATION_LOCK_ID)
      request.addEventListener(
        "success",
        () => {
          const existing = request.result
          if (isAuthOperationLease(existing) && existing.token === token) {
            store.delete(AUTH_OPERATION_LOCK_ID)
          }
        },
        { once: true }
      )
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      })
      transaction.addEventListener("complete", () => resolve(), { once: true })
      transaction.addEventListener("abort", () => reject(transaction.error), {
        once: true,
      })
      transaction.addEventListener("error", () => reject(transaction.error), {
        once: true,
      })
    })
  } finally {
    database.close()
  }
}

async function withIndexedDbAuthOperationLock<T>(
  task: () => Promise<T>
): Promise<T> {
  const token = generateId()
  const deadline = Date.now() + AUTH_OPERATION_WAIT_MS
  while (!(await tryAcquireAuthOperationLease(token))) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Another signer operation is still active in this browser. Try again shortly."
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    return await task()
  } finally {
    await releaseAuthOperationLease(token)
  }
}

export async function withBrowserAuthOperationLock<T>(
  task: () => Promise<T>
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(AUTH_OPERATION_LOCK_NAME, task)
  }
  if (typeof indexedDB !== "undefined") {
    return withIndexedDbAuthOperationLock(task)
  }
  return withVaultLock(task)
}

export function createBrowserRemoteSignerKeyVault(): RemoteSignerKeyVault {
  return {
    async prepare() {
      requireWebCrypto()
      await withVaultLock(async () => {
        const database = await openVaultDatabase()
        try {
          await getOrCreateWrappingKey(database)
        } finally {
          database.close()
        }
      })
    },

    async store(id, clientPrivateKey) {
      await withVaultLock(async () => {
        const database = await openVaultDatabase()
        try {
          const webCrypto = requireWebCrypto()
          const wrappingKey = await getOrCreateWrappingKey(database)
          const iv = webCrypto.getRandomValues(new Uint8Array(12))
          const ciphertext = await webCrypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            wrappingKey,
            new TextEncoder().encode(clientPrivateKey)
          )
          const transaction = database.transaction(
            VAULT_STORE_NAME,
            "readwrite"
          )
          transaction
            .objectStore(VAULT_STORE_NAME)
            .put({ iv, ciphertext } satisfies EncryptedSessionKey, id)
          await transactionComplete(transaction)
        } finally {
          database.close()
        }
      })
    },

    async load(id) {
      return withVaultLock(async () => {
        const database = await openVaultDatabase()
        try {
          const webCrypto = requireWebCrypto()
          const wrappingKey = await getOrCreateWrappingKey(database)
          const transaction = database.transaction(VAULT_STORE_NAME, "readonly")
          const complete = transactionComplete(transaction)
          const stored = await requestResult(
            transaction.objectStore(VAULT_STORE_NAME).get(id)
          )
          await complete
          if (
            typeof stored !== "object" ||
            stored === null ||
            !(stored.iv instanceof Uint8Array) ||
            !(stored.ciphertext instanceof ArrayBuffer)
          ) {
            return null
          }
          const plaintext = await webCrypto.subtle.decrypt(
            { name: "AES-GCM", iv: stored.iv },
            wrappingKey,
            stored.ciphertext
          )
          return new TextDecoder().decode(plaintext)
        } finally {
          database.close()
        }
      })
    },

    async remove(id) {
      await withVaultLock(async () => {
        const database = await openVaultDatabase()
        try {
          const transaction = database.transaction(
            VAULT_STORE_NAME,
            "readwrite"
          )
          transaction.objectStore(VAULT_STORE_NAME).delete(id)
          await transactionComplete(transaction)
        } finally {
          database.close()
        }
      })
    },
  }
}
