import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { getPublicKey, generateSecretKey } from "nostr-tools/pure"
import {
  admitPublicEvent,
  parseEventMarketCalendarEvent,
  parseEventMarketRosterEvent,
  parseEventMarketStockAuthorityRumor,
  type EventMarketOrganizerStockPool,
  type MerchantInventoryAssignment,
  type MerchantInventoryProduct,
} from "@conduit/core"
import {
  EventMarketStockPoolList,
  merchantStockRestoreFailureNotice,
} from "../apps/merchant/src/components/EventMarketStockPanel"
import { EventMarketOrganizerPickupForm } from "../apps/merchant/src/components/EventMarketOrganizerPickupCard"
import { projectEventMarketOrganizerMerchandise } from "@conduit/core/protocol/event-market-organizer-merchandise"
import {
  buildMerchantOrganizerStockGrant,
  createOrganizerStockDevice,
  prepareOrganizerStockTargetDevice,
  readOrganizerStockDevice,
  reserveOrganizerStockInstallation,
  stockPoolBelongsToOccurrence,
} from "../apps/merchant/src/lib/event-market-stock-handover"
import {
  checkoutSparkEventMarketFixture,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}
const hash = () => getPublicKey(generateSecretKey())
async function grantFixture() {
  const fixture = checkoutSparkEventMarketFixture({ mode: "organizer_handoff" })
  const admitted = await admitPublicEvent(fixture.events.market)
  if (admitted.status !== "verified")
    throw new Error("Expected verified fixture")
  const market = parseEventMarketRosterEvent(admitted.event)!
  const admittedOccurrence = await admitPublicEvent(fixture.events.occurrence)
  if (admittedOccurrence.status !== "verified")
    throw new Error("Expected verified occurrence")
  const occurrence = parseEventMarketCalendarEvent(admittedOccurrence.event)!
  const product: MerchantInventoryProduct = {
    coordinate: fixture.eventMarket.lines[0]!.productCoordinate,
    merchantPubkey: fixture.merchantPubkey,
    stock: 10,
    revision: 1,
    sourceProductEvent: fixture.events.product,
    signedProductEvent: fixture.events.product,
    publicationJobs: [],
  }
  const assignment: MerchantInventoryAssignment = {
    coordinate: fixture.eventMarket.lines[0]!.assignmentCoordinate,
    productCoordinate: product.coordinate,
    merchantPubkey: fixture.merchantPubkey,
    marketCoordinate: market.coordinate,
    occurrenceCoordinate: occurrence.coordinate,
    inventory: { mode: "tracked", quantity: 5 },
    state: "active",
    fulfillmentMethods: ["pickup"],
    occurrenceEndMs: occurrence.end,
    terminal: false,
    revision: 1,
    signedAssignmentEvent: fixture.events.assignment,
    publicationJobs: [],
  }
  const writerId = crypto.randomUUID()
  const input = {
    market,
    occurrence,
    assignment,
    product,
    authenticatedPubkey: fixture.merchantPubkey,
    grantEventId: fixture.events.grant.id,
    writerId,
    quantityText: "3",
    nowMs: AT,
  }
  const rumor = buildMerchantOrganizerStockGrant(input)
  const pool: EventMarketOrganizerStockPool = {
    id: `${fixture.organizerPubkey}:${rumor.id}`,
    accountPubkey: fixture.organizerPubkey,
    poolId: rumor.id,
    merchantPubkey: fixture.merchantPubkey,
    organizerPubkey: fixture.organizerPubkey,
    writerId,
    productCoordinate: product.coordinate,
    assignmentCoordinate: assignment.coordinate,
    grantRumor: rumor,
    quantity: 3,
    acceptedQuantity: 1,
    acceptedSequence: 1,
    lastAcceptedId: hash(),
    importedQuantity: 0,
    importedSequence: 0,
    lastImportedId: rumor.id,
    state: "active",
  }
  return { ...fixture, input, rumor, pool, writerId, market, occurrence }
}

describe("stock restore failure diagnostics", () => {
  it("renders only fixed restore stages, never unknown strings or object properties", () => {
    expect(merchantStockRestoreFailureNotice("public_binding")).toBe(
      "Stock recovery stopped during signed inventory verification."
    )
    expect(merchantStockRestoreFailureNotice("product_binding")).toBe(
      "Stock recovery stopped during product revision verification."
    )
    expect(merchantStockRestoreFailureNotice("assignment_binding")).toBe(
      "Stock recovery stopped during assignment revision verification."
    )
    for (const stage of [
      "observation",
      "private_history",
      "local_reseal",
      "ancestry",
      "final_frontier",
      "commit",
    ])
      expect(merchantStockRestoreFailureNotice(stage)).toMatch(
        /^Stock recovery stopped during [a-z ]+\.$/
      )
    for (const stage of [
      undefined,
      null,
      "constructor",
      "__proto__",
      "not-an-approved-stage",
      { toString: () => "not-an-approved-stage" },
    ])
      expect(merchantStockRestoreFailureNotice(stage)).toBeNull()
  })
})

describe("explicit organizer device handover", () => {
  it("creates once only on explicit action, account/market scopes IDs and never adopts a relay writer", () => {
    const storage = memoryStorage(),
      account = hash(),
      market = `30409:${account}:test`
    expect(readOrganizerStockDevice(storage, account, market)).toBeNull()
    const device = createOrganizerStockDevice({
      storage,
      account,
      market,
      hasRetainedPools: false,
    })
    expect(
      createOrganizerStockDevice({
        storage,
        account,
        market,
        hasRetainedPools: false,
      }).writerId
    ).toBe(device.writerId)
    expect(readOrganizerStockDevice(storage, hash(), market)).toBeNull()
    expect(
      readOrganizerStockDevice(storage, account, `${market}-other`)
    ).toBeNull()
    expect(() =>
      createOrganizerStockDevice({
        storage: memoryStorage(),
        account,
        market,
        hasRetainedPools: true,
      })
    ).toThrow("original")
    expect(() =>
      createOrganizerStockDevice({
        storage: { getItem: () => null, setItem: () => undefined },
        account,
        market,
        hasRetainedPools: false,
      })
    ).toThrow("Save")
  })
  it("does not reinstall consumed stock after journal loss or accept a different device", async () => {
    const f = await grantFixture(),
      storage = memoryStorage(),
      account = f.organizerPubkey,
      market = f.market.coordinate
    createOrganizerStockDevice({
      storage,
      account,
      market,
      hasRetainedPools: false,
      randomUUID: () => f.writerId,
    })
    reserveOrganizerStockInstallation({
      storage,
      account,
      market,
      poolId: f.pool.poolId,
      writerId: f.writerId,
    })
    expect(() =>
      reserveOrganizerStockInstallation({
        storage,
        account,
        market,
        poolId: f.pool.poolId,
        writerId: f.writerId,
      })
    ).toThrow("journal is missing")
    expect(
      reserveOrganizerStockInstallation({
        storage,
        account,
        market,
        poolId: f.pool.poolId,
        writerId: f.writerId,
        existingPool: f.pool,
      }).installedPoolIds
    ).toEqual([f.pool.poolId])
    expect(() =>
      reserveOrganizerStockInstallation({
        storage,
        account,
        market,
        poolId: hash(),
        writerId: crypto.randomUUID(),
      })
    ).toThrow("different")
  })
  it("fails closed for a malformed saved device record", () => {
    const storage = {
      getItem: () => '{"version":1,"writerId":"invalid"}',
      setItem: () => undefined,
    }
    expect(() => readOrganizerStockDevice(storage, hash(), "event")).toThrow(
      "recovery"
    )
  })
  it("retains the complete supported 2048-pool frontier and rejects an oversized label without trimming", () => {
    const storage = memoryStorage(),
      account = hash(),
      market = `30409:${account}:bounded`,
      writerId = crypto.randomUUID(),
      installedPoolIds = Array.from({ length: 2048 }, (_, index) =>
        index.toString(16).padStart(64, "0")
      )
    const key = `conduit:event-stock-device:1:${account}:${market}`
    storage.setItem(
      key,
      JSON.stringify({ version: 1, writerId, installedPoolIds })
    )
    expect(
      readOrganizerStockDevice(storage, account, market)?.installedPoolIds
    ).toEqual(installedPoolIds)
    expect(() =>
      reserveOrganizerStockInstallation({
        storage,
        account,
        market,
        poolId: hash(),
        writerId,
      })
    ).toThrow("more stock")
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        writerId,
        installedPoolIds: [...installedPoolIds, hash()],
      })
    )
    expect(() => readOrganizerStockDevice(storage, account, market)).toThrow(
      "recovery"
    )
  })
  it("does not turn malformed v2 labels into a replacement or logical writer", () => {
    const writerId = crypto.randomUUID(),
      deviceId = crypto.randomUUID()
    for (const record of [
      { version: 2, writerId, deviceId, mode: "writer", installedPoolIds: [] },
      {
        version: 2,
        writerId: deviceId,
        deviceId,
        mode: "target",
        installedPoolIds: [hash()],
      },
      {
        version: 2,
        writerId: deviceId,
        deviceId,
        mode: "target",
        installedPoolIds: [],
        extra: true,
      },
      {
        version: 2,
        writerId,
        deviceId,
        mode: "writer",
        installedPoolIds: [],
        transferId: hash(),
      },
    ])
      expect(() =>
        readOrganizerStockDevice(
          { getItem: () => JSON.stringify(record), setItem: () => {} },
          hash(),
          "event"
        )
      ).toThrow("recovery")
    expect(() =>
      prepareOrganizerStockTargetDevice({
        storage: { getItem: () => null, setItem: () => {} },
        account: hash(),
        market: "event",
        hasRetainedPools: false,
      })
    ).toThrow("Save")
    expect(() =>
      readOrganizerStockDevice(
        {
          getItem: () => {
            throw new Error("Blocked")
          },
          setItem: () => {},
        },
        hash(),
        "event"
      )
    ).toThrow("storage is unavailable")
    expect(() =>
      prepareOrganizerStockTargetDevice({
        storage: {
          getItem: () => null,
          setItem: () => {
            throw new Error("Quota")
          },
        },
        account: hash(),
        market: "event",
        hasRetainedPools: false,
      })
    ).toThrow("Save")
  })
})

describe("stock grant form composition", () => {
  it("freezes finite quantity, chosen device and exact signed source references", async () => {
    const f = await grantFixture(),
      grant = parseEventMarketStockAuthorityRumor(f.rumor)
    expect(grant).toMatchObject({
      type: "grant",
      quantity: 3,
      writerId: f.writerId,
      productEventId: f.events.product.id,
      assignmentEventId: f.events.assignment.id,
      marketEventId: f.events.market.id,
      occurrenceEventId: f.events.occurrence.id,
      grantEventId: f.events.grant.id,
      expiresAtMs: f.occurrence.end,
    })
    expect(
      stockPoolBelongsToOccurrence(
        f.pool,
        f.market.coordinate,
        f.occurrence.coordinate
      )
    ).toBe(true)
    expect(
      stockPoolBelongsToOccurrence(
        f.pool,
        f.market.coordinate,
        `${f.occurrence.coordinate}-other`
      )
    ).toBe(false)
    for (const quantityText of [
      "0",
      "-1",
      "1.5",
      "1e2",
      "6",
      "9007199254740992",
    ])
      expect(() =>
        buildMerchantOrganizerStockGrant({ ...f.input, quantityText })
      ).toThrow()
    expect(() =>
      buildMerchantOrganizerStockGrant({ ...f.input, nowMs: f.occurrence.end })
    ).toThrow()
    expect(() =>
      buildMerchantOrganizerStockGrant({
        ...f.input,
        assignment: { ...f.input.assignment, inventory: { mode: "untracked" } },
      })
    ).toThrow()
    expect(() =>
      buildMerchantOrganizerStockGrant({
        ...f.input,
        assignment: {
          ...f.input.assignment,
          organizerStockHold: {
            poolId: hash(),
            organizerPubkey: f.organizerPubkey,
            quantity: 3,
            importedQuantity: 0,
            closed: false,
          },
        },
      })
    ).toThrow()
  })
})

describe("stock pool controls", () => {
  it("shows finite remaining stock and a single explicit close on the selected writer", async () => {
    const f = await grantFixture()
    let actions = 0
    const html = renderToStaticMarkup(
      <EventMarketStockPoolList
        pools={[f.pool]}
        accountPubkey={f.organizerPubkey}
        writerId={f.writerId}
        busy={false}
        onAction={() => {
          actions++
        }}
      />
    )
    expect(html).toContain("Stop new sales and close pool")
    expect(html).toContain("Remaining")
    expect(html).toContain("<dd>2</dd>")
    expect(html).toContain("complete accepted-order history")
    expect(actions).toBe(0)
  })
  it("does not expose a new close on another or recovered read-only device", async () => {
    const f = await grantFixture()
    for (const pool of [
      f.pool,
      { ...f.pool, readOnlyRecovery: true as const },
    ]) {
      const html = renderToStaticMarkup(
        <EventMarketStockPoolList
          pools={[pool]}
          accountPubkey={f.organizerPubkey}
          writerId={pool.readOnlyRecovery ? f.writerId : crypto.randomUUID()}
          busy={false}
          onAction={() => undefined}
        />
      )
      expect(html).toContain("Read-only here")
      expect(html).not.toContain("Stop new sales and close pool")
    }
  })
  it("keeps a retired or target device read-only even when its saved logical writer matches", async () => {
    const f = await grantFixture()
    const html = renderToStaticMarkup(
      <EventMarketStockPoolList
        pools={[f.pool]}
        accountPubkey={f.organizerPubkey}
        writerId={f.writerId}
        writerBlocked
        busy={false}
        onAction={() => undefined}
      />
    )
    expect(html).not.toContain("Stop new sales and close pool")
    expect(html).toContain("Read-only here")
  })
})

describe("organizer pickup controls", () => {
  const fixture = checkoutSparkEventMarketFixture()
  const props = {
    orderLabel: "example",
    quantity: 1,
    merchandise: projectEventMarketOrganizerMerchandise({
      merchantPubkey: fixture.merchantPubkey,
      eventMarket: fixture.eventMarket,
      commerceQuote: fixture.plan.commerceQuote,
      sourceEvents: fixture.sourceEvents,
    }),
    routing: false,
    paymentVerified: false,
    handedOut: false,
    waitingForBuyer: false,
    claimCode: "",
    onClaimCode: () => undefined,
    onContinue: () => undefined,
    onPause: () => undefined,
    onHandout: () => undefined,
    onRetryHandout: () => undefined,
  }
  it("never exposes physical release before independent goods verification", () => {
    const html = renderToStaticMarkup(
      <EventMarketOrganizerPickupForm {...props} />
    )
    expect(html).toContain("Goods payment not yet verified")
    expect(html).toContain("Continue this order")
    expect(html).not.toContain("Confirm code and hand out once")
    expect(html).not.toContain("Buyer's pickup code")
    const verified = renderToStaticMarkup(
      <EventMarketOrganizerPickupForm {...props} paymentVerified />
    )
    expect(verified).toContain("exact required goods payments are verified")
    expect(verified).toContain("Buyer&#x27;s pickup code")
    expect(verified).toContain("Confirm code and hand out once")
    expect(verified).toContain('disabled=""')
  })
  it("enables one handout only with verified goods, exact merchandise and the entered claim", () => {
    const html = renderToStaticMarkup(
      <EventMarketOrganizerPickupForm
        {...props}
        paymentVerified
        historyReady
        claimCode="A-VALID-PICKUP-CODE"
      />
    )
    expect(html).toContain("Fixture apples")
    const handout = html.match(
      /<button\b[^>]*>Confirm code and hand out once<\/button>/
    )?.[0]
    expect(handout).toBeDefined()
    expect(handout).not.toContain('disabled=""')
  })
  it("shows an already recorded handout as exact-delivery retry only", () => {
    const html = renderToStaticMarkup(
      <EventMarketOrganizerPickupForm {...props} paymentVerified handedOut />
    )
    expect(html).toContain("Do not hand these goods out again")
    expect(html).toContain("Retry saved handout update")
    expect(html).not.toContain("Confirm code and hand out once")
  })
})
