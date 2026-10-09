import { generateId } from "../utils"

// Preserve the existing lock store for compatibility with other open tabs.
// This module reads only the auth lease, never provider credential records.
const VAULT_DATABASE_NAME = "conduit-remote-signer"
const VAULT_DATABASE_VERSION = 1
const VAULT_STORE_NAME = "session-keys"
const AUTH_OPERATION_LOCK_NAME = "conduit-auth-operation"
const AUTH_OPERATION_LOCK_ID = "auth-operation-lock"
const AUTH_OPERATION_LEASE_MS = 240_000
const AUTH_OPERATION_WAIT_MS = AUTH_OPERATION_LEASE_MS + 5_000

let authOperationQueue: Promise<void> = Promise.resolve()

interface AuthOperationLease {
  token: string
  expiresAt: number
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
async function openAuthLockDatabase(): Promise<IDBDatabase> {
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

async function withAuthOperationQueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = authOperationQueue
  let release: () => void = () => undefined
  authOperationQueue = new Promise<void>((resolve) => {
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
  const database = await openAuthLockDatabase()
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
  const database = await openAuthLockDatabase()
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
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const token = generateId()
  const deadline = Date.now() + AUTH_OPERATION_WAIT_MS
  while (!(await tryAcquireAuthOperationLease(token))) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    if (Date.now() >= deadline) {
      throw new Error(
        "Another signer operation is still active in this browser. Try again shortly."
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    return await task()
  } finally {
    await releaseAuthOperationLease(token)
  }
}

export async function withBrowserAuthOperationLock<T>(
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return signal
      ? navigator.locks.request(AUTH_OPERATION_LOCK_NAME, { signal }, task)
      : navigator.locks.request(AUTH_OPERATION_LOCK_NAME, task)
  }
  if (typeof indexedDB !== "undefined") {
    return withIndexedDbAuthOperationLock(task, signal)
  }
  return withAuthOperationQueue(async () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    return task()
  })
}
