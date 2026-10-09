import ts from "typescript"
import { resolve } from "node:path"

// Bun erases types. This compiler check ensures the negative API assertions
// are enforced, including raw input rejection and deeply readonly signed tags.
const root = process.cwd()
const config = ts.readConfigFile(
  resolve(root, "packages/core/tsconfig.json"),
  ts.sys.readFile
)
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n")
  )
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  resolve(root, "packages/core")
)
const program = ts.createProgram(
  [
    resolve(root, "tests/types/public-event-boundary.ts"),
    resolve(root, "packages/core/src/vite-env.d.ts"),
  ],
  {
    ...parsed.options,
    noEmit: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    rootDir: root,
  }
)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    })
  )
  process.exitCode = 1
} else console.log("Public event admission type contract passed.")
