import { DurableObject } from "cloudflare:workers"

import {
  GMV_DEDUPE_RETENTION_DAYS,
  MAX_ESTIMATED_GMV_SATS,
  type CommerceGmvDailyObservation,
  type CommerceGmvDailyObservationResult,
} from "./commerce-gmv-contract"
import type { PostHogProxyEnv } from "./env"

const POSTHOG_INGEST_URL = "https://us.i.posthog.com/i/v0/e/?ip=0"
const POSTHOG_PROJECT_TOKEN_PATTERN = /^phc_[A-Za-z0-9]{16,64}$/
const POSTHOG_GMV_DAILY_DISTINCT_ID = "conduit-commerce-gmv-estimate-daily"
const GMV_DAILY_EVENT_NAME = "commerce_gmv_estimated_daily"
const GMV_DAILY_SNAPSHOT_ID_DOMAIN =
  "conduit-commerce-gmv-estimate.daily-snapshot.v1"
const UTC_ORDER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const OPAQUE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const SNAPSHOT_INTERVAL_MS = 12 * 60 * 60 * 1000
const RETRY_FLUSH_DELAY_MS = 5 * 60 * 1000

type AggregateRow = {
  order_day: string
  daily_event_uuid: string
  total_sats: number
  revision: number
  flushed_revision: number
  pending_revision: number | null
  pending_total_sats: number | null
}

type DailySnapshot = {
  order_day: string
  daily_event_uuid: string
  total_sats: number
  revision: number
}

function isCanonicalUtcOrderDay(value: string): boolean {
  if (!UTC_ORDER_DATE_PATTERN.test(value)) return false
  const epochMilliseconds = Date.parse(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(epochMilliseconds) &&
    new Date(epochMilliseconds).toISOString().slice(0, 10) === value
  )
}

function getExpirationTime(orderDay: string): number {
  const orderDayStart = Date.parse(`${orderDay}T00:00:00.000Z`)
  return orderDayStart + (GMV_DEDUPE_RETENTION_DAYS + 1) * MILLISECONDS_PER_DAY
}

export function getNextSnapshotTime(
  orderDay: string,
  now = Date.now()
): number {
  const orderDayStart = Date.parse(`${orderDay}T00:00:00.000Z`)
  const firstSnapshotTime = orderDayStart + MILLISECONDS_PER_DAY * 1.5
  if (now < firstSnapshotTime) return firstSnapshotTime

  return (
    Math.floor(now / SNAPSHOT_INTERVAL_MS) * SNAPSHOT_INTERVAL_MS +
    SNAPSHOT_INTERVAL_MS
  )
}

export function getRetryAlarmTime(
  orderDay: string,
  now = Date.now()
): number | null {
  const expirationTime = getExpirationTime(orderDay)
  if (now >= expirationTime) return null
  return Math.min(now + RETRY_FLUSH_DELAY_MS, expirationTime)
}

function isValidObservation(observation: CommerceGmvDailyObservation): boolean {
  return (
    isCanonicalUtcOrderDay(observation.orderDay) &&
    OPAQUE_UUID_PATTERN.test(observation.opaqueOrderKey) &&
    OPAQUE_UUID_PATTERN.test(observation.dailyEventUuid) &&
    Number.isSafeInteger(observation.estimatedGmvSats) &&
    observation.estimatedGmvSats > 0 &&
    observation.estimatedGmvSats <= MAX_ESTIMATED_GMV_SATS
  )
}

function bytesToUuid(bytes: Uint8Array): string {
  const value = bytes.slice(0, 16)
  value[6] = (value[6]! & 0x0f) | 0x50
  value[8] = (value[8]! & 0x3f) | 0x80
  const hex = Array.from(value, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function getSnapshotEventUuid(snapshot: DailySnapshot): Promise<string> {
  const input = new TextEncoder().encode(
    `${GMV_DAILY_SNAPSHOT_ID_DOMAIN}:${snapshot.daily_event_uuid}:${snapshot.revision}`
  )
  const digest = await crypto.subtle.digest("SHA-256", input)
  return bytesToUuid(new Uint8Array(digest))
}

export class CommerceGmvDailyAggregate extends DurableObject<PostHogProxyEnv> {
  constructor(ctx: DurableObjectState, env: PostHogProxyEnv) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS aggregate (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          order_day TEXT NOT NULL,
          daily_event_uuid TEXT NOT NULL,
          total_sats INTEGER NOT NULL CHECK (total_sats >= 0),
          revision INTEGER NOT NULL CHECK (revision >= 0),
          flushed_revision INTEGER NOT NULL CHECK (flushed_revision >= 0),
          pending_revision INTEGER,
          pending_total_sats INTEGER,
          CHECK (flushed_revision <= revision),
          CHECK (
            (pending_revision IS NULL AND pending_total_sats IS NULL) OR
            (
              pending_revision > flushed_revision AND
              pending_revision <= revision AND
              pending_total_sats > 0
            )
          )
        );
        CREATE TABLE IF NOT EXISTS seen_orders (
          opaque_order_key TEXT PRIMARY KEY
        );
      `)
    })
  }

  async observe(
    observation: CommerceGmvDailyObservation
  ): Promise<CommerceGmvDailyObservationResult> {
    if (!isValidObservation(observation)) {
      throw new Error("Invalid commerce GMV observation")
    }
    if (Date.now() >= getExpirationTime(observation.orderDay)) {
      return { status: "expired" }
    }

    const result = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO aggregate (
          singleton,
          order_day,
          daily_event_uuid,
          total_sats,
          revision,
          flushed_revision,
          pending_revision,
          pending_total_sats
        ) VALUES (1, ?, ?, 0, 0, 0, NULL, NULL)`,
        observation.orderDay,
        observation.dailyEventUuid
      )

      const aggregate = this.getAggregate()
      if (
        !aggregate ||
        aggregate.order_day !== observation.orderDay ||
        aggregate.daily_event_uuid !== observation.dailyEventUuid
      ) {
        throw new Error("Commerce GMV aggregate identity mismatch")
      }

      const insert = this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO seen_orders (opaque_order_key) VALUES (?)",
        observation.opaqueOrderKey
      )
      if (insert.rowsWritten === 0) {
        return { status: "duplicate" } as const
      }
      if (
        aggregate.total_sats >
        MAX_ESTIMATED_GMV_SATS - observation.estimatedGmvSats
      ) {
        throw new Error("Commerce GMV daily total exceeds the safe maximum")
      }

      this.ctx.storage.sql.exec(
        `UPDATE aggregate
         SET total_sats = total_sats + ?, revision = revision + 1
         WHERE singleton = 1`,
        observation.estimatedGmvSats
      )
      return { status: "accepted" } as const
    })

    const aggregate = this.getAggregate()
    if (aggregate && aggregate.flushed_revision < aggregate.revision) {
      await this.scheduleEarlier(
        getNextSnapshotTime(aggregate.order_day, Date.now())
      )
    }

    return result
  }

  async alarm(): Promise<void> {
    try {
      await this.flushAndSchedule()
    } catch {
      const aggregate = this.getAggregate()
      if (!aggregate) {
        await this.deleteStorage()
        return
      }

      const retryTime = getRetryAlarmTime(aggregate.order_day)
      if (retryTime === null) {
        await this.deleteStorage()
        return
      }

      await this.ctx.storage.setAlarm(retryTime)
    }
  }

  private getAggregate(): AggregateRow | null {
    return (
      this.ctx.storage.sql
        .exec<AggregateRow>(
          `SELECT
             order_day,
             daily_event_uuid,
             total_sats,
             revision,
             flushed_revision,
             pending_revision,
             pending_total_sats
           FROM aggregate
           WHERE singleton = 1`
        )
        .toArray()[0] ?? null
    )
  }

  private async flushAndSchedule(): Promise<void> {
    const aggregate = this.getAggregate()
    if (!aggregate) {
      await this.deleteStorage()
      return
    }

    const expirationTime = getExpirationTime(aggregate.order_day)
    if (Date.now() >= expirationTime) {
      if (aggregate.flushed_revision < aggregate.revision) {
        try {
          await this.flushSnapshot(aggregate)
        } catch {
          // Retention is the hard boundary. A final provider failure may
          // undercount the estimate, but must not extend per-order state.
        }
      }
      await this.deleteStorage()
      return
    }

    const pending = this.getOrCreatePendingSnapshot()
    if (pending) {
      await this.flushSnapshot(pending)
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `UPDATE aggregate
           SET
             flushed_revision = MAX(flushed_revision, ?),
             pending_revision = NULL,
             pending_total_sats = NULL
           WHERE singleton = 1 AND pending_revision = ?`,
          pending.revision,
          pending.revision
        )
      })
    }

    const current = this.getAggregate()
    if (!current) {
      await this.deleteStorage()
      return
    }
    if (current.flushed_revision < current.revision) {
      await this.ctx.storage.setAlarm(
        getNextSnapshotTime(current.order_day, Date.now())
      )
      return
    }

    await this.ctx.storage.setAlarm(expirationTime)
  }

  private getOrCreatePendingSnapshot(): DailySnapshot | null {
    return this.ctx.storage.transactionSync(() => {
      let aggregate = this.getAggregate()
      if (!aggregate || aggregate.flushed_revision >= aggregate.revision) {
        return null
      }

      if (
        aggregate.pending_revision === null ||
        aggregate.pending_total_sats === null
      ) {
        this.ctx.storage.sql.exec(
          `UPDATE aggregate
           SET pending_revision = revision, pending_total_sats = total_sats
           WHERE singleton = 1 AND pending_revision IS NULL`
        )
        aggregate = this.getAggregate()
      }

      if (
        !aggregate ||
        aggregate.pending_revision === null ||
        aggregate.pending_total_sats === null
      ) {
        throw new Error("Commerce GMV pending snapshot is unavailable")
      }

      return {
        order_day: aggregate.order_day,
        daily_event_uuid: aggregate.daily_event_uuid,
        total_sats: aggregate.pending_total_sats,
        revision: aggregate.pending_revision,
      }
    })
  }

  private async flushSnapshot(snapshot: DailySnapshot): Promise<void> {
    const projectToken = this.env.POSTHOG_PROJECT_TOKEN?.trim() ?? ""
    if (!POSTHOG_PROJECT_TOKEN_PATTERN.test(projectToken)) {
      throw new Error("Commerce GMV telemetry is unavailable")
    }

    const snapshotEventUuid = await getSnapshotEventUuid(snapshot)
    const response = await fetch(
      new Request(POSTHOG_INGEST_URL, {
        method: "POST",
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          api_key: projectToken,
          event: GMV_DAILY_EVENT_NAME,
          distinct_id: POSTHOG_GMV_DAILY_DISTINCT_ID,
          uuid: snapshotEventUuid,
          timestamp: `${snapshot.order_day}T00:00:00.000Z`,
          properties: {
            $process_person_profile: false,
            estimated_gmv_sats: snapshot.total_sats,
          },
        }),
        redirect: "manual",
      })
    )
    if (!response.ok) {
      throw new Error("PostHog rejected the commerce GMV daily snapshot")
    }
  }

  private async scheduleEarlier(scheduledTime: number): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm()
    if (currentAlarm === null || scheduledTime < currentAlarm) {
      await this.ctx.storage.setAlarm(scheduledTime)
    }
  }

  private async deleteStorage(): Promise<void> {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }
}
