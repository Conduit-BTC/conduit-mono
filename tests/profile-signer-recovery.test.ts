import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return Bun.file(path).text()
}

describe("profile signer recovery", () => {
  for (const path of [
    "apps/market/src/routes/profile.tsx",
    "apps/merchant/src/routes/profile.tsx",
  ]) {
    it(`${path} preserves same-account drafts while resetting stale mutation state`, async () => {
      const contents = await source(path)
      const authorityStart = contents.indexOf(
        "const profileMutationAuthorityKeyRef"
      )
      const authorityEnd = contents.indexOf("useEffect(() => {", authorityStart)
      const authorityEffect = contents.slice(authorityStart, authorityEnd)

      expect(authorityEffect).toContain("authGeneration")
      expect(authorityEffect).toContain("signerReadiness")
      expect(authorityEffect).toContain("resetUpdateMutation()")
      expect(authorityEffect).toContain("setProfileSaveSucceeded(false)")
      expect(authorityEffect).not.toContain("setForm(")
      expect(authorityEffect).not.toContain("setEditingPubkey(")
      expect(contents).toContain("previousOwner === accountPubkey")
      expect(contents).toContain(
        'onReconnect={() => connect({ mode: "restore" })}'
      )
    })
  }

  it("keeps merchant trust account-owned with ready-only authentication", async () => {
    const contents = await source(
      "apps/market/src/hooks/useMerchantTrustContext.ts"
    )

    expect(contents).toContain("const viewerPubkey = accountPubkey")
    expect(contents).toContain("signerPubkey === accountPubkey")
    expect(contents).toContain("const authenticatedPubkey = signerReady")
    expect(contents).toContain("current.accountPubkey === accountPubkey")
    expect(contents).toContain("current.authGeneration === authGeneration")
    expect(contents).toContain("current.signerReadiness === signerReadiness")
    expect(contents).toContain("authenticatedPubkey,")
  })
})

describe("merchant order signer recovery", () => {
  it("keeps exact delivery retries owner-bound and signer-free", async () => {
    const contents = await source("apps/merchant/src/routes/orders.tsx")
    const exactRetryStart = contents.indexOf(
      "const retryOrganizerReadyDeliveryMutation"
    )
    const freshPaymentStart = contents.indexOf("const confirmPaymentMutation")
    const exactRetryBlock = contents.slice(exactRetryStart, freshPaymentStart)

    expect(exactRetryBlock).toContain("retryStoredOrganizerReadyReceipt")
    expect(exactRetryBlock).toContain("retryStoredOrganizerReadyRevocation")
    expect(exactRetryBlock).toContain("isCurrentOrderAccount")
    expect(contents).toContain("const mountedRef = useRef(true)")
    expect(contents).toContain("mountedRef.current = false")
    expect(contents).toContain(
      "mountedRef.current &&\n    orderAuthorityRef.current.accountPubkey === ownerPubkey"
    )
    expect(exactRetryBlock).not.toContain("captureFreshOrderAuthority")
    expect(exactRetryBlock).not.toContain("getNdk()")
    expect(contents).toContain("retryPending={stockUpdateMutation.isPending}")
  })

  it("requires live authority for fresh work and reconnects without replay", async () => {
    const contents = await source("apps/merchant/src/routes/orders.tsx")

    expect(contents).toContain("const authority = captureFreshOrderAuthority()")
    expect(contents).toContain(
      "shouldContinue: () => isCurrentOrderAction(authority)"
    )
    expect(contents).toContain(
      'if (stockUpdateMutation.variables?.action === "update")'
    )
    expect(contents).toContain("stockUpdateMutation.reset()")
    expect(contents).toContain(
      'onReconnect={() => connect({ mode: "restore" })}'
    )
    expect(contents).toContain(
      "Conduit will not sign or send it automatically."
    )
  })
})
