import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ICruiseResult } from "dependency-cruiser"
import {
  collectCoreSelfImports,
  collectRuntimeGraph,
  compareCycleBaseline,
  findRuntimeCycles,
  type CycleBaseline,
} from "../scripts/ci/dependency_cycles"

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
    writeFileSync(join(directory, "src/a.ts"), 'import "./missing";')
    await expect(collectRuntimeGraph([directory])).rejects.toThrow(
      "Unresolved internal dependency"
    )
  } finally {
    if (
      !resolve(directory).startsWith(resolve("packages/.cycle-guard-fixture-"))
    )
      throw new Error("Unexpected fixture path")
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

test("core self-import policy sees type, runtime, dynamic and require imports", () => {
  const directory = mkdtempSync("packages/.cycle-guard-fixture-")
  try {
    writeFileSync(
      join(directory, "sample.ts"),
      'import type { A } from "@conduit/core"; export { b } from "@conduit/core/b"; const c = import("@conduit/core/c"); const d = require("@conduit/core/d"); type E = import("@conduit/core/e").E; const description = "@conduit/core/not-an-import";'
    )
    const imports = collectCoreSelfImports(directory)
    expect(imports).toHaveLength(5)
    expect(imports.some((entry) => entry.endsWith("not-an-import"))).toBe(false)
    expect(
      compareCycleBaseline(
        { cycles: [], coreSelfImports: imports },
        { cycles: [], coreSelfImports: [] }
      )
    ).toHaveLength(5)
  } finally {
    if (
      !resolve(directory).startsWith(resolve("packages/.cycle-guard-fixture-"))
    )
      throw new Error("Unexpected fixture path")
    rmSync(directory, { recursive: true, force: true })
  }
})
