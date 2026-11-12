import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import type { ICruiseResult } from "dependency-cruiser"
import {
  discoverDependencyProjects,
  collectCoreSelfImports,
  collectRuntimeGraph,
  compareCycleBaseline,
  findRuntimeCycles,
  type CycleBaseline,
} from "../scripts/ci/dependency_cycles"

function removeFixture(
  directory: string,
  prefix = "packages/.cycle-guard-fixture-"
) {
  if (!resolve(directory).startsWith(resolve(prefix)))
    throw new Error("Unexpected fixture path")
  rmSync(directory, { recursive: true, force: true })
}

const moduleGraph = (pairs: [string, string[]][]) =>
  ({
    modules: pairs.map(([source, targets]) => ({
      source,
      dependencies: targets.map((resolved) => ({ resolved })),
    })),
  }) as ICruiseResult

test("runtime baseline rejects new edges inside an existing SCC and obsolete exceptions", () => {
  const original = moduleGraph([
    ["packages/a.ts", ["packages/b.ts"]],
    ["packages/b.ts", ["packages/c.ts"]],
    ["packages/c.ts", ["packages/a.ts"]],
  ])
  const baseline: CycleBaseline = {
    cycles: findRuntimeCycles(original),
    coreSelfImports: [],
  }
  expect(compareCycleBaseline(baseline, baseline)).toEqual([])
  const widened = moduleGraph([
    ["packages/a.ts", ["packages/b.ts", "packages/c.ts"]],
    ["packages/b.ts", ["packages/c.ts"]],
    ["packages/c.ts", ["packages/a.ts"]],
  ])
  expect(
    compareCycleBaseline(
      { ...baseline, cycles: findRuntimeCycles(widened) },
      baseline
    ).some((p) => p.startsWith("New or changed"))
  ).toBe(true)
  expect(
    compareCycleBaseline({ cycles: [], coreSelfImports: [] }, baseline).some(
      (p) => p.startsWith("Remove obsolete")
    )
  ).toBe(true)
})

test("real cruiser resolves app aliases, counts dynamic cycles, and erases type-only imports", async () => {
  const directory = mkdtempSync("packages/.cycle-guard-fixture-").replaceAll(
    "\\",
    "/"
  )
  try {
    mkdirSync(join(directory, "src"))
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          paths: { "@/*": ["./src/*"] },
        },
        include: ["src/**/*"],
      })
    )
    writeFileSync(
      join(directory, "src/a.ts"),
      'import { b } from "@/b"; export const a = b;'
    )
    writeFileSync(
      join(directory, "src/b.ts"),
      'export const b = () => import("./a");'
    )
    const runtime = findRuntimeCycles(await collectRuntimeGraph([directory]))
    expect(runtime).toHaveLength(1)
    expect(runtime[0].modules).toEqual([
      `${directory}/src/a.ts`,
      `${directory}/src/b.ts`,
    ])
    expect(
      compareCycleBaseline(
        { cycles: runtime, coreSelfImports: [] },
        { cycles: [], coreSelfImports: [] }
      )
    ).toHaveLength(1)
    writeFileSync(
      join(directory, "src/a.ts"),
      'import type { B } from "@/b"; export type A = { b?: B };'
    )
    writeFileSync(
      join(directory, "src/b.ts"),
      'import type { A } from "./a"; export type B = { a?: A };'
    )
    expect(findRuntimeCycles(await collectRuntimeGraph([directory]))).toEqual(
      []
    )
    mkdirSync(join(directory, "src/build"))
    writeFileSync(join(directory, "src/a.ts"), 'import "./build/b";')
    writeFileSync(join(directory, "src/build/b.ts"), 'import "../a";')
    expect(
      findRuntimeCycles(await collectRuntimeGraph([directory]))
    ).toHaveLength(1)
    writeFileSync(join(directory, "src/a.ts"), 'import "./missing";')
    await expect(collectRuntimeGraph([directory])).rejects.toThrow(
      "Unresolved internal dependency"
    )
  } finally {
    removeFixture(directory)
  }
}, 30_000)

test("core self-import policy sees type, runtime, dynamic and require imports", () => {
  const directory = mkdtempSync("packages/.cycle-guard-fixture-")
  try {
    writeFileSync(
      join(directory, "sample.ts"),
      'import type { A } from "@conduit/core"; export { b } from "@conduit/core/b"; const c = import("@conduit/core/c"); const d = require("@conduit/core/d"); type E = import("@conduit/core/e").E; const description = "@conduit/core/not-an-import"; import(`@conduit/core/template`); import alias = require("@conduit/core/alias");'
    )
    const imports = collectCoreSelfImports(directory)
    expect(imports).toHaveLength(7)
    expect(imports.some((entry) => entry.endsWith("not-an-import"))).toBe(false)
    expect(
      compareCycleBaseline(
        { cycles: [], coreSelfImports: imports },
        { cycles: [], coreSelfImports: [] }
      )
    ).toHaveLength(7)
  } finally {
    removeFixture(directory)
  }
})

test("workspace discovery includes new packages and ignores non-package output", () => {
  const directory = mkdtempSync("packages/.cycle-guard-fixture-")
  try {
    for (const name of ["new-app", "new-library", "generated"])
      mkdirSync(join(directory, name))
    for (const name of ["new-app", "new-library"])
      writeFileSync(join(directory, name, "package.json"), "{}")
    expect(discoverDependencyProjects([directory])).toEqual(
      [join(directory, "new-app"), join(directory, "new-library")].map((path) =>
        path.replaceAll("\\", "/")
      )
    )
  } finally {
    removeFixture(directory)
  }
})

test("an empty dependency project list cannot produce a green graph", async () => {
  await expect(collectRuntimeGraph([])).rejects.toThrow(
    "No dependency projects"
  )
})

test("CLI reports failures without accepting or overwriting its baseline", () => {
  const directory = mkdtempSync(join(tmpdir(), "conduit-cycle-cli-"))
  const baseline = join(directory, "scripts/ci/dependency_cycle_baseline.json")
  const empty = JSON.stringify({ cycles: [], coreSelfImports: [] })
  const cli = resolve("scripts/ci/check_dependency_cycles.ts")
  try {
    mkdirSync(join(directory, "packages/core/src"), { recursive: true })
    mkdirSync(join(directory, "apps"))
    mkdirSync(join(directory, "scripts/ci"), { recursive: true })
    writeFileSync(
      join(directory, "packages/core/package.json"),
      '{"name":"@conduit/core"}'
    )
    writeFileSync(
      join(directory, "packages/core/tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext" },
        include: ["src/**/*"],
      })
    )
    writeFileSync(
      join(directory, "packages/core/src/index.ts"),
      'import "./b";'
    )
    writeFileSync(
      join(directory, "packages/core/src/b.ts"),
      'import "./index";'
    )
    writeFileSync(baseline, empty)
    const rejected = spawnSync(process.execPath, [cli, "--report", baseline], {
      cwd: directory,
      encoding: "utf8",
    })
    expect(rejected.status).not.toBe(0)
    expect(readFileSync(baseline, "utf8")).toBe(empty)
    const report = join(directory, "report.json")
    const observed = spawnSync(process.execPath, [cli, "--report", report], {
      cwd: directory,
      encoding: "utf8",
    })
    expect(observed.status).toBe(1)
    expect(JSON.parse(readFileSync(report, "utf8")).cycles).toHaveLength(1)
    expect(readFileSync(baseline, "utf8")).toBe(empty)
  } finally {
    removeFixture(directory, join(tmpdir(), "conduit-cycle-cli-"))
  }
}, 30_000)

test("workspace manifest aliases expose a cross-package cycle", async () => {
  const directory = mkdtempSync("packages/.cycle-guard-fixture-").replaceAll(
    "\\",
    "/"
  )
  try {
    const projects = ["left", "right"].map((name) => `${directory}/${name}`)
    for (const [index, project] of projects.entries()) {
      mkdirSync(`${project}/src`, { recursive: true })
      writeFileSync(
        `${project}/package.json`,
        JSON.stringify({ name: `@conduit/guard-${index}` })
      )
      writeFileSync(
        `${project}/tsconfig.json`,
        JSON.stringify({
          compilerOptions: { module: "ESNext", target: "ES2022" },
          include: ["src/**/*"],
        })
      )
      writeFileSync(
        `${project}/src/index.ts`,
        `import "@conduit/guard-${1 - index}";`
      )
    }
    expect(findRuntimeCycles(await collectRuntimeGraph(projects))).toHaveLength(
      1
    )
    writeFileSync(`${projects[0]}/src/index.ts`, 'import "~/missing";')
    await expect(collectRuntimeGraph(projects)).rejects.toThrow(
      "Unresolved internal dependency"
    )
  } finally {
    removeFixture(directory)
  }
}, 30_000)

test("a discovered project with no source modules fails closed", async () => {
  const directory = mkdtempSync("packages/.cycle-guard-fixture-").replaceAll(
    "\\",
    "/"
  )
  try {
    writeFileSync(`${directory}/config.ts`, "export default {}")
    writeFileSync(
      `${directory}/tsconfig.json`,
      JSON.stringify({ include: ["*.ts"] })
    )
    await expect(collectRuntimeGraph([directory])).rejects.toThrow(
      "contributed no source modules"
    )
  } finally {
    removeFixture(directory)
  }
})
