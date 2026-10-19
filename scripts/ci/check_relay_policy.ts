import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { inspectRelayPolicy, type RelayPolicySource } from "./relay_policy"

const sources: RelayPolicySource[] = []
function walk(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        "dist",
        "build",
        ".git",
        ".vite",
        ".wrangler",
        "test-results",
        "playwright-report",
      ].includes(entry.name)
    )
      continue
    const file = join(path, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (
      /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    )
      sources.push({ path: file, content: readFileSync(file, "utf8") })
  }
}
for (const root of ["apps", "packages", "functions", "scripts", "tests", "e2e"])
  walk(root)
for (const file of ["playwright.config.ts"])
  sources.push({ path: file, content: readFileSync(file, "utf8") })
const findings = inspectRelayPolicy(sources)
for (const finding of findings)
  console.error(
    `${finding.path}:${finding.line} ${finding.rule}: ${finding.detail}`
  )
if (findings.length) process.exitCode = 1
else
  console.log(
    `Relay policy ownership verified across ${sources.length} executable sources.`
  )
