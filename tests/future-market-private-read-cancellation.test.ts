import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  readFutureMarketReadyReceipts,
  readFutureMarketHandoffAcks,
} from "@conduit/core"

const ORGANIZER = "a".repeat(64)

afterEach(() => {
  __resetCommerceTestOverrides()
})

describe("future market private read cancellation", () => {
  it("rejects a cancelled organizer read before invoking the signer", async () => {
    let signerReads = 0
    __setCommerceTestOverrides({
      getNdk: async () => {
        signerReads += 1
        return {} as never
      },
    })
    await expect(
      readFutureMarketReadyReceipts({
        organizerPubkey: ORGANIZER,
        shouldContinue: () => false,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(signerReads).toBe(0)
  })

  it("rejects a read whose caller is retired while its inbox read is pending", async () => {
    let live = true
    let declarationReads = 0
    __setCommerceTestOverrides({
      allowMissingProtectedReadAuthorization: true,
      getNdk: async () => ({ signer: {} }) as never,
      resolveInboxRelayUrls: async () => {
        declarationReads += 1
        live = false
        return []
      },
    })
    await expect(
      readFutureMarketReadyReceipts({
        organizerPubkey: ORGANIZER,
        shouldContinue: () => live,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(declarationReads).toBe(1)
  })

  it("rejects a cancelled merchant ack read before parsing or reading recovery", async () => {
    await expect(
      readFutureMarketHandoffAcks({
        merchantPubkey: ORGANIZER,
        readyReceiptId: "b".repeat(64),
        receipt: {} as never,
        shouldContinue: () => false,
      })
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})
