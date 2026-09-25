import { describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workflow = await Bun.file(".github/workflows/agent-pr-harden.yml").text()

function stepScript(name: string): string {
  const stepStart = workflow.indexOf(`      - name: ${name}\n`)
  expect(stepStart).toBeGreaterThanOrEqual(0)
  const scriptStart = workflow.indexOf("        run: |\n", stepStart)
  const nextStep = workflow.indexOf("\n      - name:", scriptStart)
  return workflow
    .slice(scriptStart + "        run: |\n".length, nextStep)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n")
}

const gateScript = stepScript("Validate maintainer gate")
const checkoutScript = stepScript("Check out pull request branch")
const approvedHead = "a".repeat(40)
const advancedHead = "b".repeat(40)

describe("agent hardening PR head gate", () => {
  it("stops a changed checkout or PR head before candidate installation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-harden-head-"))
    const fakeBin = join(directory, "bin")
    const outputPath = join(directory, "gate-output")
    const localHeadPath = join(directory, "local-head")

    try {
      await mkdir(fakeBin)
      await writeFile(
        join(fakeBin, "gh"),
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  if [[ "$*" == *"isCrossRepository,labels,headRefOid"* ]]; then
    printf '%s\\n' "$FAKE_METADATA"
  else
    printf '%s\\n' "$FAKE_CURRENT_HEAD"
  fi
elif [[ "$1" == "pr" && "$2" == "checkout" ]]; then
  printf '%s\\n' "$FAKE_CHECKOUT_HEAD" > "$FAKE_LOCAL_HEAD"
else
  exit 2
fi
`,
        { mode: 0o755 }
      )
      await writeFile(
        join(fakeBin, "git"),
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then
  cat "$FAKE_LOCAL_HEAD"
else
  exit 2
fi
`,
        { mode: 0o755 }
      )

      const env = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        PR_NUMBER: "547",
        RISK_CLASS: "B",
        GITHUB_OUTPUT: outputPath,
        FAKE_LOCAL_HEAD: localHeadPath,
        FAKE_METADATA: JSON.stringify({
          isCrossRepository: false,
          labels: [{ name: "agent-ready" }],
          headRefOid: approvedHead,
        }),
      }
      const run = (script: string, overrides: Record<string, string> = {}) =>
        Bun.spawnSync(["bash", "-c", script], {
          cwd: directory,
          env: { ...env, ...overrides },
        })

      expect(run(gateScript).exitCode).toBe(0)
      expect(await readFile(outputPath, "utf8")).toContain(
        `head_sha=${approvedHead}`
      )
      expect(
        run(gateScript, {
          FAKE_METADATA: JSON.stringify({
            isCrossRepository: false,
            labels: [{ name: "agent-ready" }, { name: "Risk:C" }],
            headRefOid: approvedHead,
          }),
        }).exitCode
      ).not.toBe(0)

      expect(
        run(checkoutScript, {
          EXPECTED_HEAD: approvedHead,
          FAKE_CHECKOUT_HEAD: approvedHead,
          FAKE_CURRENT_HEAD: approvedHead,
        }).exitCode
      ).toBe(0)
      expect(
        run(checkoutScript, {
          EXPECTED_HEAD: approvedHead,
          FAKE_CHECKOUT_HEAD: advancedHead,
          FAKE_CURRENT_HEAD: advancedHead,
        }).exitCode
      ).not.toBe(0)
      expect(
        run(checkoutScript, {
          EXPECTED_HEAD: approvedHead,
          FAKE_CHECKOUT_HEAD: approvedHead,
          FAKE_CURRENT_HEAD: advancedHead,
        }).exitCode
      ).not.toBe(0)

      expect(
        workflow.indexOf("- name: Check out pull request branch")
      ).toBeLessThan(
        workflow.indexOf("- name: Install dependencies for agent validation")
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
