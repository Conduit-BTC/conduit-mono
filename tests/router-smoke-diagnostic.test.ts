import { describe, expect, it } from "bun:test"

import {
  createRouterSmokeRecorder,
  routerSmokeDiagnosticFromAnnotations,
} from "../scripts/ci/router_smoke_diagnostic"

describe("runner-owned router phase evidence", () => {
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
