import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

describe("relay-list publish contract", () => {
  it("asks the signer to sign before relay network publishing", async () => {
    const content = await readFile(
      "packages/core/src/hooks/useRelaySettings.ts",
      "utf8"
    )
    const publishStart = content.indexOf("async function publishRelayList")
    expect(publishStart).toBeGreaterThan(-1)

    const publishBody = content.slice(publishStart)
    const signingIndex = publishBody.indexOf("await event.sign(ndk.signer)")
    const signatureCheckIndex = publishBody.indexOf(
      'throw new Error("Signer did not return a signature")'
    )
    const publishIndex = publishBody.indexOf("await publishWithPlanner(event")
    const ndkIndex = publishBody.indexOf("const ndk = getNdk()")
    const loadingIndex = publishBody.indexOf("setPublishingRelayList(true)")

    expect(publishBody).not.toContain("requireNdkConnected")
    expect(ndkIndex).toBeGreaterThan(-1)
    expect(loadingIndex).toBeGreaterThan(-1)
    expect(signingIndex).toBeGreaterThan(ndkIndex)
    expect(signingIndex).toBeLessThan(publishIndex)
    expect(signatureCheckIndex).toBeGreaterThan(signingIndex)
    expect(signatureCheckIndex).toBeLessThan(publishIndex)
    expect(loadingIndex).toBeLessThan(ndkIndex)
  })
})
