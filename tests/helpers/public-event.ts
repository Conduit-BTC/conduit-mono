import { admitPublicEvent, type VerifiedNostrEvent } from "@conduit/core"

/** Admission for an existing fixture. Never repairs or re-signs invalid bytes. */
export async function admitFixture(raw: unknown): Promise<VerifiedNostrEvent> {
  const event =
    raw && typeof raw === "object" && "rawEvent" in raw
      ? (raw as { rawEvent(): unknown }).rawEvent()
      : raw
  const admitted = await admitPublicEvent(event)
  if (admitted.status !== "verified")
    throw new Error(`Fixture admission: ${admitted.status}`)
  return admitted.event
}
