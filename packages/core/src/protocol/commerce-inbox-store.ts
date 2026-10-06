import type { CheckoutRecoveryDescriptor } from "./checkout-spark-recovery"
import {
  db,
  type ConduitDB,
  type CachedOrderMessage,
  type StoredMessage,
} from "../db"
import type { DecodedCommerceMessage } from "./commerce-message-codec"
import type { ParsedDirectMessage } from "./messaging"
import {
  parseOrderMessageRumorEvent,
  type ParsedOrderMessage,
  type ParsedEventMarketPrivateMessage,
} from "./orders"
import { NostrSignerError, type SignedNostrEvent } from "./nostr-event-signer"
import {
  assertProtectedReadAuthorization,
  type ProtectedReadAuthorization,
} from "./protected-read-authorization"
import { isValidSignedPublicNostrEvent } from "./signed-event"
import { MAX_RELAY_MESSAGE_CHARS } from "./relay-wire-limits"

export type InboxDecodeState =
  | "queued"
  | "waiting_for_signer"
  | "opening"
  | "permission_declined"
  | "opened"
  | "unsupported"
  | "malformed"
  | "invalid_envelope"
  | "retryable_failure"
  | "provider_unavailable"
  | "machine"
  | "unrelated"
  | "deleted"
  | "expired"
export interface InboxCipher {
  nonce: Uint8Array
  bytes: ArrayBuffer
}
export interface InboxDeletionRow {
  id: string
  accountPubkey: string
  logicalId: string
  author: string
  observedAt: number
}
export interface InboxDeviceKey {
  id: string
  key: CryptoKey
}
export interface InboxWrapperRow {
  id: string
  accountPubkey: string
  event: SignedNostrEvent
  sources: string[]
  observedAt: number
  state: InboxDecodeState
  rulesVersion: number
  attempts: number
  clientSealMetadata?: true
  claim?: { owner: string; expiresAt: number }
  expiresAt?: number
}
export type InboxProjection =
  | {
      kind: "quarantine"
      legacy: StoredMessage | CachedOrderMessage
      id: string
      senderPubkey: string
      createdAt: number
    }
  | { kind: "direct"; message: ParsedDirectMessage }
  | { kind: "order"; message: ParsedOrderMessage }
  | { kind: "checkout_recovery"; message: CheckoutRecoveryDescriptor }
  | { kind: "recovery"; message: ParsedEventMarketPrivateMessage }
  | { kind: "record"; record: DecodedCommerceMessage }
export interface InboxProjectionRow {
  id: string
  accountPubkey: string
  logicalId: string
  wrapId?: string
  createdAt: number
  kind: InboxProjection["kind"]
  read: 0 | 1
  value: InboxCipher
  expiresAt?: number
  deleted?: true
}
export interface InboxRangeRow {
  id: string
  accountPubkey: string
  relayUrl: string
  until?: number
  /** Content-free fingerprint of the last recent window for this source/transport. */
  recentReadKey?: string
  /** Fences history commits against concurrent page progress or recent-window resets. */
  revision?: number
  status: "advanced" | "source_eose" | "partial" | "unavailable" | "capped"
  observedAt: number
  observedCount: number
  pageCount?: number
}
export interface InboxDeliveryRow {
  id: string
  accountPubkey: string
  value: InboxCipher
  state: "queued" | "partial" | "accepted" | "failed"
  updatedAt: number
  claim?: { owner: string; expiresAt: number }
}

function projectionIdentity(projection: InboxProjection) {
  return projection.kind === "quarantine"
    ? {
        id: projection.id,
        author: projection.senderPubkey,
        createdAt: projection.createdAt,
      }
    : projection.kind === "record"
      ? {
          id: projection.record.provenance.rumorId,
          author: projection.record.provenance.authorPubkey,
          createdAt: (projection.record.provenance.createdAt ?? 0) * 1000,
        }
      : {
          id: projection.message.id,
          author: projection.message.senderPubkey,
          createdAt: projection.message.createdAt,
        }
}
function freezeProjection<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeProjection(child)
  }
  return value
}
const encoder = new TextEncoder()
const decoder = new TextDecoder()
export const INBOX_DECODE_RULES_VERSION = 1
const LEASE_MS = 60_000
const KEY_ID = "commerce-inbox-aes-gcm-v1"

/** Read existing device projections without granting signer or write authority. */
export async function readRetainedInboxProjections(
  principal: string,
  isCurrent: () => boolean,
  database: ConduitDB = db
): Promise<Array<{ row: InboxProjectionRow; projection: InboxProjection }>> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("Inbox account session ended")
  }
  assertCurrent()
  const rows = await database.commerceInboxRecords
    .where("accountPubkey")
    .equals(principal)
    .filter(
      (row) =>
        !row.deleted &&
        (!row.expiresAt || row.expiresAt > Date.now()) &&
        ["direct", "order", "record"].includes(row.kind)
    )
    .toArray()
  assertCurrent()
  if (rows.length === 0) return []
  const key = await database.commerceInboxKeys.get(KEY_ID)
  assertCurrent()
  if (!key) throw new Error("Inbox device key is unavailable")
  const result: Array<{
    row: InboxProjectionRow
    projection: InboxProjection
  }> = []
  for (const row of rows) {
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(row.value.nonce),
        additionalData: encoder.encode(`${principal}:${row.logicalId}`),
      },
      key.key,
      row.value.bytes
    )
    assertCurrent()
    result.push({
      row,
      projection: freezeProjection(JSON.parse(decoder.decode(bytes))),
    })
  }
  assertCurrent()
  return result
}

/** Device encryption never derives from an account key or grants signer authority. */
export class CommerceInboxStore {
  private readonly openedViews = new Map<
    string,
    { nonce: string; projection: InboxProjection }
  >()
  clearOpenedViews(): void {
    this.openedViews.clear()
  }
  constructor(
    readonly authorization: ProtectedReadAuthorization,
    readonly database: ConduitDB = db
  ) {}
  get principal(): string {
    return this.authorization.expectedPubkey
  }
  assertCurrent(): void {
    assertProtectedReadAuthorization(this.authorization, this.principal)
  }
  key(id: string): string {
    return `${this.principal}:${id}`
  }

  private async deviceKey(): Promise<CryptoKey> {
    this.assertCurrent()
    const existing = await this.database.commerceInboxKeys.get(KEY_ID)
    this.assertCurrent()
    if (existing) return existing.key
    const candidate = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    )
    return await this.database.transaction(
      "rw",
      this.database.commerceInboxKeys,
      async () => {
        this.assertCurrent()
        const concurrent = await this.database.commerceInboxKeys.get(KEY_ID)
        if (concurrent) return concurrent.key
        await this.database.commerceInboxKeys.put({
          id: KEY_ID,
          key: candidate,
        })
        this.assertCurrent()
        return candidate
      }
    )
  }
  async seal(
    value: unknown,
    id: string,
    account = this.principal
  ): Promise<InboxCipher> {
    const key = await this.deviceKey()
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const bytes = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: encoder.encode(`${account}:${id}`),
      },
      key,
      encoder.encode(JSON.stringify(value))
    )
    this.assertCurrent()
    return { nonce, bytes }
  }
  async open<T>(value: InboxCipher, id: string): Promise<T> {
    this.assertCurrent()
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(value.nonce),
        additionalData: encoder.encode(`${this.principal}:${id}`),
      },
      await this.deviceKey(),
      value.bytes
    )
    this.assertCurrent()
    return JSON.parse(decoder.decode(bytes)) as T
  }
  async receive(
    event: SignedNostrEvent,
    sources: readonly string[] = []
  ): Promise<void> {
    this.assertCurrent()
    if (
      !isValidSignedPublicNostrEvent(event) ||
      ![1059, 4].includes(event.kind) ||
      JSON.stringify(["EVENT", "0".repeat(64), event]).length >
        MAX_RELAY_MESSAGE_CHARS ||
      event.tags.filter((t) => t[0] === "p").length !== 1 ||
      !(
        event.tags.some((t) => t[0] === "p" && t[1] === this.principal) ||
        (event.kind === 4 && event.pubkey === this.principal)
      )
    )
      throw new NostrSignerError("invalid_response")
    const expiry = event.tags.find((t) => t[0] === "expiration")?.[1]
    const expiresAt =
      expiry && /^\d+$/.test(expiry) ? Number(expiry) * 1000 : undefined
    const id = this.key(event.id)
    await this.database.transaction(
      "rw",
      this.database.commerceInboxWrappers,
      async () => {
        this.assertCurrent()
        const old = await this.database.commerceInboxWrappers.get(id)
        await this.database.commerceInboxWrappers.put(
          old
            ? {
                ...old,
                sources: [...new Set([...old.sources, ...sources])],
                observedAt: Date.now(),
                state:
                  old.state === "deleted" || old.state === "expired"
                    ? old.state
                    : expiresAt && expiresAt <= Date.now()
                      ? "expired"
                      : old.state,
              }
            : {
                id,
                accountPubkey: this.principal,
                event: structuredClone(event),
                sources: [...new Set(sources)],
                observedAt: Date.now(),
                state:
                  expiresAt && expiresAt <= Date.now() ? "expired" : "queued",
                rulesVersion: 0,
                attempts: 0,
                expiresAt,
              }
        )
        this.assertCurrent()
      }
    )
  }
  async claim(
    id: string,
    owner: string,
    retry = false
  ): Promise<InboxWrapperRow | undefined> {
    return await this.database.transaction(
      "rw",
      this.database.commerceInboxWrappers,
      async () => {
        this.assertCurrent()
        const row = await this.database.commerceInboxWrappers.get(id)
        if (
          !row ||
          row.accountPubkey !== this.principal ||
          row.state === "deleted" ||
          row.state === "expired" ||
          (row.expiresAt && row.expiresAt <= Date.now()) ||
          (row.claim &&
            row.claim.expiresAt > Date.now() &&
            row.claim.owner !== owner)
        )
          return
        const changedRules = row.rulesVersion !== INBOX_DECODE_RULES_VERSION
        if (retry && ["opened", "machine", "unrelated"].includes(row.state))
          return
        if (
          !changedRules &&
          !retry &&
          row.state !== "queued" &&
          row.state !== "waiting_for_signer" &&
          row.state !== "opening"
        )
          return
        if (!changedRules && !retry && row.attempts >= 3) return
        const next: InboxWrapperRow = {
          ...row,
          state: "waiting_for_signer",
          attempts: row.attempts + 1,
          claim: { owner, expiresAt: Date.now() + LEASE_MS },
        }
        await this.database.commerceInboxWrappers.put(next)
        this.assertCurrent()
        return next
      }
    )
  }
  async heartbeat(id: string, owner: string): Promise<void> {
    await this.database.transaction(
      "rw",
      this.database.commerceInboxWrappers,
      async () => {
        this.assertCurrent()
        const row = await this.database.commerceInboxWrappers.get(id)
        if (row?.accountPubkey === this.principal && row.claim?.owner === owner)
          await this.database.commerceInboxWrappers.update(id, {
            claim: { owner, expiresAt: Date.now() + LEASE_MS },
          })
      }
    )
  }
  async commit(
    row: InboxWrapperRow,
    owner: string,
    state: InboxDecodeState,
    projection?: InboxProjection,
    innerExpiresAt?: number
  ): Promise<void> {
    this.assertCurrent()
    const logicalId = projection ? projectionIdentity(projection).id : undefined
    const id = logicalId ? this.key(logicalId) : undefined
    const commerceRecord =
      projection?.kind === "record" && projection.record.category === "commerce"
        ? projection.record
        : undefined
    // Encrypt outside IndexedDB transactions, then check the cipher revision
    // so a concurrent local association cannot be overwritten by this decode.
    for (let attempt = 0; attempt < 32; attempt++) {
      const retained =
        commerceRecord && id
          ? await this.database.commerceInboxRecords.get(id)
          : undefined
      let nextProjection = projection
      if (commerceRecord && retained?.kind === "record" && logicalId) {
        const saved = await this.open<InboxProjection>(
          retained.value,
          logicalId
        )
        if (saved.kind === "record" && saved.record.category === "commerce")
          nextProjection = {
            kind: "record",
            record: {
              ...commerceRecord,
              association: saved.record.association,
            },
          }
      }
      const value =
        nextProjection && logicalId
          ? await this.seal(nextProjection, logicalId)
          : undefined
      const committed = await this.database.transaction(
        "rw",
        this.database.commerceInboxWrappers,
        this.database.commerceInboxRecords,
        this.database.commerceInboxDeletions,
        async () => {
          this.assertCurrent()
          const current = await this.database.commerceInboxWrappers.get(row.id)
          if (
            current?.claim?.owner !== owner ||
            current.state === "deleted" ||
            current.state === "expired"
          )
            return true
          const expiresAt = Math.min(
            current.expiresAt ?? Infinity,
            innerExpiresAt ?? Infinity
          )
          if (expiresAt <= Date.now()) {
            await this.database.commerceInboxWrappers.put({
              ...current,
              state: "expired",
              claim: undefined,
            })
            return true
          }
          if (projection && logicalId && id && value) {
            const previous = await this.database.commerceInboxRecords.get(id)
            if (
              commerceRecord &&
              previous?.value.nonce.join(",") !==
                retained?.value.nonce.join(",")
            )
              return false
            const author = projectionIdentity(projection).author
            const deleted = await this.database.commerceInboxDeletions.get(
              this.key(`${author}:${logicalId}`)
            )
            if (!previous?.deleted && !deleted)
              await this.database.commerceInboxRecords.put({
                id,
                accountPubkey: this.principal,
                logicalId,
                wrapId: row.event.id,
                createdAt: projectionIdentity(projection).createdAt,
                kind: projection.kind,
                read: previous?.read ?? 0,
                value,
                expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
              })
          }
          await this.database.commerceInboxWrappers.put({
            ...current,
            state,
            clientSealMetadata:
              row.clientSealMetadata ?? current.clientSealMetadata,
            rulesVersion: INBOX_DECODE_RULES_VERSION,
            claim: undefined,
          })
          this.assertCurrent()
          return true
        }
      )
      if (committed) return
    }
    throw new Error("Inbox record changed concurrently; retry opening")
  }
  async putProjection(
    projection: InboxProjection,
    read: 0 | 1 = 0
  ): Promise<void> {
    this.assertCurrent()
    const logicalId = projectionIdentity(projection).id
    const value = await this.seal(projection, logicalId)
    await this.database.transaction(
      "rw",
      this.database.commerceInboxRecords,
      this.database.commerceInboxDeletions,
      async () => {
        this.assertCurrent()
        const previous = await this.database.commerceInboxRecords.get(
          this.key(logicalId)
        )
        const author = projectionIdentity(projection).author
        if (
          previous?.deleted ||
          (await this.database.commerceInboxDeletions.get(
            this.key(`${author}:${logicalId}`)
          ))
        )
          return
        await this.database.commerceInboxRecords.put({
          id: this.key(logicalId),
          accountPubkey: this.principal,
          logicalId,
          wrapId: previous?.wrapId,
          expiresAt: previous?.expiresAt,
          value,
          read: previous?.read ?? read,
          kind: projection.kind,
          createdAt: projectionIdentity(projection).createdAt,
        })
        this.assertCurrent()
      }
    )
  }
  async projections(): Promise<
    Array<{ row: InboxProjectionRow; projection: InboxProjection }>
  > {
    this.assertCurrent()
    const rows = await this.database.commerceInboxRecords
      .where("accountPubkey")
      .equals(this.principal)
      .filter((r) => !r.deleted && (!r.expiresAt || r.expiresAt > Date.now()))
      .toArray()
    const result: Array<{
      row: InboxProjectionRow
      projection: InboxProjection
    }> = []
    for (const row of rows) {
      const nonce = Array.from(row.value.nonce).join(",")
      let cached = this.openedViews.get(row.id)
      if (!cached || cached.nonce !== nonce) {
        cached = {
          nonce,
          projection: freezeProjection(
            await this.open<InboxProjection>(row.value, row.logicalId)
          ),
        }
        this.openedViews.set(row.id, cached)
      }
      result.push({ row, projection: cached.projection })
    }
    this.assertCurrent()
    return result
  }
  async wrappers(): Promise<InboxWrapperRow[]> {
    this.assertCurrent()
    const rows = await this.database.commerceInboxWrappers
      .where("accountPubkey")
      .equals(this.principal)
      .toArray()
    this.assertCurrent()
    return rows
  }
  async markRead(ids: readonly string[]): Promise<number> {
    this.assertCurrent()
    return await this.database.transaction(
      "rw",
      this.database.commerceInboxRecords,
      async () => {
        this.assertCurrent()
        const count = await this.database.commerceInboxRecords
          .where("id")
          .anyOf(ids.map((id) => this.key(id)))
          .filter((row) => row.read === 0)
          .modify({ read: 1 })
        this.assertCurrent()
        return count
      }
    )
  }
  /** Retain a tombstone so late pages and new decoder rules cannot resurrect it. */
  async deleteRecords(ids: readonly string[], author: string): Promise<void> {
    this.assertCurrent()
    await this.database.commerceInboxDeletions.bulkPut(
      ids
        .filter((id) => /^[0-9a-f]{64}$/.test(id))
        .map((logicalId) => ({
          id: this.key(`${author}:${logicalId}`),
          accountPubkey: this.principal,
          logicalId,
          author,
          observedAt: Date.now(),
        }))
    )
    for (const { row, projection } of await this.projections()) {
      const sender = projectionIdentity(projection).author
      if (ids.includes(row.logicalId) && sender === author)
        await this.database.commerceInboxRecords.update(row.id, {
          deleted: true,
        })
    }
    this.assertCurrent()
  }
  /** Encrypt first; atomically replace each legacy row. Restart repeats safely. */
  async migrateLegacy(): Promise<void> {
    this.assertCurrent()
    const direct = await this.database.messages
      .where("recipientPubkey")
      .equals(this.principal)
      .or("senderPubkey")
      .equals(this.principal)
      .toArray()
    const orders = await this.database.orderMessages
      .where("recipientPubkey")
      .equals(this.principal)
      .or("senderPubkey")
      .equals(this.principal)
      .toArray()
    for (const old of [
      ...direct.map((row) => ({ table: "direct" as const, row })),
      ...orders.map((row) => ({ table: "order" as const, row })),
    ]) {
      let projection: InboxProjection = {
        kind: "quarantine",
        legacy: old.row,
        id: old.row.id,
        senderPubkey: old.row.senderPubkey,
        createdAt: old.row.createdAt,
      }
      if (old.table === "direct") {
        const row = old.row as StoredMessage
        const content = row.decrypted ?? row.content
        // Historical unverified machine or ciphertext rows are encrypted and
        // retained for a dedicated consumer, never promoted to conversation text.
        let machine = false
        try {
          const payload = JSON.parse(content)
          machine =
            payload?.type === "checkout_spark_recovery" ||
            payload?.wallet?.mnemonic !== undefined ||
            String(payload?.type ?? "").startsWith("organizer_")
        } catch {
          /* Human text is valid. */
        }
        if ([4, 14].includes(row.kind) && !machine)
          projection = {
            kind: "direct",
            message: {
              id: row.id,
              senderPubkey: row.senderPubkey,
              recipientPubkey: row.recipientPubkey,
              createdAt: row.createdAt,
              content,
              transport: row.kind === 4 ? "nip04" : "nip17",
            },
          }
      } else {
        const row = old.row as CachedOrderMessage
        try {
          const cached = JSON.parse(row.rawContent) as ParsedOrderMessage
          if (
            cached.id === row.id &&
            cached.senderPubkey === row.senderPubkey &&
            cached.recipientPubkey === row.recipientPubkey &&
            cached.orderId === row.orderId &&
            cached.createdAt === row.createdAt &&
            !cached.type.startsWith("organizer_")
          ) {
            const parsed = parseOrderMessageRumorEvent({
              id: cached.id,
              pubkey: cached.senderPubkey,
              created_at: Math.floor(cached.createdAt / 1000),
              tags: [
                ["p", cached.recipientPubkey],
                ["order", cached.orderId],
                ["type", cached.type],
              ],
              content: JSON.stringify(cached.payload),
            })
            projection = { kind: "order", message: parsed }
          }
        } catch {
          /* Preserve corrupt or unknown historical data encrypted. */
        }
      }
      const accounts = [
        ...new Set([old.row.senderPubkey, old.row.recipientPubkey]),
      ]
      const sealed = await Promise.all(
        accounts.map(async (account) => ({
          account,
          value: await this.seal(projection, old.row.id, account),
        }))
      )
      await this.database.transaction(
        "rw",
        this.database.messages,
        this.database.orderMessages,
        this.database.commerceInboxRecords,
        async () => {
          this.assertCurrent()
          for (const { account, value } of sealed) {
            const id = `${account}:${old.row.id}`
            const previous = await this.database.commerceInboxRecords.get(id)
            if (!previous)
              await this.database.commerceInboxRecords.put({
                id,
                accountPubkey: account,
                logicalId: old.row.id,
                createdAt: old.row.createdAt,
                kind: projection.kind,
                read:
                  old.table === "direct" ? (old.row as StoredMessage).read : 1,
                value,
              })
          }
          await (
            old.table === "direct"
              ? this.database.messages
              : this.database.orderMessages
          ).delete(old.row.id)
          this.assertCurrent()
        }
      )
    }
  }
}
