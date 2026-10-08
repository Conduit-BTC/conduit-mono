import type { StoredMessage } from "../db"
import type { ParsedDirectMessage } from "./private-message-primitives"

export function cachedDirectMessageRow(
  message: ParsedDirectMessage,
  read: 0 | 1 = 0
): StoredMessage {
  return {
    id: message.id,
    senderPubkey: message.senderPubkey,
    recipientPubkey: message.recipientPubkey,
    content: message.content,
    kind: message.transport === "nip04" ? 4 : 14,
    createdAt: message.createdAt,
    read,
    orderCompanion: message.orderCompanionIdentity,
  }
}
export function parseCachedDirectMessage(
  row: StoredMessage
): ParsedDirectMessage {
  return {
    id: row.id,
    senderPubkey: row.senderPubkey,
    recipientPubkey: row.recipientPubkey,
    content: row.decrypted ?? row.content,
    createdAt: row.createdAt,
    transport: row.kind === 4 ? "nip04" : "nip17",
    orderCompanionIdentity: row.orderCompanion
      ? {
          ...row.orderCompanion,
          senderPubkey: row.senderPubkey,
          recipientPubkey: row.recipientPubkey,
        }
      : undefined,
  }
}
