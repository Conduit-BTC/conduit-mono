import { describe, expect, it } from "bun:test"

describe("ordinary routed checkout V1 CI acceptance", () => {
  it("runs ordinary routing and qualified receiver setup without routed public-zap dependencies", async () => {
    const source = await Bun.file(".github/workflows/ci.yml").text()
    const jobs = Bun.YAML.parse(source).jobs as Record<
      string,
      {
        env?: Record<string, string>
        steps: Array<{
          id?: string
          name?: string
          if?: string
          run?: string
          env?: Record<string, string>
        }>
      }
    >
    const router = jobs["e2e-router"]!
    expect(router).toBeDefined()
    const ordinary = jobs["e2e-smoke-shard"]!
    const cleanup = router.steps.find(
      (step) => step.name === "Remove raw Playwright output"
    )!
    expect(cleanup.if).toBe("always()")
    expect(cleanup.env).not.toHaveProperty("PLAYWRIGHT_SMOKE_RESULT_FILE")
    expect(cleanup.env).not.toHaveProperty("PLAYWRIGHT_SMOKE_PROGRESS_FILE")
    const ordinaryCleanup = ordinary.steps.find(
      (step) => step.name === "Remove raw Playwright output"
    )!
    expect(JSON.stringify(ordinaryCleanup)).not.toContain("PLAYWRIGHT_ROUTER_")
    expect(router.env?.PLAYWRIGHT_ROUTER_NATIVE_PROFILE).toBeUndefined()
    expect(router.env?.PLAYWRIGHT_ROUTER_RECEIVER_SETUP_CASE).toBeUndefined()
    for (const lane of ["isolated router", "router receiver setup"]) {
      const selection = router.steps.findIndex(
        (step) => step.name === `Validate ${lane} smoke selection`
      )
      const executionName =
        lane === "isolated router"
          ? "Run isolated router Playwright smoke tests"
          : "Run router receiver setup Playwright smoke"
      const execution = router.steps.findIndex(
        (step) => step.name === executionName
      )
      const verification = router.steps.findIndex(
        (step) => step.name === `Verify executed ${lane} smoke evidence`
      )
      expect(selection).toBeGreaterThan(-1)
      expect(execution).toBeGreaterThan(selection)
      expect(verification).toBeGreaterThan(execution)
      expect(router.steps.indexOf(cleanup)).toBeGreaterThan(verification)
      const selected = router.steps[selection]!
      const executed = router.steps[execution]!
      const verified = router.steps[verification]!
      expect(selected.run).toContain("--manifest-output")
      expect(executed.run).toContain(">/dev/null 2>&1")
      expect(verified.run).toContain("--expected-manifest")
      expect(verified.run).toContain("--execution-report")
      expect(verified.if).toBe("always()")
      for (const step of [selected, verified]) {
        expect(step.run).toContain("git rev-parse HEAD")
        for (const field of ["--source-head-sha", "--base-sha", "--tested-sha"])
          expect(step.run).toContain(field)
      }
      for (const step of [selected, executed, verified]) {
        expect(step.if).not.toContain("matrix.")
        if (lane === "isolated router") {
          expect(step.env?.PLAYWRIGHT_ROUTER_NATIVE_PROFILE).toBe("ordinary")
          expect(
            step.env?.PLAYWRIGHT_ROUTER_RECEIVER_SETUP_CASE
          ).toBeUndefined()
        } else {
          expect(step.env?.PLAYWRIGHT_ROUTER_RECEIVER_SETUP_CASE).toBe("true")
          expect(step.env?.PLAYWRIGHT_ROUTER_NATIVE_PROFILE).toBeUndefined()
        }
      }
      expect(ordinary.steps.some((step) => step.name === executionName)).toBe(
        false
      )
    }
    for (const prefix of ["PLAYWRIGHT_ROUTER", "PLAYWRIGHT_ROUTER_RECEIVER"])
      for (const suffix of [
        "RESULT_FILE",
        "PROGRESS_FILE",
        "EVIDENCE_FILE",
        "MANIFEST",
      ]) {
        expect(cleanup.env?.[`${prefix}_${suffix}`]).toBeDefined()
        expect(cleanup.run).toContain(`"$${prefix}_${suffix}"`)
      }
    expect(cleanup.run).toContain(
      '"$PLAYWRIGHT_ROUTER_RECEIVER_RESULT_FILE" "$PLAYWRIGHT_ROUTER_RECEIVER_PROGRESS_FILE" "$PLAYWRIGHT_ROUTER_RECEIVER_EVIDENCE_FILE" "$PLAYWRIGHT_ROUTER_RECEIVER_MANIFEST"'
    )
    expect(cleanup.run).toContain(
      '"$PLAYWRIGHT_ROUTER_RESULT_FILE" "$PLAYWRIGHT_ROUTER_PROGRESS_FILE" "$PLAYWRIGHT_ROUTER_EVIDENCE_FILE" "$PLAYWRIGHT_ROUTER_MANIFEST"'
    )
    expect(source).not.toContain("PLAYWRIGHT_ROUTER_PUBLIC_ZAP_CASE")
    expect(source).not.toContain("run_playwright_anonymous_zap")
    expect(source).not.toContain("routed public Zapout")
    expect(source).not.toContain("routed anonymous Zapout")
  })
})
