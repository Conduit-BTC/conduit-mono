import { describe, expect, it } from "bun:test"

async function source(path: string): Promise<string> {
  return await Bun.file(path).text()
}

describe("event-market private-delivery authority propagation", () => {
  it("carries the transport predicate through exact retry reads and writes", async () => {
    const [core, merchantHandoff] = await Promise.all([
      source("packages/core/src/protocol/event-market-handoff.ts"),
      source("apps/merchant/src/lib/event-market-handoff.ts"),
    ])

    expect(core).toContain('| "shouldContinue"')
    expect(core).toContain(
      'shouldContinue?: EventMarketPrivateTransportOptions["shouldContinue"]'
    )
    expect(core).toContain("options: inboxDeclarationOptions,")
    expect(
      core.match(/shouldContinue,\n/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(3)
    expect(merchantHandoff).toContain(
      "shouldContinue: transport?.shouldContinue,"
    )
    expect(
      merchantHandoff.match(
        /input\.transport\?\.shouldContinue\?\.\(\) !== false/g
      )
    ).toHaveLength(3)
  })

  it("binds every Merchant handoff action to its existing auth generation", async () => {
    const [orders, paymentRelease, queue, futureHandoff, commerce] =
      await Promise.all([
        source("apps/merchant/src/routes/orders.tsx"),
        source("apps/merchant/src/lib/order-payment-release.ts"),
        source("apps/merchant/src/components/FutureOrganizerClaimQueue.tsx"),
        source("packages/core/src/protocol/future-market-handoff.ts"),
        source("packages/core/src/protocol/commerce.ts"),
      ])

    expect(
      orders.match(
        /transport:\s*\{\s*authenticatedPubkey,\s*shouldContinue:\s*\(\) =>\s*isCurrentOrderAction\(authority\)/g
      )
    ).toHaveLength(3)
    expect(orders).toContain(
      "shouldContinue: () => isCurrentOrderAccount(input.ownerPubkey)"
    )
    expect(paymentRelease).toContain(
      "authenticatedPubkey: input.authenticatedPubkey,\n        shouldContinue: input.shouldContinue,"
    )
    const privateInboxRead = commerce.slice(
      commerce.indexOf("async function fetchEventMarketPrivateMessagesStrict("),
      commerce.indexOf("async function resolvePrincipalInboxDeclaration(")
    )
    expect(privateInboxRead).toContain(
      "resolveInboxSyncAuthorization(principalPubkey)"
    )
    expect(
      privateInboxRead.match(/assertInboxSyncAuthority\(authorization\)/g)
        ?.length
    ).toBeGreaterThanOrEqual(3)
    expect(
      futureHandoff.match(
        /assertFutureMarketReadCurrent\(input.shouldContinue\)/g
      )
    ).toHaveLength(4)
    expect(queue).toMatch(
      /retryFutureMarketPrivateDelivery\(\{[\s\S]{0,160}authenticatedOwnerPubkey: organizerPubkey,[\s\S]{0,100}shouldContinue: \(\) => isAuthGenerationCurrent\(authGeneration\)/
    )
    expect(queue).toMatch(
      /publishFutureMarketHandoffAck\(\{[\s\S]{0,250}authenticatedPubkey: organizerPubkey,\s+shouldContinue,/
    )
    expect(queue).toMatch(
      /readFutureMarketReadyReceipts\(\{[\s\S]{0,220}shouldContinue:[\s\S]{0,100}!signal\.aborted && isAuthGenerationCurrent\(authGeneration\)/
    )
    const futureAckQuery = orders.slice(
      orders.indexOf("const futureAckQuery = useQuery({"),
      orders.indexOf("const selectedReadyDelivery =")
    )
    expect(futureAckQuery).toContain("authGeneration,")
    expect(futureAckQuery).toMatch(
      /!signal\.aborted &&\s+!!pubkey &&\s+isCurrentOrderOwner\(pubkey, authGeneration\)/
    )
    expect(futureAckQuery).toMatch(
      /readFutureMarketHandoffAcks\(\{[\s\S]{0,200}shouldContinue,/
    )
    expect(queue).toContain(
      "const visibleRead = authenticated ? query.data : undefined"
    )
    expect(queue).toContain("visibleRead?.claims.map")
    const ackRead = futureHandoff.slice(
      futureHandoff.indexOf(
        "export async function publishFutureMarketHandoffAck("
      ),
      futureHandoff.indexOf(
        "export function parseFutureMarketPrivateDeliveryRecord("
      )
    )
    expect(ackRead).toMatch(
      /readFutureMarketReadyReceipts\(\{[\s\S]{0,240}shouldContinue: input.shouldContinue,/
    )
  })
})
