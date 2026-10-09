import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { admitPublicEvent, type VerifiedNostrEvent } from "@conduit/core"

export const publicFixtureSecret = generateSecretKey()
export const publicFixturePubkey = getPublicKey(publicFixtureSecret)

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

/** Explicitly sign a synthetic parser draft with the per-run fixture author. */
export async function signFixture(
  draft: {
    kind?: number
    created_at?: number
    content?: string
    tags?: readonly (readonly string[])[]
    [key: string]: unknown
  },
  kind = 30402
): Promise<VerifiedNostrEvent> {
  return admitFixture(
    finalizeEvent(
      {
        kind: draft.kind ?? kind,
        created_at: draft.created_at ?? 1,
        content: draft.content ?? "",
        tags: (draft.tags ?? []).map((tag) => [...tag]),
      },
      publicFixtureSecret
    )
  )
}
