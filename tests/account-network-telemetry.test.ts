import { describe, expect, it } from "bun:test"
import type { AccountNetworkMutationResult } from "../packages/core/src/protocol/account-network-mutation"
import { observeAccountNetworkInboxRepair } from "../packages/core/src/protocol/account-network-telemetry"
import type { Nip17CompatibilityResultTelemetryInput } from "../packages/core/src/telemetry-event-properties"

function result(pending: boolean): AccountNetworkMutationResult {
  return {
    status: "staged",
    localStateChanged: false,
    checkpoints: [
      {
        kind: 10050,
        signedEvent: {
          id: "a".repeat(64),
          pubkey: "b".repeat(64),
          sig: "c".repeat(128),
          kind: 10050,
          created_at: 1,
          content: "",
          tags: [["relay", "wss://private-inbox.example"]],
        },
        pending,
        relayOutcomes: [],
      },
    ],
  }
}

describe("Account Network repair observation", () => {
  it("keeps pending confirmation distinct from a completed inbox repair without emitting signed data", async () => {
    for (const pending of [true, false]) {
      const outcomes: Nip17CompatibilityResultTelemetryInput[] = []
      const value = result(pending)
      const observed = await observeAccountNetworkInboxRepair({
        includesInbox: true,
        shouldContinue: () => true,
        operation: async () => value,
        record: (outcome) => outcomes.push(outcome),
      })
      expect(observed).toBe(value)
      expect(outcomes).toEqual([
        {
          action: "declaration_repair",
          declarationClass: pending ? "distribution_pending" : "declared",
          deliveryRoute: "not_applicable",
          ackOutcome: "not_applicable",
          repairOutcome: pending ? "confirmation_pending" : "discoverable",
          blockReason: "not_applicable",
        },
      ])
      expect(JSON.stringify(outcomes)).not.toContain("private-inbox")
      expect(JSON.stringify(outcomes)).not.toContain(
        value.checkpoints[0]!.signedEvent.id
      )
    }
  })

  it("does not count unrelated updates, no-ops, or signed withdrawals as repaired inboxes", async () => {
    const withdrawal = result(false)
    withdrawal.checkpoints[0]!.signedEvent.tags = []
    const outcomes: Nip17CompatibilityResultTelemetryInput[] = []
    for (const [includesInbox, value] of [
      [false, result(false)],
      [
        true,
        { status: "no_change", localStateChanged: false, checkpoints: [] },
      ],
      [true, withdrawal],
    ] as const) {
      await observeAccountNetworkInboxRepair({
        includesInbox,
        shouldContinue: () => true,
        operation: async () => value as AccountNetworkMutationResult,
        record: (outcome) => outcomes.push(outcome),
      })
    }
    expect(outcomes).toEqual([])
  })

  it("preserves the original failure and emits one fixed-label failure", async () => {
    const failure = new Error("private diagnostic must not be emitted")
    const outcomes: Nip17CompatibilityResultTelemetryInput[] = []
    await expect(
      observeAccountNetworkInboxRepair({
        includesInbox: true,
        shouldContinue: () => true,
        operation: async () => {
          throw failure
        },
        record: (outcome) => outcomes.push(outcome),
      })
    ).rejects.toBe(failure)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.repairOutcome).toBe("failed")
    expect(JSON.stringify(outcomes)).not.toContain(failure.message)
  })

  it("suppresses late outcomes after account authority changes", async () => {
    const outcomes: Nip17CompatibilityResultTelemetryInput[] = []
    let active = true
    await observeAccountNetworkInboxRepair({
      includesInbox: true,
      shouldContinue: () => active,
      operation: async () => {
        active = false
        return result(false)
      },
      record: (outcome) => outcomes.push(outcome),
    })
    expect(outcomes).toEqual([])
  })

  it("does not let a diagnostic adapter alter a successful operation", async () => {
    const value = result(false)
    await expect(
      observeAccountNetworkInboxRepair({
        includesInbox: true,
        shouldContinue: () => true,
        operation: async () => value,
        record: () => {
          throw new Error("observer unavailable")
        },
      })
    ).resolves.toBe(value)
  })
})
