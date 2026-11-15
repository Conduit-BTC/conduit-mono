import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  type EventTemplate,
} from "nostr-tools/pure"
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44"
import { writeAuthSession } from "../../packages/core/src/protocol/auth-session"
export async function seed(staged: boolean) {
  const secret = generateSecretKey()
  const revision = crypto.randomUUID()
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("conduit-local-key", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("record")
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error("Fixture database failed"))
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("record", "readwrite")
    const store = tx.objectStore("record")
    store.put({ version: 1, revision, secret }, "active")
    if (staged)
      store.put(
        {
          version: 1,
          revision: revision + "-candidate",
          secret,
          previousRevision: revision,
        },
        "candidate"
      )
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(new Error("Fixture write failed"))
  })
  db.close()
  writeAuthSession({
    version: 1,
    type: "local",
    userPubkey: getPublicKey(secret),
    localKeyRevision: staged ? revision + "-candidate" : revision,
  })
  secret.fill(0)
}
export function installExtension() {
  const secret = generateSecretKey()
  Object.assign(window, {
    nostr: {
      getPublicKey: async () => getPublicKey(secret),
      signEvent: async (event: EventTemplate) => finalizeEvent(event, secret),
      nip44: {
        encrypt: async (pubkey: string, text: string) =>
          encrypt(text, getConversationKey(secret, pubkey)),
        decrypt: async (pubkey: string, text: string) =>
          decrypt(text, getConversationKey(secret, pubkey)),
      },
    },
  })
}
export async function count() {
  return new Promise<number>((resolve, reject) => {
    const request = indexedDB.open("conduit-local-key", 1)
    request.onsuccess = () => {
      const db = request.result
      if (!db.objectStoreNames.contains("record")) {
        db.close()
        resolve(0)
        return
      }
      const tx = db.transaction("record")
      const count = tx.objectStore("record").count()
      tx.oncomplete = () => {
        db.close()
        resolve(count.result)
      }
      tx.onerror = () => reject(new Error("Fixture count failed"))
    }
  })
}

export async function verifyCurrentSigner() {
  const { getAccountSigner } =
    await import("../../packages/core/src/protocol/session-signer")
  const { verifyEvent } = await import("nostr-tools/pure")
  const signer = getAccountSigner()
  if (!signer) return false
  const event = await signer.signEvent({
    pubkey: signer.pubkey,
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: "Synthetic containment validation",
  })
  return verifyEvent({ ...event, tags: event.tags.map((tag) => [...tag]) })
}
