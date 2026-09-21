import { DurableObject } from "cloudflare:workers"

import type { CommerceGmvCutoverResolution } from "./commerce-gmv-contract"
import type { PostHogProxyEnv } from "./env"

const UTC_ORDER_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isCanonicalUtcOrderDay(value: string): boolean {
  if (!UTC_ORDER_DATE_PATTERN.test(value)) return false
  const epochMilliseconds = Date.parse(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(epochMilliseconds) &&
    new Date(epochMilliseconds).toISOString().slice(0, 10) === value
  )
}

/**
 * Persists the first activated UTC cutover so later variable removal, edits,
 * or ordinary deployments cannot route a post-cutover day back to the legacy
 * per-order PostHog grain.
 */
export class CommerceGmvCutoverFence extends DurableObject<PostHogProxyEnv> {
  constructor(ctx: DurableObjectState, env: PostHogProxyEnv) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS activation (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          cutover_day TEXT NOT NULL
        );
      `)
    })
  }

  resolve(configuredCutoverDate: string | null): CommerceGmvCutoverResolution {
    if (
      configuredCutoverDate !== null &&
      !isCanonicalUtcOrderDay(configuredCutoverDate)
    ) {
      throw new Error("Invalid commerce GMV cutover date")
    }

    return this.ctx.storage.transactionSync(() => {
      const stored =
        this.ctx.storage.sql
          .exec<{ cutover_day: string }>(
            "SELECT cutover_day FROM activation WHERE singleton = 1"
          )
          .toArray()[0]?.cutover_day ?? null

      if (stored !== null) {
        if (
          configuredCutoverDate !== null &&
          configuredCutoverDate !== stored
        ) {
          return { status: "mismatch" } as const
        }
        return { status: "active", cutoverDate: stored } as const
      }

      if (configuredCutoverDate === null) {
        return { status: "inactive" } as const
      }

      const today = new Date().toISOString().slice(0, 10)
      if (configuredCutoverDate <= today) {
        return { status: "invalid" } as const
      }

      this.ctx.storage.sql.exec(
        "INSERT INTO activation (singleton, cutover_day) VALUES (1, ?)",
        configuredCutoverDate
      )
      return {
        status: "active",
        cutoverDate: configuredCutoverDate,
      } as const
    })
  }
}
