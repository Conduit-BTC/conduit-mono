import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

const runbook = readFileSync(
  new URL("../docs/knowledge/mobile-safari-qa-baseline.md", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n")

function sectionBetween(start: string, end: string): string {
  const startIndex = runbook.indexOf(start)
  const endIndex = runbook.indexOf(end, startIndex + start.length)

  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)

  return runbook.slice(startIndex, endIndex)
}

function tableRequirementIds(section: string): string[] {
  return Array.from(
    section.matchAll(/^\|\s*(P[12]-\d{2})\s*\|/gm),
    (match) => match[1]!
  )
}

const requirementRegister = sectionBetween(
  "## Requirement register",
  "## Device and automation matrix"
)
const deviceMatrix = sectionBetween(
  "## Device and automation matrix",
  "## 110-minute full run"
)
const dryRunLog = sectionBetween("### Baseline run", "Before closing a run")
const requirementIds = tableRequirementIds(requirementRegister)

describe("mobile Safari QA baseline", () => {
  it("maps every unique P1/P2 requirement exactly once into both result tables", () => {
    expect(requirementIds.length).toBeGreaterThan(0)
    expect(new Set(requirementIds).size).toBe(requirementIds.length)

    for (const section of [deviceMatrix, dryRunLog]) {
      const mappedIds = tableRequirementIds(section)
      expect(mappedIds).toEqual(requirementIds)

      for (const requirementId of requirementIds) {
        expect(mappedIds.filter((id) => id === requirementId)).toHaveLength(1)
      }
    }
  })

  it("keeps Playwright WebKit distinct from branded and real-device Safari", () => {
    const compactRunbook = runbook.replace(/\s+/g, " ")

    expect(compactRunbook).toContain(
      "**Playwright WebKit** runs Playwright's patched WebKit build"
    )
    expect(compactRunbook).toContain("does **not** run branded Safari")
    expect(compactRunbook).toContain(
      "Playwright WebKit do not satisfy this claim"
    )
    expect(compactRunbook).toContain(
      'must never be shortened to "Mobile Safari passed."'
    )
  })

  it("leaves every initial device and automation result explicitly NOT RUN", () => {
    expect(dryRunLog).toContain("### Baseline run — NOT RUN")

    const metadataBlock = dryRunLog.slice(0, dryRunLog.indexOf("| Requirement"))
    const metadataLines = metadataBlock
      .split("\n")
      .filter((line) => line.startsWith("- "))
    expect(metadataLines.length).toBeGreaterThan(0)
    for (const line of metadataLines) {
      expect(line).toEndWith(": `NOT RUN`")
    }

    const resultRows = dryRunLog
      .split("\n")
      .filter((line) => /^\|\s*P[12]-\d{2}\s*\|/.test(line))

    expect(resultRows).toHaveLength(requirementIds.length)
    for (const row of resultRows) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
      const laneResults = cells.slice(1, 7)

      expect(laneResults).toHaveLength(6)
      expect(new Set(laneResults)).toEqual(new Set(["NOT RUN"]))
    }
  })
})
