import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("Event Market private-delivery authority propagation", () => {
  it("carries live authority through current claim reads and exact signed retries", async () => {
    const future = await source(
      "packages/core/src/protocol/future-market-handoff.ts"
    )
    for (const name of [
      "readFutureMarketReadyReceipts",
      "readFutureMarketHandoffAcks",
      "readFutureMarketMerchantClaim",
    ]) {
      const start = future.indexOf(`export async function ${name}(`)
      const next = future.indexOf("export ", start + 1)
      const read = future.slice(start, next < 0 ? undefined : next)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(read).toContain("shouldContinue?: () => boolean")
      expect(read).toContain(
        "assertFutureMarketReadCurrent(input.shouldContinue)"
      )
    }
    const retry = future.slice(
      future.indexOf("export async function retryFutureMarketPrivateDelivery(")
    )
    expect(retry).toContain("authenticatedOwnerPubkey")
    expect(retry).toContain("shouldContinue: input.shouldContinue,")
    expect(retry).toContain("record.signedRecipientWrap")
    expect(retry).toContain("record.signedSelfWrap")
  })

  it("binds fresh actions to the signer and exact retries to the owning account", async () => {
    const [orders, payment, queue, commerce] = await Promise.all([
      source("apps/merchant/src/routes/orders.tsx"),
      source("apps/merchant/src/lib/order-payment-release.ts"),
      source("apps/merchant/src/components/FutureOrganizerClaimQueue.tsx"),
      source("packages/core/src/protocol/commerce.ts"),
    ])
    for (const name of [
      "publishFutureMarketReadyReceipt",
      "publishFutureMarketRevocation",
    ]) {
      expect(orders).toMatch(
        new RegExp(
          `${name}\\(\\{[\\s\\S]{0,700}shouldContinue: \\(\\) => isCurrentOrderAction\\(authority\\)`
        )
      )
    }
    const exactRetry = orders.slice(
      orders.indexOf("const futureRetryMutation"),
      orders.indexOf("const futureRevokeMutation")
    )
    expect(exactRetry).toMatch(
      /retryFutureMarketPrivateDelivery\(\{[\s\S]{0,300}shouldContinue: \(\) =>\s+isCurrentOrderOwner\(retryOwner, retryGeneration\)/
    )
    expect(exactRetry).not.toContain("captureFreshOrderAuthority")
    expect(payment).toContain("authenticatedPubkey: input.authenticatedPubkey,")
    expect(payment).toContain("shouldContinue: input.shouldContinue,")
    const privateRead = commerce.slice(
      commerce.indexOf("async function fetchEventMarketPrivateMessagesStrict("),
      commerce.indexOf("async function resolvePrincipalInboxDeclaration(")
    )
    expect(privateRead).toContain(
      "resolveInboxSyncAuthorization(principalPubkey)"
    )
    expect(
      privateRead.match(/assertInboxSyncAuthority\(authorization\)/g)?.length
    ).toBeGreaterThanOrEqual(3)
    const recovery = orders.slice(
      orders.indexOf("const futureRecoveryQuery = useQuery({"),
      orders.indexOf("const futureRecoveredClaim =")
    )
    expect(recovery).toContain("authGeneration,")
    expect(recovery).toContain("isCurrentOrderOwner(pubkey, authGeneration)")
    const ack = orders.slice(
      orders.indexOf("const futureAckQuery = useQuery({"),
      orders.indexOf("const organizerCompletionBlocked =")
    )
    expect(ack).toContain("authGeneration,")
    expect(ack).toMatch(
      /!signal\.aborted &&\s+!!pubkey &&\s+isCurrentOrderOwner\(pubkey, authGeneration\)/
    )
    expect(ack).toMatch(
      /readFutureMarketHandoffAcks\(\{[\s\S]{0,300}shouldContinue,/
    )
    expect(queue).toMatch(
      /retryFutureMarketPrivateDelivery\(\{[\s\S]{0,160}authenticatedOwnerPubkey: organizerPubkey,[\s\S]{0,100}shouldContinue: \(\) => isAuthGenerationCurrent\(authGeneration\)/
    )
    expect(queue).toMatch(
      /publishFutureMarketHandoffAck\(\{[\s\S]{0,250}authenticatedPubkey: organizerPubkey,\s+shouldContinue,/
    )
    expect(queue).toContain(
      "const visibleRead = authenticated ? query.data : undefined"
    )
    expect(queue).toContain("visibleRead?.claims.map")
  })
})
