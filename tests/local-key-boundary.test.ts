import { describe, expect, test } from "bun:test"
import * as ts from "typescript"
import * as local from "../packages/core/src/protocol/local-key"

const directory = "packages/core/src/protocol/local-key/"

describe("local account secret containment", () => {
  test("the entry API has no raw-key constructor, getter or serialization operation", async () => {
    expect(Object.keys(local).sort()).toEqual([
      "LOCAL_KEY_CAPABILITIES",
      "prepareLocalKeyImport",
      "removeLocalKeyRecord",
      "restoreLocalKeySigner",
    ])
    const source = await Bun.file(`${directory}index.ts`).text()
    const ast = ts.createSourceFile(
      "index.ts",
      source,
      ts.ScriptTarget.Latest,
      true
    )
    for (const statement of ast.statements) {
      if (
        !ts.canHaveModifiers(statement) ||
        !ts
          .getModifiers(statement)
          ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        continue
      if (ts.isClassDeclaration(statement))
        throw new Error("LOCAL_KEY_CONSTRUCTOR_EXPOSED")
      if (ts.isFunctionDeclaration(statement)) {
        for (const parameter of statement.parameters) {
          expect(
            /Uint8Array|\bstring\b/.test(parameter.type?.getText(ast) ?? "")
          ).toBe(false)
        }
      }
    }
    const manifest = await Bun.file("packages/core/package.json").json()
    expect(
      manifest.exports["./protocol/local-key"] === null &&
        manifest.exports["./protocol/local-key/*"] === null
    ).toBe(true)
    expect(
      (await Bun.file("packages/core/src/protocol/index.ts").text()).includes(
        'from "./local-key'
      )
    ).toBe(false)
  })

  test("key handling uses a fixed mature dependency surface and no disclosure sinks", async () => {
    const allowed = new Set([
      "nostr-tools/pure",
      "nostr-tools/nip19",
      "nostr-tools/nip44",
      "nostr-tools/nip04",
      "../nostr-event-signer",
      "./storage",
    ])
    for (const file of ["index.ts", "storage.ts"]) {
      const source = await Bun.file(directory + file).text()
      const ast = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true
      )
      for (const statement of ast.statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier)
        )
          expect(allowed.has(statement.moduleSpecifier.text)).toBe(true)
      }
      expect(
        /\b(?:console|fetch|WebSocket|XMLHttpRequest|postMessage|localStorage|sessionStorage)\b/.test(
          source
        )
      ).toBe(false)
      expect(
        /\b(?:JSON\.stringify|nsecEncode|generateSecretKey|secretKeyToHex)\s*\(/.test(
          source
        )
      ).toBe(false)
    }
  })

  test("product code cannot import storage or introduce a standalone signer dependency", async () => {
    const imports: string[] = []
    for await (const file of new Bun.Glob(
      "{apps,packages}/**/src/**/*.{ts,tsx}"
    ).scan(".")) {
      if (file.startsWith(directory)) continue
      const source = await Bun.file(file).text()
      if (/from\s+["'][^"']*local-key(?:\/storage|\/index)?["']/.test(source))
        imports.push(file)
      expect(
        /(?:signer\.conduit\.market|conduit-signer|frame-ancestors)/.test(
          source
        )
      ).toBe(false)
    }
    expect(imports.sort()).toEqual([
      "packages/core/src/context/AuthContext.tsx",
      "packages/core/src/protocol/auth-session-lifecycle.ts",
    ])
    for (const file of [
      "package.json",
      "packages/core/package.json",
      "bun.lock",
    ]) {
      expect((await Bun.file(file).text()).includes("conduit-signer")).toBe(
        false
      )
    }
  })

  test("the password input forwards only its element, never a controlled value or diagnostic", async () => {
    const source = await Bun.file(
      "packages/ui/src/components/LocalKeyImportForm.tsx"
    ).text()
    expect(
      source.includes('type="password"') &&
        source.includes("data-ph-no-capture")
    ).toBe(true)
    expect(
      /\bonChange=|\bvalue=|\.value(?!\s*=\s*"")|\bconsole\./.test(source)
    ).toBe(false)
    const env = await Bun.file(".env.example").text()
    expect(env.includes("VITE_ENABLE_LOCAL_KEY_SIGNER=false")).toBe(true)
  })
})
