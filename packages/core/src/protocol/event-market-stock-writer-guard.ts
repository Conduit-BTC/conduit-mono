import type { ConduitDB } from "../db"

export const organizerStockWriterKey = (account: string, market: string) =>
  `${account}:${market}`

/**
 * Below-UI market fence, including previously unknown grants. An intact v28
 * journal may still use its original writer until explicitly registered; a
 * target or retired registration can never pass through that legacy lane.
 */
export async function assertOrganizerStockWriterCurrent(input: {
  db: ConduitDB
  accountPubkey: string
  marketCoordinate: string
  writerId: string
}): Promise<void> {
  const row = await input.db.eventMarketOrganizerStockWriters.get(
    organizerStockWriterKey(input.accountPubkey, input.marketCoordinate)
  )
  if (
    row &&
    (row.accountPubkey !== input.accountPubkey ||
      row.marketCoordinate !== input.marketCoordinate ||
      row.state !== "active" ||
      row.writerId !== input.writerId)
  )
    throw new Error("This stock writer has moved or needs explicit recovery.")
}
