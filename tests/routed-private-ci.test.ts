import { describe, expect, it } from "bun:test"

describe("ordinary routed checkout V1 CI acceptance", () => {
  it("runs ordinary routing and qualified receiver setup without routed public-zap dependencies", async () => {
    const source = await Bun.file(".github/workflows/ci.yml").text()
    for (const lane of ["isolated router", "router receiver setup"]) {
      const selection = source.indexOf(
        `      - name: Validate ${lane} smoke selection`
      )
      const execution = source.indexOf(
        lane === "isolated router"
          ? "      - name: Run isolated router Playwright smoke tests"
          : "      - name: Run router receiver setup Playwright smoke"
      )
      const verification = source.indexOf(
        `      - name: Verify executed ${lane} smoke evidence`
      )
      const cleanup = source.indexOf(
        "      - name: Remove raw Playwright output"
      )
      expect(selection).toBeGreaterThan(-1)
      expect(execution).toBeGreaterThan(selection)
      expect(verification).toBeGreaterThan(execution)
      expect(cleanup).toBeGreaterThan(verification)
      expect(source.slice(selection, execution)).toContain("--manifest-output")
      expect(source.slice(execution, verification)).toContain(">/dev/null 2>&1")
      expect(source.slice(verification, cleanup)).toContain(
        "--expected-manifest"
      )
      expect(source.slice(verification, cleanup)).toContain(
        "--execution-report"
      )
      expect(source.slice(verification, cleanup)).toContain("if: always()")
    }
    expect(source).toContain('PLAYWRIGHT_ROUTER_RECEIVER_SETUP_CASE: "true"')
    expect(source).toContain("playwright-router-receiver-setup-results.json")
    expect(source).toContain(
      '"$PLAYWRIGHT_ROUTER_RECEIVER_RESULT_FILE" "$PLAYWRIGHT_ROUTER_RECEIVER_PROGRESS_FILE" "$PLAYWRIGHT_ROUTER_RECEIVER_MANIFEST"'
    )
    expect(source).not.toContain("PLAYWRIGHT_ROUTER_PUBLIC_ZAP_CASE")
    expect(source).not.toContain("run_playwright_anonymous_zap")
    expect(source).not.toContain("routed public Zapout")
    expect(source).not.toContain("routed anonymous Zapout")
  })
})
