import { readFileSync, writeFileSync } from "node:fs"
import {
  collectCoreSelfImports,
  collectRuntimeGraph,
  compareCycleBaseline,
  findRuntimeCycles,
  type CycleBaseline,
} from "./dependency_cycles"

const graph = await collectRuntimeGraph()
const actual: CycleBaseline = {
  cycles: findRuntimeCycles(graph),
  coreSelfImports: collectCoreSelfImports(),
}
const reportIndex = process.argv.indexOf("--report")
if (reportIndex !== -1) {
  const path = process.argv[reportIndex + 1]
  if (!path) throw new Error("--report requires an output path")
  writeFileSync(path, JSON.stringify({ ...actual, graph }, null, 2))
}
const baseline = JSON.parse(
  readFileSync("scripts/ci/dependency_cycle_baseline.json", "utf8")
) as CycleBaseline
const problems = compareCycleBaseline(actual, baseline)
for (const problem of problems) console.error(problem)
console.log(
  `Dependency graph: ${new Set(graph.modules.map((m) => m.source)).size} modules, ${actual.cycles.length} runtime cycles, ${actual.coreSelfImports.length} core self-imports.`
)
if (problems.length) process.exitCode = 1
