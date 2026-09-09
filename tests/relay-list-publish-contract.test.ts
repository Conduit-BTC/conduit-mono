import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("relay-list publish contract", () => {
  it("passes one frozen review from the shared controller to the mutation owner", async () => {
    const controller = await readFile(
      "packages/core/src/hooks/useAccountNetworkSettings.ts",
      "utf8"
    )
    const mutationOwner = await readFile(
      "packages/core/src/protocol/account-network-mutation.ts",
      "utf8"
    )

    const reviewIndex = controller.indexOf(
      "const reviewed = reviewAccountNetworkMutation("
    )
    const publishIndex = controller.indexOf(
      "await publishAccountNetworkMutation({"
    )
    const reviewedArgumentIndex = controller.indexOf("reviewed,", publishIndex)

    expect(reviewIndex).toBeGreaterThan(-1)
    expect(publishIndex).toBeGreaterThan(reviewIndex)
    expect(reviewedArgumentIndex).toBeGreaterThan(publishIndex)
    expect(controller).toContain("createNdkNostrEventSigner(")
    expect(controller).not.toContain("publishWithPlanner")
    expect(mutationOwner).toContain("await input.signer.signEvent")
    expect(mutationOwner).toContain("await repository.stage")
  })
})
