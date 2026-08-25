import { describe, expect, it } from "bun:test"
import { generateSecretKey, getPublicKey } from "nostr-tools"
import { readFile } from "node:fs/promises"

import {
  PRODUCTION_RELAY_CANARY_STAGE_ORDER,
  PRODUCTION_RELAY_HTTP_URL,
  PRODUCTION_RELAY_WS_URL,
  ProductionRelayCanaryCheckError,
  ProductionRelayCanaryFailure,
  classifyProductionRelayDenialReason,
  formatProductionRelayCanaryLadder,
  formatProductionRelayCanarySummary,
  latencyBucket,
  requireUnauthenticatedDenial,
  requireUnrelatedDenial,
  runProductionRelayCanary,
  signedCanaryEventsMatchExactly,
  validateProductionRelayNip11,
  type ProductionRelayCanaryOperations,
  type ProductionRelayFrameConnection,
  type ProductionRelayCanaryStage,
} from "../scripts/smoke/production_relay_canary"

type Frame = unknown[]

class ScriptedRelayConnection implements ProductionRelayFrameConnection {
  readonly sent: unknown[][] = []

  constructor(
    private readonly nextFrame: (connection: ScriptedRelayConnection) => Frame
  ) {}

  async connect(): Promise<void> {}

  send(frame: unknown[]): void {
    this.sent.push(frame)
  }

  async next(): Promise<Frame> {
    return this.nextFrame(this)
  }

  close(): void {}
}

function requestedSubscriptionId(connection: ScriptedRelayConnection): string {
  const request = connection.sent.find((frame) => frame[0] === "REQ")
  if (!request || typeof request[1] !== "string") {
    throw new Error("missing scripted request")
  }
  return request[1]
}

function fakeOperations(
  input: {
    failAt?: ProductionRelayCanaryStage
    cleanupFails?: boolean
  } = {}
): {
  operations: ProductionRelayCanaryOperations
  calls: string[]
} {
  const calls: string[] = []
  const run = async (stage: ProductionRelayCanaryStage): Promise<void> => {
    calls.push(stage)
    if (stage === input.failAt || (stage === "cleanup" && input.cleanupFails)) {
      throw new Error("SENSITIVE_SENTINEL must never enter canary output")
    }
  }
  return {
    calls,
    operations: {
      nip11: () => run("nip11"),
      websocket: () => run("websocket"),
      signedEvent: () => run("signed_event"),
      basicPublishAck: () => run("basic_publish_ack"),
      basicReadback: () => run("basic_readback"),
      inboxDeclarationPublishAck: () => run("inbox_declaration_publish_ack"),
      inboxDeclarationDiscovery: () => run("inbox_declaration_discovery"),
      nip17WrapPublishAck: () => run("nip17_wrap_publish_ack"),
      recipientAuthFetch: () => run("recipient_auth_fetch"),
      unwrapDecrypt: () => run("unwrap_decrypt"),
      unauthenticatedDenied: () => run("unauthenticated_denied"),
      unrelatedDenied: () => run("unrelated_denied"),
      recipientRefetch: () => run("recipient_refetch"),
      cleanup: () => run("cleanup"),
      dispose: () => calls.push("dispose"),
    },
  }
}

describe("production relay canary orchestration", () => {
  it("runs every production stage in order and always disposes", async () => {
    const { operations, calls } = fakeOperations()

    const results = await runProductionRelayCanary(operations)

    expect(results.map((result) => result.stage)).toEqual(
      PRODUCTION_RELAY_CANARY_STAGE_ORDER
    )
    expect(results.every((result) => result.status === "passed")).toBe(true)
    expect(calls).toEqual([...PRODUCTION_RELAY_CANARY_STAGE_ORDER, "dispose"])
  })

  it("stops at the failed stage, attempts cleanup, and preserves the cause stage", async () => {
    const { operations, calls } = fakeOperations({
      failAt: "recipient_auth_fetch",
    })

    let failure: ProductionRelayCanaryFailure | null = null
    try {
      await runProductionRelayCanary(operations)
    } catch (error) {
      failure = error as ProductionRelayCanaryFailure
    }

    expect(failure).toBeInstanceOf(ProductionRelayCanaryFailure)
    expect(failure?.stage).toBe("recipient_auth_fetch")
    expect(failure?.code).toBe("recipient_auth_fetch_failed")
    expect(failure?.results.at(-2)).toMatchObject({
      stage: "recipient_auth_fetch",
      status: "failed",
    })
    expect(failure?.results.at(-1)).toMatchObject({
      stage: "cleanup",
      status: "passed",
    })
    expect(calls).toEqual([
      ...PRODUCTION_RELAY_CANARY_STAGE_ORDER.slice(
        0,
        PRODUCTION_RELAY_CANARY_STAGE_ORDER.indexOf("recipient_auth_fetch") + 1
      ),
      "cleanup",
      "dispose",
    ])
  })

  it("does not let cleanup failure hide the primary relay failure", async () => {
    const { operations } = fakeOperations({
      failAt: "unauthenticated_denied",
      cleanupFails: true,
    })

    let failure: ProductionRelayCanaryFailure | null = null
    try {
      await runProductionRelayCanary(operations)
    } catch (error) {
      failure = error as ProductionRelayCanaryFailure
    }

    expect(failure?.stage).toBe("unauthenticated_denied")
    expect(failure?.results.at(-1)).toEqual(
      expect.objectContaining({
        stage: "cleanup",
        status: "failed",
        code: "cleanup_failed",
      })
    )
  })

  it("reports disposal failure as a failed cleanup instead of a pass", async () => {
    const { operations } = fakeOperations()
    operations.dispose = () => {
      throw new Error("local disposal failed")
    }

    await expect(runProductionRelayCanary(operations)).rejects.toMatchObject({
      stage: "cleanup",
      code: "dispose_failed",
      results: expect.arrayContaining([
        expect.objectContaining({
          stage: "cleanup",
          status: "failed",
          code: "dispose_failed",
        }),
      ]),
    })
  })

  it("keeps dependency errors and sensitive sentinels out of all output", async () => {
    const { operations } = fakeOperations({ failAt: "unwrap_decrypt" })

    let failure: ProductionRelayCanaryFailure | null = null
    try {
      await runProductionRelayCanary(operations)
    } catch (error) {
      failure = error as ProductionRelayCanaryFailure
    }

    const ladder = formatProductionRelayCanaryLadder(failure?.results ?? [])
    const summary = formatProductionRelayCanarySummary(failure?.results ?? [])
    expect(`${failure?.message}\n${ladder}\n${summary}`).not.toContain(
      "SENSITIVE_SENTINEL"
    )
    expect(summary).not.toMatch(/[0-9a-f]{64}/i)
    expect(summary).not.toContain("nsec1")
    expect(summary).toContain("unwrap_decrypt_failed")
  })

  it("preserves allowlisted privacy failure codes without exposing relay data", async () => {
    const { operations } = fakeOperations()
    operations.unauthenticatedDenied = async () => {
      throw new ProductionRelayCanaryCheckError(
        "unauthenticated_id_only_event_exposed"
      )
    }

    let failure: ProductionRelayCanaryFailure | null = null
    try {
      await runProductionRelayCanary(operations)
    } catch (error) {
      failure = error as ProductionRelayCanaryFailure
    }

    expect(failure?.stage).toBe("unauthenticated_denied")
    expect(failure?.code).toBe("unauthenticated_id_only_event_exposed")
    expect(
      formatProductionRelayCanarySummary(failure?.results ?? [])
    ).toContain("unauthenticated_id_only_event_exposed")
  })
})

describe("production relay canary public contract", () => {
  it("hard-codes the one production relay target", () => {
    expect(PRODUCTION_RELAY_HTTP_URL).toBe("https://relay.conduit.market/")
    expect(PRODUCTION_RELAY_WS_URL).toBe("wss://relay.conduit.market")
  })

  it("accepts valid minimal NIP-11 and treats capability claims as observations", () => {
    expect(() => validateProductionRelayNip11({})).not.toThrow()
    expect(() =>
      validateProductionRelayNip11({ supported_nips: [1, 11, 17, 42, 59] })
    ).not.toThrow()
  })

  it("rejects malformed NIP-11 documents", () => {
    expect(() => validateProductionRelayNip11(null)).toThrow()
    expect(() =>
      validateProductionRelayNip11({ supported_nips: [1, "42"] })
    ).toThrow()
  })

  it("uses coarse latency buckets in diagnostics", () => {
    expect(latencyBucket(0)).toBe("<250ms")
    expect(latencyBucket(999)).toBe("<1s")
    expect(latencyBucket(2_999)).toBe("<3s")
    expect(latencyBucket(9_999)).toBe("<10s")
    expect(latencyBucket(10_000)).toBe(">=10s")
  })

  it("classifies only authorization close prefixes as privacy denials", () => {
    expect(classifyProductionRelayDenialReason("auth-required: sign in")).toBe(
      "auth_required"
    )
    expect(classifyProductionRelayDenialReason("restricted: recipient")).toBe(
      "restricted"
    )
    expect(classifyProductionRelayDenialReason("invalid: filter shape")).toBe(
      "invalid"
    )
    expect(classifyProductionRelayDenialReason("blocked: protected")).toBe(
      "blocked"
    )
    expect(classifyProductionRelayDenialReason("rate-limited: later")).toBe(
      "rate_limited"
    )
    expect(classifyProductionRelayDenialReason("error: unavailable")).toBe(
      "error"
    )
    expect(classifyProductionRelayDenialReason("closed")).toBe("other")
  })

  it("never renders a forced setup failure as passed and includes a safe SHA", () => {
    const sha = "a".repeat(40)
    const summary = formatProductionRelayCanarySummary([], {
      forceFailed: true,
      testedSha: sha,
    })

    expect(summary).toContain("**FAILED**")
    expect(summary).toContain(`Tested commit: \`${sha}\``)
    expect(summary).toContain("failed before stage diagnostics")
    expect(
      formatProductionRelayCanarySummary([], {
        testedSha: "not-a-commit secret",
      })
    ).not.toContain("not-a-commit")
  })

  it("matches exact signed events independently of object key order", () => {
    const expected = {
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      created_at: 123,
      kind: 1,
      tags: [["t", "canary"]],
      content: "canary",
      sig: "c".repeat(128),
    }
    const reordered = {
      kind: expected.kind,
      tags: expected.tags,
      content: expected.content,
      created_at: expected.created_at,
      pubkey: expected.pubkey,
      sig: expected.sig,
      id: expected.id,
    }

    expect(
      signedCanaryEventsMatchExactly(reordered as never, expected as never)
    ).toBe(true)
    expect(
      signedCanaryEventsMatchExactly(
        { ...reordered, content: "different" } as never,
        expected as never
      )
    ).toBe(false)
  })
})

describe("production relay canary privacy protocol", () => {
  it("requires a challenge and auth-required close for the scoped unauthenticated read", async () => {
    let scopedFrame = 0
    const connections = [
      new ScriptedRelayConnection((connection) => {
        const subscriptionId = requestedSubscriptionId(connection)
        scopedFrame += 1
        return scopedFrame === 1
          ? ["AUTH", "challenge"]
          : ["CLOSED", subscriptionId, "auth-required: protected"]
      }),
      new ScriptedRelayConnection((connection) => [
        "CLOSED",
        requestedSubscriptionId(connection),
        "restricted: exact protected lookup",
      ]),
    ]
    let index = 0

    await expect(
      requireUnauthenticatedDenial({
        targetEventId: "a".repeat(64),
        recipientPubkey: "b".repeat(64),
        connectionFactory: () => connections[index++]!,
        deadlineMs: 100,
      })
    ).resolves.toBeUndefined()
  })

  it("rejects EVENT, EOSE, and generic close responses as privacy proof", async () => {
    for (const terminal of [
      ["EVENT", "subscription", {}],
      ["EOSE", "subscription"],
      ["CLOSED", "subscription", "rate-limited: later"],
    ]) {
      let call = 0
      const connection = new ScriptedRelayConnection((scripted) => {
        call += 1
        if (call === 1) return ["AUTH", "challenge"]
        return [
          terminal[0],
          requestedSubscriptionId(scripted),
          ...terminal.slice(2),
        ]
      })

      await expect(
        requireUnauthenticatedDenial({
          targetEventId: "a".repeat(64),
          recipientPubkey: "b".repeat(64),
          connectionFactory: () => connection,
          deadlineMs: 100,
        })
      ).rejects.toBeInstanceOf(ProductionRelayCanaryCheckError)
    }
  })

  it("proves Sender A can read its control before denying Recipient B", async () => {
    const secretKey = generateSecretKey()
    const principalPubkey = getPublicKey(secretKey)
    const principalControlEvent = {
      id: "c".repeat(64),
      pubkey: "d".repeat(64),
      created_at: 123,
      kind: 1_059,
      tags: [["p", principalPubkey]],
      content: "ciphertext",
      sig: "e".repeat(128),
    }
    let phase = 0
    const connection = new ScriptedRelayConnection((scripted) => {
      phase += 1
      if (phase === 1) return ["AUTH", "challenge"]
      if (phase === 2) {
        return [
          "CLOSED",
          requestedSubscriptionId(scripted),
          "auth-required: authenticate",
        ]
      }
      if (phase === 3) {
        const auth = scripted.sent.find((frame) => frame[0] === "AUTH")
        const event = auth?.[1] as { id?: unknown } | undefined
        return ["OK", event?.id, true, ""]
      }
      if (phase === 4) {
        const requests = scripted.sent.filter((frame) => frame[0] === "REQ")
        return ["EVENT", requests[1]?.[1], principalControlEvent]
      }
      if (phase === 5) {
        const requests = scripted.sent.filter((frame) => frame[0] === "REQ")
        return ["EOSE", requests[1]?.[1]]
      }
      const requests = scripted.sent.filter((frame) => frame[0] === "REQ")
      const request = requests[phase === 6 ? 2 : 3]
      return [
        "CLOSED",
        request?.[1],
        phase === 6 ? "blocked: recipient mismatch" : "invalid: filter shape",
      ]
    })

    await expect(
      requireUnrelatedDenial({
        targetEventId: "a".repeat(64),
        recipientPubkey: "b".repeat(64),
        principal: { secretKey, pubkey: principalPubkey },
        principalControlEvent: principalControlEvent as never,
        connectionFactory: () => connection,
        deadlineMs: 100,
      })
    ).resolves.toBeUndefined()
  })

  it("applies one absolute deadline even when irrelevant frames keep arriving", async () => {
    const connection = new ScriptedRelayConnection(() => ["NOTICE", "noise"])

    await expect(
      requireUnauthenticatedDenial({
        targetEventId: "a".repeat(64),
        recipientPubkey: "b".repeat(64),
        connectionFactory: () => connection,
        deadlineMs: 1,
      })
    ).rejects.toThrow("relay_probe_deadline")
  })
})

describe("production relay canary workflow", () => {
  it("stays trusted-main-only, non-secret, and separate from required CI", async () => {
    const [workflow, ci, packageJson] = await Promise.all([
      readFile(".github/workflows/production-relay-canary.yml", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile("package.json", "utf8"),
    ])

    expect(workflow).toContain("push:\n    branches: [main]")
    expect(workflow).toContain('cron: "17 * * * *"')
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).not.toContain("pull_request:")
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'")
    expect(workflow).toContain("permissions:\n  contents: read")
    expect(workflow).not.toMatch(/permissions:[\s\S]*\bwrite\b/)
    expect(workflow).toContain("group: production-relay-canary")
    expect(workflow).toContain("cancel-in-progress: false")
    expect(workflow).toContain('bun-version: "1.3.5"')
    expect(workflow).toContain("bun install --frozen-lockfile")
    expect(workflow).toContain("persist-credentials: false")
    expect(workflow).not.toContain("continue-on-error")
    expect(workflow).not.toContain("actions/upload-artifact")
    expect(workflow).not.toContain("secrets.")
    expect(workflow).not.toContain("playwright")
    expect(ci).not.toContain("production-relay-canary")
    expect(packageJson).toContain('"smoke:production-relay"')
  })
})
