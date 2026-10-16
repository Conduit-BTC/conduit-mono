import { getCommerceInbox } from "@conduit/core/protocol/commerce-inbox"

interface SeededDirectMessage {
  id: string
  senderPubkey: string
  recipientPubkey: string
  read: 0 | 1
}

/**
 * Test-only: writes encrypted projections through the app's inbox owner so live
 * observers see the change exactly as an inbox sync or read mark would do.
 */
export async function seedDirectMessages(
  rows: readonly SeededDirectMessage[]
): Promise<void> {
  for (const row of rows) {
    const owner = getCommerceInbox(row.recipientPubkey)
    await owner.initialize()
    await owner.store.putProjection(
      {
        kind: "direct",
        message: { ...row, content: "", transport: "nip17", createdAt: 1 },
      },
      row.read
    )
  }
}

export async function markSeededDirectMessagesRead(
  principalPubkey: string,
  ids: readonly string[]
): Promise<void> {
  await getCommerceInbox(principalPubkey).markRead(ids)
}
