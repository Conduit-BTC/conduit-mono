import { describe, expect, it } from "bun:test"
import { ensureMerchantBoothPickup } from "../apps/merchant/src/lib/event-market-pickup"

const MERCHANT = "a".repeat(64)

function pickupInput(storage: Pick<Storage, "getItem" | "setItem">) {
  return {
    authorPubkey: MERCHANT,
    dTag: "summer-market-booth",
    title: "Merchant booth pickup",
    location: "Table 12",
    country: "US",
    storage,
  }
}

describe("merchant event pickup durable retry", () => {
  it("fails before signing or relay I/O when stored retry JSON is corrupt", async () => {
    let writes = 0
    const storage = {
      getItem: () => "{not-json",
      setItem: () => {
        writes += 1
      },
    }

    await expect(
      ensureMerchantBoothPickup(pickupInput(storage))
    ).rejects.toThrow("Publishing was stopped before signing")
    expect(writes).toBe(0)
  })

  it("fails before signing when a stored row cannot prove the exact prior event", async () => {
    let writes = 0
    const storage = {
      getItem: () =>
        JSON.stringify({
          coordinate: `30406:${MERCHANT}:summer-market-booth`,
          acknowledged: false,
          signedEvent: { kind: 30406 },
        }),
      setItem: () => {
        writes += 1
      },
    }

    await expect(
      ensureMerchantBoothPickup(pickupInput(storage))
    ).rejects.toThrow("earlier pickup is not replaced")
    expect(writes).toBe(0)
  })
})
