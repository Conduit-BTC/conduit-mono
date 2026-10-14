import { describe, expect, it } from "bun:test"

import {
  createRouterSmokeRecorder,
  parseRouterSmokeDiagnostic,
  routerSmokeDiagnosticFromAnnotations,
} from "../scripts/ci/router_smoke_diagnostic"

describe("runner-owned router phase evidence", () => {
  it("records sender commitment without treating it as receiver claim", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    recorder.phase("native treasury sender commits before receiver claim")

    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "native treasury sender commits before receiver claim",
      lifecycle: "body",
      body: "running",
    })
  })

  it("retains the remaining offline completion checkpoints", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    for (const phase of [
      "sender commitment completes routing without native replay",
      "sender-committed exact provider transfer matches",
      "sender-committed persisted obligations match",
      "sender-committed payment receipt is fully verified",
      "unclaimed receiver keeps encrypted recovery active",
      "sender-committed refresh does not replay native payment",
    ] as const) {
      recorder.phase(phase)
      expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
        phase,
        lifecycle: "body",
        body: "running",
      })
    }
  })

  it("still rejects unapproved phases and extra provider fields", () => {
    const diagnostic = {
      phase: "native treasury sender commits before receiver claim",
      lifecycle: "body",
      body: "running",
    }
    expect(
      parseRouterSmokeDiagnostic({ ...diagnostic, phase: "unknown phase" })
    ).toBeUndefined()
    expect(
      parseRouterSmokeDiagnostic({ ...diagnostic, providerStatus: "paid" })
    ).toBeUndefined()
  })

  it("retains the latest body phase before a blocked await or finally", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    recorder.phase("cold Merchant reload navigation completes")

    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant reload navigation completes",
      lifecycle: "body",
      body: "running",
    })
    recorder.failed()
    recorder.teardown(false)
    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant reload navigation completes",
      lifecycle: "teardown",
      body: "failed",
    })
    recorder.complete()
    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant reload navigation completes",
      lifecycle: "complete",
      body: "failed",
    })
  })

  it("identifies cleanup-only work only after positive body completion", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    recorder.phase("cold Merchant retired reload does not replay payments")
    recorder.teardown(true)
    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant retired reload does not replay payments",
      lifecycle: "teardown",
      body: "completed",
    })
    recorder.complete()
    expect(routerSmokeDiagnosticFromAnnotations(annotations)).toEqual({
      phase: "cold Merchant retired reload does not replay payments",
      lifecycle: "complete",
      body: "completed",
    })
  })

  it("cannot overwrite a known body failure with cleanup success", () => {
    const annotations: Array<{ type: string; description?: string }> = []
    const recorder = createRouterSmokeRecorder(annotations)
    recorder.failed()
    recorder.teardown(true)
    recorder.complete()
    expect(routerSmokeDiagnosticFromAnnotations(annotations)?.body).toBe(
      "failed"
    )
  })
})
