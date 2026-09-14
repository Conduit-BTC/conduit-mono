import { db } from "@conduit/core"

interface SeededDirectMessage {
  id: string
  senderPubkey: string
  recipientPubkey: string
  read: 0 | 1
}

/**
 * Test-only: writes kind-14 rows through the app's Dexie instance so live
 * observers see the change exactly as an inbox sync or read mark would do.
 */
export async function seedDirectMessages(
  rows: readonly SeededDirectMessage[]
): Promise<void> {
  await db.messages.bulkPut(
    rows.map((row) => ({
      ...row,
      content: "",
      kind: 14,
      createdAt: 1,
    }))
  )
}

export async function markSeededDirectMessagesRead(
  ids: readonly string[]
): Promise<void> {
  await db.messages
    .where("id")
    .anyOf([...ids])
    .modify({ read: 1 })
}
