import { readFileSync, writeFileSync } from "node:fs"
import {
  collectCoreSelfImports,
  validateCycleReportPath,
  collectRuntimeGraph,
  compareCycleBaseline,
  findRuntimeCycles,
  type CycleBaseline,
} from "./dependency_cycles"

const baselinePath = "scripts/ci/dependency_cycle_baseline.json"
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as CycleBaseline
const reportIndex = process.argv.indexOf("--report")
let reportPath: string | undefined
if (reportIndex !== -1) {
  reportPath = process.argv[reportIndex + 1]
  if (!reportPath) throw new Error("--report requires an output path")
  validateCycleReportPath(reportPath, baselinePath)
}
const graph = await collectRuntimeGraph()
const actual: CycleBaseline = {
  cycles: findRuntimeCycles(graph),
  coreSelfImports: collectCoreSelfImports(),
}
if (reportPath)
  writeFileSync(reportPath, JSON.stringify({ ...actual, graph }, null, 2))
const problems = compareCycleBaseline(actual, baseline)
for (const problem of problems) console.error(problem)
console.log(
  `Dependency graph: ${new Set(graph.modules.map((m) => m.source)).size} modules, ${actual.cycles.length} runtime cycles, ${actual.coreSelfImports.length} core self-imports.`
)
if (problems.length) process.exitCode = 1
