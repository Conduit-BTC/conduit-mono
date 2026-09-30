import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  __resetRelayHealth,
  getRelayHealth,
  isRelayInCooldown,
  partitionByHealth,
  partitionByHealthSnapshot,
  recordRelayFailure,
  recordRelaySuccess,
  snapshotRelayHealth,
} from "@conduit/core"
import { recordRelayRateLimit } from "../packages/core/src/protocol/relay-health"

const T0 = 1_700_000_000_000

describe("relay-health", () => {
  beforeEach(() => {
    __resetRelayHealth()
  })

  afterEach(() => {
    __resetRelayHealth()
  })

  it("does not park a relay on a single failure", () => {
    recordRelayFailure("wss://a.example.com", T0)
    expect(isRelayInCooldown("wss://a.example.com", T0)).toBe(false)
  })

  it("parks a relay after the configured failure threshold", () => {
    recordRelayFailure("wss://a.example.com", T0)
    recordRelayFailure("wss://a.example.com", T0 + 1)
    expect(isRelayInCooldown("wss://a.example.com", T0 + 1)).toBe(true)
    const record = getRelayHealth("wss://a.example.com")
    expect(record?.consecutiveFailures).toBe(2)
    expect(record?.cooldownUntil).toBeGreaterThan(T0 + 1)
  })

  it("backs off exponentially with each additional failure", () => {
    recordRelayFailure("wss://a.example.com", T0)
    recordRelayFailure("wss://a.example.com", T0)
    const firstCooldown = getRelayHealth("wss://a.example.com")?.cooldownUntil
    recordRelayFailure("wss://a.example.com", T0)
    const secondCooldown = getRelayHealth("wss://a.example.com")?.cooldownUntil
    expect(secondCooldown).toBeGreaterThan(firstCooldown ?? 0)
  })

  it("clears failure count and cooldown on success", () => {
    recordRelayFailure("wss://a.example.com", T0)
    recordRelayFailure("wss://a.example.com", T0)
    expect(isRelayInCooldown("wss://a.example.com", T0)).toBe(true)
    recordRelaySuccess("wss://a.example.com", T0 + 100)
    expect(isRelayInCooldown("wss://a.example.com", T0 + 100)).toBe(false)
    const record = getRelayHealth("wss://a.example.com")
    expect(record?.consecutiveFailures).toBe(0)
    expect(record?.cooldownUntil).toBeNull()
  })

  it("keeps duplicate subscription throttles within the explicit throttle window", () => {
    const relay = "wss://a.example.com"
    for (let index = 0; index < 8; index++) recordRelayRateLimit(relay, T0)
    expect(getRelayHealth(relay)?.consecutiveFailures).toBe(0)
    expect(getRelayHealth(relay)?.cooldownUntil).toBeNull()
    expect(isRelayInCooldown(relay, T0 + 59_999)).toBe(true)
    expect(partitionByHealth([relay], T0 + 60_000)).toEqual({
      healthy: [relay],
      parked: [],
    })
  })

  it("preserves a preexisting connection failure cooldown when throttled", () => {
    const relay = "wss://a.example.com"
    for (let index = 0; index < 4; index++) recordRelayFailure(relay, T0)
    const cooldownUntil = getRelayHealth(relay)?.cooldownUntil
    for (let index = 0; index < 8; index++) recordRelayRateLimit(relay, T0)
    expect(getRelayHealth(relay)?.consecutiveFailures).toBe(4)
    expect(getRelayHealth(relay)?.cooldownUntil).toBe(cooldownUntil)
    expect(isRelayInCooldown(relay, T0 + 60_000)).toBe(true)
    expect(isRelayInCooldown(relay, T0 + 120_000)).toBe(false)
  })

  it("partitions urls into healthy and parked", () => {
    recordRelayFailure("wss://parked.example.com", T0)
    recordRelayFailure("wss://parked.example.com", T0)
    recordRelaySuccess("wss://healthy.example.com", T0)
    const { healthy, parked } = partitionByHealth(
      ["wss://healthy.example.com", "wss://parked.example.com"],
      T0 + 1
    )
    expect(healthy).toEqual(["wss://healthy.example.com"])
    expect(parked).toEqual(["wss://parked.example.com"])
  })

  it("keeps one health view stable while live relay state changes", () => {
    const parked = "wss://parked.example.com"
    const healthy = "wss://healthy.example.com"
    recordRelayFailure(parked, T0)
    recordRelayFailure(parked, T0)
    const snapshot = snapshotRelayHealth(T0 + 1)

    recordRelaySuccess(parked, T0 + 2)
    recordRelayFailure(healthy, T0 + 2)
    recordRelayFailure(healthy, T0 + 2)

    expect(partitionByHealthSnapshot([healthy, parked], snapshot)).toEqual({
      healthy: [healthy],
      parked: [parked],
    })
  })

  it("ignores invalid relay urls in partitionByHealth", () => {
    const { healthy } = partitionByHealth(["not a url", ""], T0)
    expect(healthy).toEqual([])
  })

  it("normalizes urls so casing differences share state", () => {
    recordRelayFailure("wss://A.Example.com/", T0)
    recordRelayFailure("wss://a.example.com", T0)
    expect(isRelayInCooldown("wss://A.example.com", T0)).toBe(true)
  })
})
