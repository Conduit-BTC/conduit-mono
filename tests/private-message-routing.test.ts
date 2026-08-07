import { beforeEach, describe, expect, it } from "bun:test"
import {
  __resetInboxDeclarationCache,
  deriveInboxReadCoverage,
  EVENT_KINDS,
  getCachedInboxDeclaration,
  invalidateInboxDeclaration,
  planInboxReadRelays,
  primeInboxDeclarationCache,
  resolveInboxDeclaration,
  selectPrivateMessageDeliveryRoute,
  type InboxDeclarationResolution,
} from "@conduit/core"

const OWNER = "owner"

function declarationEvent(params: {
  pubkey?: string
  createdAt: number
  id?: string
  relays: string[]
}) {
  return {
    id: params.id ?? `event-${params.createdAt}`,
    kind: EVENT_KINDS.PRIVATE_MESSAGE_RELAYS,
    pubkey: params.pubkey ?? OWNER,
    created_at: params.createdAt,
    tags: params.relays.map((url) => ["relay", url]),
  }
}

function diagnostics(params: {
  events?: unknown[]
  successful: string[]
  failed?: string[]
}) {
  return async () => ({
    events: (params.events ?? []) as never,
    attemptedRelayUrls: [...params.successful, ...(params.failed ?? [])],
    successfulRelayUrls: params.successful,
    failedRelayUrls: params.failed ?? [],
  })
}

function resolution(
  overrides: Partial<InboxDeclarationResolution>
): InboxDeclarationResolution {
  return {
    pubkey: OWNER,
    state: "declared",
    relayUrls: ["wss://inbox.example"],
    stale: false,
    fetchedAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  __resetInboxDeclarationCache()
})

describe("resolveInboxDeclaration", () => {
  it("resolves a declared inbox with secure relays only", async () => {
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            createdAt: 100,
            relays: ["wss://inbox.example", "ws://insecure.example"],
          }),
        ],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("declared")
    expect(result.relayUrls).toEqual(["wss://inbox.example"])
    expect(result.stale).toBe(false)
  })

  it("never reports not_declared when every discovery relay failed", async () => {
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        successful: [],
        failed: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("lookup_unavailable")
  })

  it("keeps an empty partial lookup partial", async () => {
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://a.example", "wss://b.example"],
      fetchEventsWithDiagnostics: diagnostics({
        successful: ["wss://a.example"],
        failed: ["wss://b.example"],
      }),
    })

    expect(result.state).toBe("lookup_partial")
  })

  it("reports not_declared only with complete empty coverage", async () => {
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("not_declared")
  })

  it("selects the newest declaration deterministically", async () => {
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            createdAt: 100,
            id: "older",
            relays: ["wss://old.example"],
          }),
          declarationEvent({
            createdAt: 200,
            id: "tie-a",
            relays: ["wss://tie-a.example"],
          }),
          declarationEvent({
            createdAt: 200,
            id: "tie-b",
            relays: ["wss://tie-b.example"],
          }),
        ],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.relayUrls).toEqual(["wss://tie-b.example"])
  })

  it("ignores declarations signed by other authors", async () => {
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [
          declarationEvent({
            pubkey: "attacker",
            createdAt: 100,
            relays: ["wss://attacker.example"],
          }),
        ],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("not_declared")
  })

  it("reports malformed for a signed declaration without usable relays", async () => {
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: diagnostics({
        events: [declarationEvent({ createdAt: 100, relays: [] })],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("malformed")
  })

  it("does not overwrite a cached valid declaration with a malformed one", async () => {
    primeInboxDeclarationCache(OWNER, ["wss://inbox.example"], () => 0)
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      freshnessMs: 1,
      now: () => 1_000,
      fetchEventsWithDiagnostics: diagnostics({
        events: [declarationEvent({ createdAt: 100, relays: ["ws://bad"] })],
        successful: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("malformed")
    expect(getCachedInboxDeclaration(OWNER)?.relayUrls).toEqual([
      "wss://inbox.example",
    ])
  })

  it("serves a fresh cached declaration without refetching", async () => {
    let fetches = 0
    const fetch = diagnostics({
      events: [declarationEvent({ createdAt: 100, relays: ["wss://a"] })],
      successful: ["wss://read.example"],
    })
    const counting: typeof fetch = async () => {
      fetches += 1
      return await fetch()
    }

    const first = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: counting,
      now: () => 0,
    })
    const second = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: counting,
      now: () => 1_000,
    })

    expect(first.state).toBe("declared")
    expect(second.state).toBe("declared")
    expect(fetches).toBe(1)
  })

  it("refetches after the freshness window and after invalidation", async () => {
    let fetches = 0
    const counting = async () => {
      fetches += 1
      return {
        events: [
          declarationEvent({ createdAt: 100, relays: ["wss://a"] }),
        ] as never,
        attemptedRelayUrls: ["wss://read.example"],
        successfulRelayUrls: ["wss://read.example"],
        failedRelayUrls: [],
      }
    }

    await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: counting,
      freshnessMs: 100,
      now: () => 0,
    })
    await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      fetchEventsWithDiagnostics: counting,
      freshnessMs: 100,
      now: () => 200,
    })
    expect(fetches).toBe(2)

    invalidateInboxDeclaration(OWNER)
    expect(getCachedInboxDeclaration(OWNER)).toBeNull()
  })

  it("evicts the cached declaration after a complete authoritative absence", async () => {
    primeInboxDeclarationCache(OWNER, ["wss://inbox.example"], () => 0)

    const absent = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      freshnessMs: 1,
      now: () => 1_000,
      fetchEventsWithDiagnostics: diagnostics({
        events: [],
        successful: ["wss://read.example"],
      }),
    })
    expect(absent.state).toBe("not_declared")
    expect(getCachedInboxDeclaration(OWNER)).toBeNull()

    // A later transient failure must not resurrect the evicted declaration.
    const failed = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      freshnessMs: 1,
      now: () => 2_000,
      fetchEventsWithDiagnostics: diagnostics({
        successful: [],
        failed: ["wss://read.example"],
      }),
    })
    expect(failed.state).toBe("lookup_unavailable")
    expect(failed.relayUrls).toEqual([])
  })

  it("falls back to the stale cached declaration when discovery is unavailable", async () => {
    primeInboxDeclarationCache(OWNER, ["wss://inbox.example"], () => 0)
    const result = await resolveInboxDeclaration(OWNER, {
      relayUrls: ["wss://read.example"],
      freshnessMs: 1,
      now: () => 1_000,
      fetchEventsWithDiagnostics: diagnostics({
        successful: [],
        failed: ["wss://read.example"],
      }),
    })

    expect(result.state).toBe("declared")
    expect(result.stale).toBe(true)
    expect(result.relayUrls).toEqual(["wss://inbox.example"])
  })
})

describe("planInboxReadRelays", () => {
  it("unions declared, local IN, and compatibility reads with sources", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ relayUrls: ["wss://inbox.example"] }),
      localReadRelayUrls: ["wss://local.example"],
      compatibilityRelayUrls: ["wss://compat.example", "wss://inbox.example"],
    })

    expect(plan.relayUrls).toEqual([
      "wss://inbox.example",
      "wss://local.example",
      "wss://compat.example",
    ])
    expect(plan.relaySources["wss://inbox.example"]).toBe("declared")
    expect(plan.relaySources["wss://local.example"]).toBe("local_in")
    expect(plan.relaySources["wss://compat.example"]).toBe("compatibility")
    expect(plan.source).toBe("mixed")
  })

  it("keeps compatibility reads when local settings are nonempty", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ state: "not_declared", relayUrls: [] }),
      localReadRelayUrls: ["wss://local.example"],
      compatibilityRelayUrls: ["wss://compat.example"],
    })

    expect(plan.relayUrls).toContain("wss://compat.example")
    expect(plan.relayUrls).toContain("wss://local.example")
  })

  it("uses the cached declared relays when discovery degraded", () => {
    primeInboxDeclarationCache(OWNER, ["wss://cached-inbox.example"], () => 0)
    const plan = planInboxReadRelays({
      declaration: resolution({
        state: "lookup_unavailable",
        relayUrls: [],
      }),
      localReadRelayUrls: [],
      compatibilityRelayUrls: ["wss://compat.example"],
    })

    expect(plan.relayUrls).toEqual([
      "wss://cached-inbox.example",
      "wss://compat.example",
    ])
    expect(plan.relaySources["wss://cached-inbox.example"]).toBe("cache")
  })

  it("caps the plan at maxRelays preserving priority order", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ relayUrls: ["wss://inbox.example"] }),
      localReadRelayUrls: ["wss://local.example"],
      compatibilityRelayUrls: ["wss://compat.example"],
      maxRelays: 2,
    })

    expect(plan.relayUrls).toEqual([
      "wss://inbox.example",
      "wss://local.example",
    ])
  })

  it("drops insecure relay urls from every source", () => {
    const plan = planInboxReadRelays({
      declaration: resolution({ relayUrls: ["ws://inbox.example"] }),
      localReadRelayUrls: ["ws://local.example"],
      compatibilityRelayUrls: ["wss://compat.example"],
    })

    expect(plan.relayUrls).toEqual(["wss://compat.example"])
  })
})

describe("deriveInboxReadCoverage", () => {
  it("maps diagnostics to coverage states", () => {
    expect(
      deriveInboxReadCoverage({
        successfulRelayUrls: ["wss://a"],
        failedRelayUrls: [],
      })
    ).toBe("complete")
    expect(
      deriveInboxReadCoverage({
        successfulRelayUrls: ["wss://a"],
        failedRelayUrls: ["wss://b"],
      })
    ).toBe("partial")
    expect(
      deriveInboxReadCoverage({
        successfulRelayUrls: [],
        failedRelayUrls: ["wss://a"],
      })
    ).toBe("unavailable")
  })
})

describe("selectPrivateMessageDeliveryRoute", () => {
  it("always prefers a valid declaration over bootstrap", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ relayUrls: ["wss://inbox.example"] }),
      validatedOrder: true,
      bootstrapEnabled: true,
      bootstrapRelayUrls: ["wss://bootstrap.example"],
    })

    expect(selection.route).toBe("declared_inbox")
    expect(selection.relayUrls).toEqual(["wss://inbox.example"])
  })

  it("routes a validated order to the bootstrap allowlist when enabled", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_declared", relayUrls: [] }),
      validatedOrder: true,
      bootstrapEnabled: true,
      bootstrapRelayUrls: ["wss://bootstrap.example"],
    })

    expect(selection.route).toBe("conduit_bootstrap")
    expect(selection.relayUrls).toEqual(["wss://bootstrap.example"])
  })

  it("blocks bootstrap when the redeploy-controlled flag is off", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_declared", relayUrls: [] }),
      validatedOrder: true,
      bootstrapEnabled: false,
      bootstrapRelayUrls: ["wss://bootstrap.example"],
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("recipient_not_ready")
  })

  it("never routes kind-14 general DMs through compatibility", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.DIRECT_MESSAGE,
      declaration: resolution({ state: "not_declared", relayUrls: [] }),
      validatedOrder: false,
      bootstrapEnabled: true,
      bootstrapRelayUrls: ["wss://bootstrap.example"],
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("recipient_not_ready")
  })

  it("blocks unvalidated kind-16 orders from the bootstrap lane", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_declared", relayUrls: [] }),
      validatedOrder: false,
      bootstrapEnabled: true,
      bootstrapRelayUrls: ["wss://bootstrap.example"],
    })

    expect(selection.route).toBe("blocked")
  })

  it("blocks writes on a signed malformed declaration", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "malformed", relayUrls: [] }),
      validatedOrder: true,
      bootstrapEnabled: true,
      bootstrapRelayUrls: ["wss://bootstrap.example"],
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("declaration_malformed")
  })

  it("maps lookup failure to recipient_lookup_failed when bootstrap is off", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "lookup_unavailable", relayUrls: [] }),
      validatedOrder: true,
      bootstrapEnabled: false,
    })

    expect(selection.route).toBe("blocked")
    expect(selection.blockedReason).toBe("recipient_lookup_failed")
  })

  it("drops insecure bootstrap relay urls", () => {
    const selection = selectPrivateMessageDeliveryRoute({
      rumorKind: EVENT_KINDS.ORDER,
      declaration: resolution({ state: "not_declared", relayUrls: [] }),
      validatedOrder: true,
      bootstrapEnabled: true,
      bootstrapRelayUrls: ["ws://insecure.example"],
    })

    expect(selection.route).toBe("blocked")
  })
})
