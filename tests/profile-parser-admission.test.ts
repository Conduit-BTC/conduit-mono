import { expect, test } from "bun:test"
import { finalizeEvent, getPublicKey } from "nostr-tools"
import { parseProfileEvent } from "../packages/core/src/protocol/profiles"
import type { VerifiedNostrEvent } from "../packages/core/src/protocol/verified-public-event"
import { admitFixture } from "./helpers/public-event"

const key = new Uint8Array(32).fill(31)

test("profile parser preserves signed admission before projection", async () => {
  const signed = finalizeEvent(
    {
      kind: 0,
      created_at: 1832123,
      tags: [],
      content: JSON.stringify({
        name: "Cycle fixture",
        about: "Signed profile",
      }),
    },
    key
  )
  expect(() => parseProfileEvent(signed as VerifiedNostrEvent)).toThrow(
    "Profile event must be admitted"
  )
  const admitted = await admitFixture(signed)
  expect(parseProfileEvent(admitted)).toMatchObject({
    pubkey: getPublicKey(key),
    name: "Cycle fixture",
    about: "Signed profile",
  })
  expect(() =>
    parseProfileEvent({
      ...admitted,
      content: JSON.stringify({ name: "Changed bytes" }),
    } as VerifiedNostrEvent)
  ).toThrow("Profile event must be admitted")
})
