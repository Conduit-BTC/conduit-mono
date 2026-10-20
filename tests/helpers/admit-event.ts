import { admitPublicEvent } from "../../packages/core/src/protocol/verified-public-event"
import type { SignedPublicNostrEvent } from "../../packages/core/src/protocol/signed-event"
export async function admitFixtureEvent(event: SignedPublicNostrEvent) {
  const result = await admitPublicEvent(event)
  if (result.status !== "verified")
    throw new Error("Synthetic event admission failed: " + result.status)
  return result.event
}
