import { env } from "cloudflare:workers"
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CommerceGmvCutoverFence } from "../src/commerce-gmv-cutover"
import {
  type CommerceGmvDailyAggregate,
  getNextSnapshotTime,
  getRetryAlarmTime,
} from "../src/commerce-gmv-daily"
import { SYNTHETIC_POSTHOG_PROJECT_TOKEN } from "./fixtures"

const DAILY_EVENT_UUID = "018f4a00-0000-5abc-8def-0123456789ab"
const FIRST_ORDER_KEY = "018f4a00-1111-5abc-8def-0123456789ab"
const SECOND_ORDER_KEY = "018f4a00-2222-5abc-8def-0123456789ab"

function getToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function getUtcDayOffset(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
}

function getStub(name: string) {
  return env.GMV_DAILY_AGGREGATE.getByName(name)
}

function getCutoverStub(name: string) {
  return env.GMV_CUTOVER_FENCE.getByName(name)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("commerce GMV daily aggregate Durable Object", () => {
  it("latches one immutable cutover across variable removal and edits", async () => {
    const stub = getCutoverStub(`cutover-${crypto.randomUUID()}`)
    const futureCutover = getUtcDayOffset(1)
    const conflictingCutover = getUtcDayOffset(2)

    expect(await stub.resolve(null)).toEqual({ status: "inactive" })
    expect(await stub.resolve(getUtcDayOffset(-1))).toEqual({
      status: "invalid",
    })
    expect(await stub.resolve(getToday())).toEqual({ status: "invalid" })
    expect(await stub.resolve(futureCutover)).toEqual({
      status: "active",
      cutoverDate: futureCutover,
    })
    expect(await stub.resolve(null)).toEqual({
      status: "active",
      cutoverDate: futureCutover,
    })
    expect(await stub.resolve(conflictingCutover)).toEqual({
      status: "mismatch",
    })

    await runInDurableObject(
      stub,
      async (_instance: CommerceGmvCutoverFence, state) => {
        expect(
          state.storage.sql
            .exec<{ cutover_day: string }>(
              "SELECT cutover_day FROM activation WHERE singleton = 1"
            )
            .one()
        ).toEqual({ cutover_day: futureCutover })
      }
    )
  })

  it("waits until 12 hours after day close and batches later updates", () => {
    expect(
      getNextSnapshotTime("2026-09-20", Date.parse("2026-09-20T18:00:00.000Z"))
    ).toBe(Date.parse("2026-09-21T12:00:00.000Z"))
    expect(
      getNextSnapshotTime("2026-09-20", Date.parse("2026-09-21T13:00:00.000Z"))
    ).toBe(Date.parse("2026-09-22T00:00:00.000Z"))
  })

  it("stores one opaque dedupe key per order and keeps only the first estimate", async () => {
    const stub = getStub(`dedupe-${crypto.randomUUID()}`)
    const orderDay = getToday()

    expect(
      await stub.observe({
        orderDay,
        opaqueOrderKey: FIRST_ORDER_KEY,
        dailyEventUuid: DAILY_EVENT_UUID,
        estimatedGmvSats: 42,
      })
    ).toEqual({ status: "accepted" })
    expect(
      await stub.observe({
        orderDay,
        opaqueOrderKey: FIRST_ORDER_KEY,
        dailyEventUuid: DAILY_EVENT_UUID,
        estimatedGmvSats: 999,
      })
    ).toEqual({ status: "duplicate" })
    expect(
      await stub.observe({
        orderDay,
        opaqueOrderKey: SECOND_ORDER_KEY,
        dailyEventUuid: DAILY_EVENT_UUID,
        estimatedGmvSats: 58,
      })
    ).toEqual({ status: "accepted" })

    await runInDurableObject(
      stub,
      async (_instance: CommerceGmvDailyAggregate, state) => {
        const aggregate = state.storage.sql
          .exec<{ revision: number; total_sats: number }>(
            "SELECT revision, total_sats FROM aggregate WHERE singleton = 1"
          )
          .one()
        expect(aggregate).toEqual({ revision: 2, total_sats: 100 })

        const seenOrders = state.storage.sql
          .exec<{ opaque_order_key: string }>(
            "SELECT opaque_order_key FROM seen_orders ORDER BY opaque_order_key"
          )
          .toArray()
        expect(seenOrders).toEqual([
          { opaque_order_key: FIRST_ORDER_KEY },
          { opaque_order_key: SECOND_ORDER_KEY },
        ])

        const storedColumns = state.storage.sql
          .exec<{ name: string }>("PRAGMA table_info(seen_orders)")
          .toArray()
          .map(({ name }) => name)
        expect(storedColumns).toEqual(["opaque_order_key"])
      }
    )
  })

  it("keeps the latest daily total under first-event-wins provider deduplication", async () => {
    const stub = getStub(`snapshot-${crypto.randomUUID()}`)
    const orderDay = getToday()
    const payloads: Record<string, unknown>[] = []
    const providerEvents = new Map<string, Record<string, unknown>>()
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      const payload = (await (request as Request).json()) as Record<
        string,
        unknown
      >
      payloads.push(payload)
      const uuid = payload.uuid as string
      if (!providerEvents.has(uuid)) providerEvents.set(uuid, payload)
      return new Response("ok", { status: 200 })
    })

    await stub.observe({
      orderDay,
      opaqueOrderKey: FIRST_ORDER_KEY,
      dailyEventUuid: DAILY_EVENT_UUID,
      estimatedGmvSats: 42,
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    await stub.observe({
      orderDay,
      opaqueOrderKey: SECOND_ORDER_KEY,
      dailyEventUuid: DAILY_EVENT_UUID,
      estimatedGmvSats: 58,
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    expect(payloads).toHaveLength(2)
    for (const payload of payloads) {
      expect(payload).toEqual({
        api_key: SYNTHETIC_POSTHOG_PROJECT_TOKEN,
        event: "commerce_gmv_estimated_daily",
        distinct_id: "conduit-commerce-gmv-estimate-daily",
        uuid: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        timestamp: `${orderDay}T00:00:00.000Z`,
        properties: {
          $process_person_profile: false,
          estimated_gmv_sats: expect.any(Number),
        },
      })
    }
    expect(payloads[0]!.uuid).not.toBe(DAILY_EVENT_UUID)
    expect(payloads[1]!.uuid).not.toBe(payloads[0]!.uuid)
    expect(
      Array.from(providerEvents.values()).map(
        (payload) =>
          (payload.properties as { estimated_gmv_sats: number })
            .estimated_gmv_sats
      )
    ).toEqual([42, 100])
    expect(
      Math.max(
        ...Array.from(providerEvents.values()).map(
          (payload) =>
            (payload.properties as { estimated_gmv_sats: number })
              .estimated_gmv_sats
        )
      )
    ).toBe(100)
    expect(JSON.stringify(payloads)).not.toContain(FIRST_ORDER_KEY)
    expect(JSON.stringify(payloads)).not.toContain(SECOND_ORDER_KEY)
  })

  it("atomically collapses concurrent shopper and merchant observations", async () => {
    const stub = getStub(`concurrent-${crypto.randomUUID()}`)
    const observation = {
      orderDay: getToday(),
      opaqueOrderKey: FIRST_ORDER_KEY,
      dailyEventUuid: DAILY_EVENT_UUID,
      estimatedGmvSats: 42,
    }

    const results = await Promise.all(
      Array.from({ length: 8 }, () => stub.observe(observation))
    )
    expect(results.filter(({ status }) => status === "accepted")).toHaveLength(
      1
    )
    expect(results.filter(({ status }) => status === "duplicate")).toHaveLength(
      7
    )

    await runInDurableObject(
      stub,
      async (_instance: CommerceGmvDailyAggregate, state) => {
        expect(
          state.storage.sql
            .exec<{ revision: number; total_sats: number }>(
              "SELECT revision, total_sats FROM aggregate WHERE singleton = 1"
            )
            .one()
        ).toEqual({ revision: 1, total_sats: 42 })
      }
    )
  })

  it("retries a frozen snapshot before batching later revisions", async () => {
    const stub = getStub(`retry-${crypto.randomUUID()}`)
    const payloads: Array<{
      uuid: string
      properties: { estimated_gmv_sats: number }
    }> = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      payloads.push(
        (await (request as Request).json()) as {
          uuid: string
          properties: { estimated_gmv_sats: number }
        }
      )
      return new Response(payloads.length === 1 ? "unavailable" : "ok", {
        status: payloads.length === 1 ? 503 : 200,
      })
    })

    await stub.observe({
      orderDay: getToday(),
      opaqueOrderKey: FIRST_ORDER_KEY,
      dailyEventUuid: DAILY_EVENT_UUID,
      estimatedGmvSats: 42,
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    await stub.observe({
      orderDay: getToday(),
      opaqueOrderKey: SECOND_ORDER_KEY,
      dailyEventUuid: DAILY_EVENT_UUID,
      estimatedGmvSats: 58,
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    await runInDurableObject(
      stub,
      async (_instance: CommerceGmvDailyAggregate, state) => {
        const aggregate = state.storage.sql
          .exec<{
            flushed_revision: number
            pending_revision: number | null
            revision: number
          }>(
            `SELECT flushed_revision, pending_revision, revision
             FROM aggregate WHERE singleton = 1`
          )
          .one()
        expect(aggregate).toEqual({
          flushed_revision: 1,
          pending_revision: null,
          revision: 2,
        })
        expect(await state.storage.getAlarm()).not.toBeNull()
      }
    )

    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(
      payloads.map((payload) => payload.properties.estimated_gmv_sats)
    ).toEqual([42, 42, 100])
    expect(payloads[0]!.uuid).toBe(payloads[1]!.uuid)
    expect(payloads[2]!.uuid).not.toBe(payloads[1]!.uuid)
  })

  it("deletes active dedupe state at expiry even if the final snapshot fails", async () => {
    const stub = getStub(`expiry-${crypto.randomUUID()}`)
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unavailable", { status: 503 })
    )

    await stub.observe({
      orderDay: getToday(),
      opaqueOrderKey: FIRST_ORDER_KEY,
      dailyEventUuid: DAILY_EVENT_UUID,
      estimatedGmvSats: 42,
    })
    await runInDurableObject(
      stub,
      async (_instance: CommerceGmvDailyAggregate, state) => {
        state.storage.sql.exec(
          "UPDATE aggregate SET order_day = '2026-01-01' WHERE singleton = 1"
        )
        await state.storage.setAlarm(Date.now() + 1_000)
      }
    )
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    await runInDurableObject(
      stub,
      async (_instance: CommerceGmvDailyAggregate, state) => {
        const userTables = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"
          )
          .toArray()
        expect(userTables).toEqual([])
        expect(await state.storage.getAlarm()).toBeNull()
      }
    )
  })

  it("never schedules a failed delivery retry past the retention deadline", async () => {
    const stub = getStub(`expiry-retry-${crypto.randomUUID()}`)
    const beforeExpiry = Date.parse("2026-01-31T23:56:00.000Z")
    const expirationTime = Date.parse("2026-02-01T00:00:00.000Z")
    expect(getRetryAlarmTime("2026-01-01", beforeExpiry)).toBe(expirationTime)
    expect(getRetryAlarmTime("2026-01-01", expirationTime)).toBeNull()

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unavailable", { status: 503 })
    )

    await stub.observe({
      orderDay: getToday(),
      opaqueOrderKey: FIRST_ORDER_KEY,
      dailyEventUuid: DAILY_EVENT_UUID,
      estimatedGmvSats: 42,
    })

    await runInDurableObject(
      stub,
      async (instance: CommerceGmvDailyAggregate, state) => {
        state.storage.sql.exec(
          "UPDATE aggregate SET order_day = '2026-01-01' WHERE singleton = 1"
        )
        await instance.alarm()
        const userTables = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'"
          )
          .toArray()
        expect(userTables).toEqual([])
        expect(await state.storage.getAlarm()).toBeNull()
      }
    )
  })
})
