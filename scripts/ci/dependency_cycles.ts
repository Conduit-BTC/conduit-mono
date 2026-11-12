import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import {
  cruise,
  getAvailableTranspilers,
  type IFlattenedRuleSet,
  type ICruiseResult,
} from "dependency-cruiser"
import ts from "typescript"
import configuration from "../../.dependency-cruiser.json"

export type RuntimeCycle = { modules: string[]; edges: string[] }
export type CycleBaseline = {
  cycles: RuntimeCycle[]
  coreSelfImports: string[]
}
const normalize = (path: string) => path.replaceAll("\\", "/")
const firstParty = (path: string) => /^(apps|packages)\//.test(path)

/** Eager and literal dynamic imports both participate; type-erased imports do not. */
export function findRuntimeCycles(graph: ICruiseResult): RuntimeCycle[] {
  const edges = new Map<string, Set<string>>()
  for (const module of graph.modules) {
    const source = normalize(module.source)
    if (!firstParty(source)) continue
    const dependencies = edges.get(source) ?? new Set<string>()
    for (const dependency of module.dependencies) {
      if (dependency.preCompilationOnly) continue
      const target = normalize(dependency.resolved)
      if (firstParty(target) && !dependency.couldNotResolve)
        dependencies.add(target)
    }
    edges.set(source, dependencies)
  }
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const active = new Set<string>()
  const cycles: RuntimeCycle[] = []
  function visit(source: string) {
    indices.set(source, index)
    low.set(source, index++)
    stack.push(source)
    active.add(source)
    for (const target of edges.get(source) ?? []) {
      if (!indices.has(target)) {
        visit(target)
        low.set(source, Math.min(low.get(source)!, low.get(target)!))
      } else if (active.has(target)) {
        low.set(source, Math.min(low.get(source)!, indices.get(target)!))
      }
    }
    if (low.get(source) !== indices.get(source)) return
    const modules: string[] = []
    let target: string
    do {
      target = stack.pop()!
      active.delete(target)
      modules.push(target)
    } while (target !== source)
    if (modules.length === 1 && !edges.get(source)?.has(source)) return
    modules.sort()
    const members = new Set(modules)
    const internal = modules.flatMap((from) =>
      [...(edges.get(from) ?? [])]
        .filter((to) => members.has(to))
        .map((to) => `${from} -> ${to}`)
    )
    cycles.push({ modules, edges: internal.sort() })
  }
  for (const source of [...edges.keys()].sort())
    if (!indices.has(source)) visit(source)
  return cycles.sort((a, b) => a.modules[0].localeCompare(b.modules[0]))
}

export function compareCycleBaseline(
  actual: CycleBaseline,
  baseline: CycleBaseline
): string[] {
  const signatures = (cycles: RuntimeCycle[]) =>
    cycles.map((c) => JSON.stringify(c))
  const expected = new Set(signatures(baseline.cycles))
  const observed = new Set(signatures(actual.cycles))
  const problems = [...observed]
    .filter((c) => !expected.has(c))
    .map(
      (c) => `New or changed runtime cycle: ${JSON.parse(c).modules.join(", ")}`
    )
  for (const c of expected)
    if (!observed.has(c))
      problems.push(
        `Remove obsolete cycle baseline: ${JSON.parse(c).modules.join(", ")}`
      )
  const allowedSelf = new Set(baseline.coreSelfImports)
  const actualSelf = new Set(actual.coreSelfImports)
  for (const entry of actualSelf)
    if (!allowedSelf.has(entry)) problems.push(`Core self-import: ${entry}`)
  for (const entry of allowedSelf)
    if (!actualSelf.has(entry))
      problems.push(`Remove obsolete self-import baseline: ${entry}`)
  return problems
}

export function collectCoreSelfImports(root = "packages/core/src"): string[] {
  const imports: string[] = []
  function walk(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/\.[cm]?[jt]sx?$/.test(file)) {
        const source = ts.createSourceFile(
          file,
          readFileSync(file, "utf8"),
          ts.ScriptTarget.Latest,
          true
        )
        function visit(node: ts.Node) {
          if (
            ts.isStringLiteralLike(node) &&
            /^@conduit\/core(?:\/|$)/.test(node.text)
          ) {
            const parent = node.parent
            if (
              (ts.isExternalModuleReference(parent) &&
                parent.expression === node) ||
              ((ts.isImportDeclaration(parent) ||
                ts.isExportDeclaration(parent)) &&
                parent.moduleSpecifier === node) ||
              (ts.isCallExpression(parent) &&
                parent.arguments[0] === node &&
                (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  (ts.isIdentifier(parent.expression) &&
                    parent.expression.text === "require"))) ||
              (ts.isLiteralTypeNode(parent) &&
                ts.isImportTypeNode(parent.parent))
            )
              imports.push(`${normalize(file)} -> ${node.text}`)
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
  }
  walk(root)
  return [...new Set(imports)].sort()
}

/** Discover current workspace packages so a new app cannot silently evade CI. */
export function discoverDependencyProjects(
  roots = ["packages", "apps"]
): string[] {
  return roots
    .flatMap((root) =>
      readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(join(root, entry.name, "package.json"))
        )
        .map((entry) => normalize(join(root, entry.name)))
    )
    .sort()
}

/** Reports may not become an implicit baseline acceptance command. */
export function validateCycleReportPath(
  path: string,
  baselinePath: string
): string {
  const canonical = (file: string) => {
    const absolute = resolve(file)
    const physical = existsSync(absolute)
      ? realpathSync(absolute)
      : join(realpathSync(dirname(absolute)), basename(absolute))
    return process.platform === "win32" ? physical.toLowerCase() : physical
  }
  if (canonical(path) === canonical(baselinePath))
    throw new Error("Cycle report cannot overwrite the baseline")
  return path
}

export async function collectRuntimeGraph(
  projects = discoverDependencyProjects()
): Promise<ICruiseResult> {
  if (projects.length === 0)
    throw new Error("No dependency projects discovered")
  if (
    !getAvailableTranspilers().some(
      (t) => t.name === "typescript" && t.available
    )
  )
    throw new Error(
      "dependency-cruiser requires a supported TypeScript transpiler; refusing a loose-parser graph"
    )
  const modules: ICruiseResult["modules"] = []
  const sourceAliases: Record<string, string> = {}
  const externals = new Set<string>()
  for (const file of [
    "package.json",
    ...projects.map((project) => `${project}/package.json`),
  ]) {
    if (!existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      for (const name of Object.keys(manifest[field] ?? {})) externals.add(name)
    if (file !== "package.json" && manifest.name)
      sourceAliases[manifest.name] = resolve(dirname(file), "src")
  }
  for (const name of Object.keys(sourceAliases)) externals.delete(name)
  for (const project of projects) {
    const file = `${project}/tsconfig.json`
    const config = ts.readConfigFile(file, ts.sys.readFile)
    if (config.error) throw new Error(`Cannot read dependency project ${file}`)
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      resolve(project),
      undefined,
      resolve(file)
    )
    if (parsed.errors.length)
      throw new Error(`Invalid dependency project ${file}`)
    const resolveOptions = {
      tsConfig: file,
      alias: {
        ...sourceAliases,
        "@": resolve(project, "src"),
      },
    }
    const result = await cruise(
      [project],
      {
        ...configuration.options,
        tsConfig: { fileName: file },
        ruleSet: configuration as IFlattenedRuleSet,
        outputType: "json",
      },
      resolveOptions,
      {
        tsConfig: {
          ...parsed,
          options: {
            ...parsed.options,
            // transpileModule strips the parser's internal pathsBasePath;
            // supply its explicit base for TS path-aware diagnostics.
            baseUrl: parsed.options.baseUrl ?? resolve(project),
          },
        },
      }
    )
    const graph =
      typeof result.output === "string"
        ? (JSON.parse(result.output) as ICruiseResult)
        : result.output
    if (
      !graph.modules.some((module) =>
        normalize(module.source).startsWith(`${project}/src/`)
      )
    )
      throw new Error(
        `Dependency project contributed no source modules: ${project}`
      )
    if (
      project === "packages/core" &&
      !graph.modules.some(
        (module) => normalize(module.source) === "packages/core/src/index.ts"
      )
    )
      throw new Error("Dependency graph is missing the Core entrypoint")
    for (const module of graph.modules) {
      if (!firstParty(normalize(module.source))) continue
      for (const dependency of module.dependencies) {
        if (
          dependency.couldNotResolve &&
          !dependency.module.startsWith("node:") &&
          !dependency.module.startsWith("bun:") &&
          dependency.module !== "virtual:conduit-repository-contributors" &&
          !externals.has(
            dependency.module.startsWith("@")
              ? dependency.module.split("/").slice(0, 2).join("/")
              : dependency.module.split("/")[0]
          ) &&
          !/\.(css|svg|png|jpe?g|webp|ico)(\?|$)/.test(dependency.module)
        )
          throw new Error(
            `Unresolved internal dependency: ${module.source} -> ${dependency.module}`
          )
      }
      modules.push(module)
    }
  }
  // Shared modules can occur in several project graphs. SCC construction unions
  // their edges, preserving all observations rather than last-writer overwrites.
  return { modules, summary: {} } as ICruiseResult
}
