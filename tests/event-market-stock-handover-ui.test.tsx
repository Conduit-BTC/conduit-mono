import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { getPublicKey, generateSecretKey } from "nostr-tools/pure"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import {
  buildEventMarketAssignmentDraft,
  computeEventMarketAssignmentDTag,
} from "@conduit/core/protocol/event-market-assignment"
import { commitOrganizerStockOrder } from "@conduit/core/protocol/event-market-stock-journal"
import { registerOrganizerStockWriterDevice } from "@conduit/core/protocol/event-market-stock-writer-handover"
import { SessionSigner } from "@conduit/core/protocol/session-signer"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import { receiveOrganizerStockGrant } from "@conduit/core/protocol/event-market-stock-workflow"
import { sameOrganizerStockRumor } from "@conduit/core/protocol/event-market-stock-import-authority"
import {
  admitPublicEvent,
  createEventMarketStockAuthorityRumor,
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
  confirmOrganizerStockDeviceRegistration,
  createOrganizerStockDevice,
  prepareOrganizerStockTargetDevice,
  readOrganizerStockDevice,
  receiveOrganizerStockGrantOnDevice,
  reserveOrganizerStockInstallation,
  stockPoolBelongsToOccurrence,
} from "../apps/merchant/src/lib/event-market-stock-handover"
import {
  checkoutSparkEventMarketFixture,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"

function memoryStorage(onSave?: (value: string) => void) {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
      onSave?.(value)
    },
  }
}
const installationDatabases: ConduitDB[] = []
const installationClockRestores: (() => void)[] = []
afterEach(async () => {
  for (const restore of installationClockRestores.splice(0)) restore()
  for (const database of installationDatabases.splice(0))
    await database.delete()
})
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

async function deviceInstallationFixture(priorCohort = false) {
  const clock = spyOn(Date, "now").mockReturnValue(AT + 10)
  installationClockRestores.push(() => clock.mockRestore())
  const f = await grantFixture()
  const grant = parseEventMarketStockAuthorityRumor(f.rumor)
  if (grant.type !== "grant") throw new Error("Expected stock grant")
  async function packet(newProduct = false) {
    let rumor = f.rumor
    if (newProduct) {
      const productDTag = crypto.randomUUID()
      const productCoordinate = `30402:${f.merchantPubkey}:${productDTag}`
      const product = f.signMerchant({
        kind: 30402,
        created_at: AT / 1_000 - 1,
        content: "",
        tags: [
          ["d", productDTag],
          ["title", "Stock item"],
          ["type", "simple", "physical"],
          ["price", "1", "SATS"],
          ["stock", "10"],
        ],
      })
      const baseline = f.signMerchant({
        ...buildEventMarketAssignmentDraft({
          merchantPubkey: f.merchantPubkey,
          marketCoordinate: grant.marketCoordinate,
          occurrenceCoordinate: grant.occurrenceCoordinate,
          productCoordinate,
          state: "active",
          inventory: { mode: "tracked", quantity: 5 },
          fulfillmentMethods: ["pickup"],
        }),
        created_at: AT / 1_000 - 1,
      })
      rumor = createEventMarketStockAuthorityRumor({
        createdAt: AT / 1_000,
        payload: {
          ...grant,
          nonce: crypto.randomUUID(),
          productCoordinate,
          assignmentCoordinate: `30410:${f.merchantPubkey}:${computeEventMarketAssignmentDTag({ productCoordinate, marketCoordinate: grant.marketCoordinate, occurrenceCoordinate: grant.occurrenceCoordinate })}`,
          productEventId: product.id,
          assignmentEventId: baseline.id,
        },
      })
    }
    const terms = parseEventMarketStockAuthorityRumor(rumor)
    if (terms.type !== "grant") throw new Error("Expected stock grant")
    const commitment = f.signMerchant({
      ...buildEventMarketAssignmentDraft({
        merchantPubkey: f.merchantPubkey,
        marketCoordinate: terms.marketCoordinate,
        occurrenceCoordinate: terms.occurrenceCoordinate,
        productCoordinate: terms.productCoordinate,
        state: "active",
        inventory: { mode: "tracked", quantity: 5 },
        fulfillmentMethods: ["pickup"],
        previousEventId: terms.assignmentEventId,
        organizerStockPool: {
          state: "active",
          poolId: rumor.id,
          organizerPubkey: f.organizerPubkey,
          quantity: terms.quantity,
          importedQuantity: 0,
        },
      }),
      created_at: AT / 1_000,
    })
    return {
      rumor,
      commitment,
      envelope: await wrapPrivateMessage(
        rumor,
        { pubkey: f.organizerPubkey },
        f.merchantSigner
      ),
    }
  }
  const db = new ConduitDB(`stock-ui-retry-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  installationDatabases.push(db)
  let active = true
  let afterSave: (() => void) | undefined
  let beforeDecrypt: (() => Promise<void>) | undefined
  let decryptCalls = 0
  const storage = memoryStorage(() => afterSave?.())
  const device = {
    storage,
    account: f.organizerPubkey,
    market: f.market.coordinate,
  }
  createOrganizerStockDevice({
    ...device,
    hasRetainedPools: false,
    randomUUID: () => f.writerId,
  })
  const provider = {
    ...f.organizerSigner,
    decryptNip44: async (peer: string, ciphertext: string) => {
      decryptCalls++
      // Two opens authenticate the target; an intact prior cohort adds two
      // more. Interleave during the second target open, after verification's
      // final read-only CAS and before the atomic installation check.
      if (decryptCalls === (priorCohort ? 5 : 3) && beforeDecrypt) {
        const hook = beforeDecrypt
        beforeDecrypt = undefined
        await hook()
      }
      return f.organizerSigner.decryptNip44(peer, ciphertext)
    },
  }
  const makeSigner = () =>
    new SessionSigner(provider, {
      expectedPubkey: f.organizerPubkey,
      revision: "stock-ui-install-test",
      authMethod: "nip07",
      getCapabilities: () => ({
        signEvent: true,
        nip44: true,
        nip04Decrypt: true,
      }),
      hasAuthority: () => active,
    })
  let sessionSigner = makeSigner()
  await registerOrganizerStockWriterDevice({
    db,
    signer: sessionSigner,
    authenticatedPubkey: f.organizerPubkey,
    shouldContinue: () => true,
    marketCoordinate: f.market.coordinate,
    writerId: f.writerId,
    deviceId: f.writerId,
    expectedPoolIds: [],
  })
  const confirmed = await confirmOrganizerStockDeviceRegistration({
    ...device,
    db,
    expectedDeviceId: f.writerId,
    shouldContinue: () => true,
  })
  expect(confirmed.writerId === f.writerId).toBe(true)
  type Packet = Awaited<ReturnType<typeof packet>>
  const receiveInput = (target: Packet) => ({
    db,
    signer: sessionSigner,
    authenticatedPubkey: f.organizerPubkey,
    expectedWriterId: f.writerId,
    grantEnvelope: target.envelope,
    committedAssignmentEvent: target.commitment,
    shouldContinue: () => active,
    nowMs: AT + 1,
  })
  const receive = (
    target: Packet,
    override: Partial<
      Pick<
        Parameters<typeof receiveOrganizerStockGrantOnDevice>[0],
        "expectedDeviceId"
      >
    > = {}
  ) =>
    receiveOrganizerStockGrantOnDevice({
      ...receiveInput(target),
      storage,
      marketCoordinate: f.market.coordinate,
      expectedDeviceId: f.writerId,
      ...override,
    })
  const original = await packet()
  if (priorCohort) {
    await receive(original)
    const saved = (await db.eventMarketOrganizerStockPools.get(
      `${f.organizerPubkey}:${original.rumor.id}`
    ))!
    // An intact earlier journal can retain the exact NIP-01 event with a
    // different outer object order from the freshly decrypted representation.
    const { kind, pubkey, created_at, tags, content, id } = saved.grantRumor
    const reordered = { kind, pubkey, created_at, tags, content, id }
    expect(sameOrganizerStockRumor(saved.grantRumor, reordered)).toBe(true)
    expect(JSON.stringify(saved.grantRumor) === JSON.stringify(reordered)).toBe(
      false
    )
    await db.eventMarketOrganizerStockPools.put({
      ...saved,
      grantRumor: reordered,
    })
    await commitOrganizerStockOrder({
      db,
      authenticatedPubkey: f.organizerPubkey,
      orderId: crypto.randomUUID(),
      identityBinding: hash(),
      termsBinding: hash(),
      claimRef: hash(),
      evidence: "controlled stock-order evidence",
      entries: [
        { poolId: original.rumor.id, writerId: f.writerId, quantity: 1 },
      ],
      shouldContinue: () => active,
      nowMs: AT + 1,
    })
  }
  const target = priorCohort ? await packet(true) : original
  const registrationKey = `${f.organizerPubkey}:${f.market.coordinate}`
  const writer =
    (await db.eventMarketOrganizerStockWriters.get(registrationKey))!
  const localKey = `conduit:event-stock-device:1:${f.organizerPubkey}:${f.market.coordinate}`
  const local = readOrganizerStockDevice(
    storage,
    f.organizerPubkey,
    f.market.coordinate
  )!
  const abort = async () => {
    afterSave = () => {
      afterSave = undefined
      active = false
    }
    await expect(receive(target)).rejects.toBeInstanceOf(Error)
    expect(
      await db.eventMarketOrganizerStockPools.get(
        `${f.organizerPubkey}:${target.rumor.id}`
      )
    ).toBeUndefined()
    expect(
      readOrganizerStockDevice(
        storage,
        f.organizerPubkey,
        f.market.coordinate
      )!.installedPoolIds.includes(target.rumor.id)
    ).toBe(true)
    active = true
    sessionSigner = makeSigner()
  }
  return {
    f,
    db,
    storage,
    device,
    packet,
    target,
    original,
    writer,
    local,
    localKey,
    registrationKey,
    receive,
    receiveInput,
    abort,
    interleave: (hook: () => Promise<void>) => {
      decryptCalls = 0
      beforeDecrypt = hook
    },
  }
}

describe("explicit organizer device handover", () => {
  for (const prior of [false, true])
    it(`precommit-stock-installation retries with ${prior ? "an intact accepted prior cohort" : "an empty registered cohort"}`, async () => {
      const f = await deviceInstallationFixture(prior)
      const poolsBefore = await f.db.eventMarketOrganizerStockPools.toArray()
      const entriesBefore =
        await f.db.eventMarketOrganizerStockEntries.toArray()
      await f.abort()
      const received = await f.receive(f.target)
      expect(received.poolId === f.target.rumor.id).toBe(true)
      expect(received.state).toBe("active")
      expect(received.acceptedQuantity).toBe(0)
      expect(await f.db.eventMarketOrganizerStockPools.count()).toBe(
        poolsBefore.length + 1
      )
      expect((await f.receive(f.target)).poolId === received.poolId).toBe(true)
      expect(
        JSON.stringify(
          await f.db.eventMarketOrganizerStockEntries.toArray()
        ) === JSON.stringify(entriesBefore)
      ).toBe(true)
      if (prior)
        expect(
          JSON.stringify(
            await f.db.eventMarketOrganizerStockPools.get(poolsBefore[0]!.id)
          ) === JSON.stringify(poolsBefore[0])
        ).toBe(true)
    })
  it("precommit-stock-installation keeps missing, retired, target, wrong-device, generation and legacy authorities blocked", async () => {
    const f = await deviceInstallationFixture()
    await f.abort()
    const blocked = async () => {
      await expect(f.receive(f.target)).rejects.toBeInstanceOf(Error)
      expect(await f.db.eventMarketOrganizerStockPools.count()).toBe(0)
    }
    await f.db.eventMarketOrganizerStockWriters.delete(f.registrationKey)
    await blocked()
    for (const row of [
      { ...f.writer, state: "retired" as const },
      { ...f.writer, state: "target" as const },
      { ...f.writer, deviceId: crypto.randomUUID() },
      { ...f.writer, generation: 1 },
    ]) {
      await f.db.eventMarketOrganizerStockWriters.put(row)
      await blocked()
    }
    await f.db.eventMarketOrganizerStockWriters.put(f.writer)
    await expect(
      f.receive(f.target, { expectedDeviceId: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(Error)
    const pending = readOrganizerStockDevice(
      f.storage,
      f.f.organizerPubkey,
      f.f.market.coordinate
    )!
    f.storage.setItem(
      f.localKey,
      JSON.stringify({
        version: 1,
        writerId: pending.writerId,
        installedPoolIds: pending.installedPoolIds,
      })
    )
    await blocked()
  })
  it("precommit-stock-installation does not repair a lost installed pool, incomplete prefix or extra local marker", async () => {
    const f = await deviceInstallationFixture(true)
    await f.abort()
    const before = (await f.db.eventMarketOrganizerStockPools.get(
      `${f.f.organizerPubkey}:${f.original.rumor.id}`
    ))!
    const entry = (await f.db.eventMarketOrganizerStockEntries.toArray())[0]!
    const blocked = async () => {
      await expect(f.receive(f.target)).rejects.toBeInstanceOf(Error)
      expect(
        await f.db.eventMarketOrganizerStockPools.get(
          `${f.f.organizerPubkey}:${f.target.rumor.id}`
        )
      ).toBeUndefined()
    }
    await f.db.eventMarketOrganizerStockPools.delete(before.id)
    await blocked()
    await f.db.eventMarketOrganizerStockPools.put(before)
    await f.db.eventMarketOrganizerStockEntries.delete(entry.id)
    await blocked()
    await f.db.eventMarketOrganizerStockEntries.put(entry)
    const pending = readOrganizerStockDevice(
      f.storage,
      f.f.organizerPubkey,
      f.f.market.coordinate
    )!
    f.storage.setItem(
      f.localKey,
      JSON.stringify({
        ...pending,
        installedPoolIds: [...pending.installedPoolIds, hash()],
      })
    )
    await blocked()
    expect(
      JSON.stringify(
        await f.db.eventMarketOrganizerStockPools.get(before.id)
      ) === JSON.stringify(before)
    ).toBe(true)
    expect(
      JSON.stringify(await f.db.eventMarketOrganizerStockEntries.toArray()) ===
        JSON.stringify([entry])
    ).toBe(true)
  })
  it("precommit-stock-installation rejects a registration that changes after exact pending verification", async () => {
    const f = await deviceInstallationFixture(true)
    await f.abort()
    const concurrent = await f.packet(true)
    let interleaved = false
    f.interleave(async () => {
      interleaved = true
      await receiveOrganizerStockGrant({
        ...f.receiveInput(concurrent),
        signer: new SessionSigner(f.f.organizerSigner, {
          expectedPubkey: f.f.organizerPubkey,
          revision: "concurrent-stock-install-test",
          authMethod: "nip07",
          getCapabilities: () => ({
            signEvent: true,
            nip44: true,
            nip04Decrypt: true,
          }),
          hasAuthority: () => true,
        }),
      })
    })
    await expect(f.receive(f.target)).rejects.toThrow(
      "The verified stock writer registration changed."
    )
    expect(interleaved).toBe(true)
    expect(
      await f.db.eventMarketOrganizerStockPools.get(
        `${f.f.organizerPubkey}:${f.target.rumor.id}`
      )
    ).toBeUndefined()
    expect(
      (
        await f.db.eventMarketOrganizerStockPools.get(
          `${f.f.organizerPubkey}:${concurrent.rumor.id}`
        )
      )?.state
    ).toBe("active")
  })
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
