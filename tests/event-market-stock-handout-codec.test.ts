import { expect, it } from "bun:test"
import { getEventHash } from "nostr-tools"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  createEventMarketStockAuthorityRumor,
  parseEventMarketStockAuthorityRumor,
  type EventMarketStockHandout,
} from "@conduit/core/protocol/event-market-stock-authority"

const hash = () => getPublicKey(generateSecretKey())
function payload(): EventMarketStockHandout {
  return {
    version: 1,
    type: "handed_out",
    merchantPubkey: hash(),
    organizerPubkey: hash(),
    writerId: crypto.randomUUID(),
    orderId: crypto.randomUUID(),
    identityBinding: hash(),
    termsBinding: hash(),
    claimRef: hash(),
    entries: [
      { poolId: hash(), acceptedId: hash(), quantity: 2 },
      { poolId: hash(), acceptedId: hash(), quantity: 1 },
    ].sort((a, b) => a.poolId.localeCompare(b.poolId)),
    handedOutAtMs: 120123,
  }
}
it("uses the private reserved stock envelope and exact whole-order handout manifest", () => {
  const value = payload(),
    rumor = createEventMarketStockAuthorityRumor({
      payload: value,
      createdAt: 120,
    })
  expect(parseEventMarketStockAuthorityRumor(rumor)).toEqual(value)
  expect(rumor.pubkey).toBe(value.organizerPubkey)
  expect(rumor.tags).toEqual([
    ["p", value.merchantPubkey],
    ["subject", "conduit-event-stock"],
    ["conduit", "event-stock", "1"],
  ])
  expect(rumor).not.toHaveProperty("sig")
  const changed = { ...rumor, pubkey: value.merchantPubkey }
  expect(() =>
    parseEventMarketStockAuthorityRumor({
      ...changed,
      id: getEventHash(changed),
    })
  ).toThrow()
})
it("rejects duplicate, unsorted, unknown-field or incorrectly timed handout terms", () => {
  const value = payload()
  for (const terms of [
    { ...value, entries: [...value.entries].reverse() },
    { ...value, entries: [value.entries[0], value.entries[0]] },
    { ...value, entries: [] },
    { ...value, entries: [{ ...value.entries[0], quantity: 0 }] },
    { ...value, entries: [{ ...value.entries[0], paid: true }] },
    { ...value, handedOutAtMs: 121000 },
    { ...value, paid: true },
  ])
    expect(() =>
      createEventMarketStockAuthorityRumor({
        payload: terms as EventMarketStockHandout,
        createdAt: 120,
      })
    ).toThrow()
})
