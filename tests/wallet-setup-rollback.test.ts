import { describe, expect, it, mock } from "bun:test"

import { rollbackFailedWalletSetup } from "../apps/market/src/lib/wallet-setup-rollback"

describe("failed wallet setup rollback", () => {
  it("closes the wallet session before deleting the recovery registration", async () => {
    const order: string[] = []

    await expect(
      rollbackFailedWalletSetup({
        closeWallet: async () => {
          order.push("close")
        },
        removeRegistration: async () => {
          order.push("remove-registration")
        },
      })
    ).resolves.toEqual({ status: "removed" })
    expect(order).toEqual(["close", "remove-registration"])
  })

  it("keeps encrypted recovery when the wallet session cannot be closed", async () => {
    const removeRegistration = mock(async () => {})

    const result = await rollbackFailedWalletSetup({
      closeWallet: async () => {
        throw new Error("disconnect failed")
      },
      removeRegistration,
    })

    expect(result).toEqual({
      status: "kept",
      reason:
        "Conduit could not confirm that the wallet session closed, so its encrypted recovery record was kept on this device.",
    })
    expect(removeRegistration).toHaveBeenCalledTimes(0)
  })
})
