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

    const executionIndex = controller.indexOf(
      "const executePreparedMutation = useCallback("
    )
    const publishIndex = controller.indexOf(
      "await publishAccountNetworkMutation({",
      executionIndex
    )
    const prepareIndex = controller.indexOf(
      "const prepareChange = useCallback("
    )
    const reviewIndex = controller.indexOf(
      "const reviewed = reviewAccountNetworkMutation(",
      prepareIndex
    )
    const executeIndex = controller.indexOf(
      "await executePreparedMutation(",
      reviewIndex
    )

    expect(executionIndex).toBeGreaterThan(-1)
    expect(publishIndex).toBeGreaterThan(executionIndex)
    expect(prepareIndex).toBeGreaterThan(publishIndex)
    expect(reviewIndex).toBeGreaterThan(-1)
    expect(reviewIndex).toBeGreaterThan(prepareIndex)
    expect(executeIndex).toBeGreaterThan(reviewIndex)
    expect(controller.slice(executeIndex, executeIndex + 240)).toContain(
      "reviewed,"
    )
    expect(controller).toContain("createNdkNostrEventSigner(")
    expect(controller).not.toContain("publishWithPlanner")
    expect(mutationOwner).toContain("await input.signer.signEvent")
    expect(mutationOwner).toContain("await repository.stage")
  })
})
