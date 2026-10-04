import { retainSignedEventMarketEvidence } from "@conduit/core"
import type { SignedEventMarketMerchantDecision } from "@conduit/core/protocol/event-market-roster-publish"

export async function retainEventMarketMerchantDecision(
  coordinate: string,
  decision: SignedEventMarketMerchantDecision,
  retain = retainSignedEventMarketEvidence
): Promise<void> {
  await Promise.all([
    retain(coordinate, decision.roster),
    retain(coordinate, decision.authorization),
  ])
}
