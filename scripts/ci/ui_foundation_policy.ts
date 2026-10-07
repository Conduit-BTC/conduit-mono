import { createHash } from "node:crypto"
import ts from "typescript"

export type UiSource = { path: string; content: string }
export type UiFinding = {
  path: string
  line: number
  rule:
    | "undefined-variable"
    | "theme-owner"
    | "presentation-color"
    | "local-control"
  value: string
}
export type UiException = {
  path: string
  rule: UiFinding["rule"]
  value: string
  count: number
  reason: string
}

const tokenOwners = new Set([
  "packages/ui/src/styles/theme.css",
  "packages/ui/src/styles/typography.css",
])
// Radix supplies these at the mounted control boundary; they are not theme tokens.
const runtimeVariables = new Set([
  "--radix-select-trigger-width",
  "--radix-select-trigger-height",
  "--radix-select-content-available-height",
  "--radix-popover-trigger-width",
  "--radix-popover-content-available-height",
])
const paletteColor =
  /\b(?:bg|text|border|ring|shadow|fill|stroke|from|to|via|outline|decoration|divide|placeholder|accent|caret)-(?:slate|gray|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d+)?\b/g
const nativeControls = new Set(["button", "input", "select", "textarea"])
const sharedControlRoles = new Set([
  "dialog",
  "alertdialog",
  "combobox",
  "listbox",
  "menu",
  "menubar",
  "tab",
  "tablist",
])

export function controlSignature(text: string): string {
  return createHash("sha256")
    .update(text.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16)
}

export function inspectUiSources(sources: UiSource[]): UiFinding[] {
  const definitions = new Set(runtimeVariables)
  const ownedTokens = new Set<string>()
  for (const { path, content } of sources) {
    for (const match of content.matchAll(/["']?(--[\w-]+)["']?\s*:/g)) {
      definitions.add(match[1])
      if (tokenOwners.has(path)) ownedTokens.add(match[1])
    }
    for (const match of content.matchAll(
      /\.setProperty\(\s*["'](--[\w-]+)["']/g
    )) {
      definitions.add(match[1])
    }
  }

  const findings: UiFinding[] = []
  for (const { path, content } of sources) {
    const add = (rule: UiFinding["rule"], value: string, position: number) => {
      findings.push({
        path,
        rule,
        value,
        line: content.slice(0, position).split("\n").length,
      })
    }
    for (const match of content.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!definitions.has(match[1]))
        add("undefined-variable", match[1], match.index)
    }
    if (!tokenOwners.has(path)) {
      for (const match of content.matchAll(
        /:root\s*\[data-theme[^\]]*\]\s*\{/g
      )) {
        add("theme-owner", "named theme selector", match.index)
      }
      for (const match of content.matchAll(/["']?(--[\w-]+)["']?\s*:/g)) {
        if (ownedTokens.has(match[1])) add("theme-owner", match[1], match.index)
      }
      for (const match of content.matchAll(
        /\.setProperty\(\s*["'](--[\w-]+)["']/g
      )) {
        if (ownedTokens.has(match[1])) add("theme-owner", match[1], match.index)
      }
    }
    if (path.endsWith(".css")) {
      for (const match of content.matchAll(paletteColor))
        add("presentation-color", match[0], match.index)
      continue
    }
    paletteColor.lastIndex = 0
    const hasPalette = paletteColor.test(content)
    paletteColor.lastIndex = 0
    const hasControls =
      path.startsWith("apps/") &&
      /<(?:button|input|select|textarea)\b|\brole\s*=/.test(content)
    if (!hasPalette && !hasControls && !path.endsWith("tailwind.config.js"))
      continue
    const source = ts.createSourceFile(
      path,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    const visit = (node: ts.Node) => {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        for (const match of node.text.matchAll(paletteColor))
          add("presentation-color", match[0], node.getStart(source))
      }
      if (
        path.startsWith("apps/") &&
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      ) {
        const role = node.attributes.properties.find(
          (attr) =>
            ts.isJsxAttribute(attr) && attr.name.getText(source) === "role"
        )
        const localRole =
          role &&
          ts.isJsxAttribute(role) &&
          role.initializer &&
          ts.isStringLiteral(role.initializer) &&
          sharedControlRoles.has(role.initializer.text)
        if (nativeControls.has(node.tagName.getText(source)) || localRole) {
          add(
            "local-control",
            controlSignature(node.getText(source)),
            node.getStart(source)
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (/^apps\/[^/]+\/tailwind\.config\.js$/.test(path)) {
      // App content scanning remains local; all theme mapping belongs in the preset.
      if (
        /\btheme\s*:/.test(content) ||
        !content.includes("presets: [conduitPreset]") ||
        !content.includes("../../packages/ui/tailwind.preset.js")
      ) {
        add("theme-owner", "app Tailwind preset", 0)
      }
    }
  }
  return findings
}

export function applyUiExceptions(
  findings: UiFinding[],
  exceptions: UiException[]
): string[] {
  const errors: string[] = []
  const key = (entry: Pick<UiFinding, "path" | "rule" | "value">) =>
    `${entry.path}:${entry.rule}:${entry.value}`
  const counts = new Map<string, number>()
  for (const finding of findings)
    counts.set(key(finding), (counts.get(key(finding)) ?? 0) + 1)
  const allowed = new Map<string, UiException>()
  for (const exception of exceptions) {
    if (
      !exception.reason.trim() ||
      exception.count < 1 ||
      allowed.has(key(exception))
    )
      errors.push(`Invalid UI exception: ${key(exception)}`)
    allowed.set(key(exception), exception)
    const actual = counts.get(key(exception)) ?? 0
    if (actual < exception.count)
      errors.push(`Remove or narrow stale UI exception: ${key(exception)}`)
  }
  for (const finding of findings) {
    const exception = allowed.get(key(finding))
    if (!exception || (counts.get(key(finding)) ?? 0) > exception.count) {
      errors.push(
        `${finding.path}:${finding.line} [${finding.rule}] ${finding.value}`
      )
    }
  }
  return [...new Set(errors)]
}

export async function readUiSources(): Promise<UiSource[]> {
  const sources: UiSource[] = []
  for (const root of [
    "apps/*/src",
    "packages/ui/src",
    "packages/ui/workbench",
  ]) {
    const glob = new Bun.Glob(`${root}/**/*.{ts,tsx,js,jsx,css}`)
    for await (const path of glob.scan({ onlyFiles: true })) {
      if (path.includes("/dist/") || path.endsWith(".gen.ts")) continue
      sources.push({ path, content: await Bun.file(path).text() })
    }
  }
  for (const app of ["market", "merchant", "store-builder"]) {
    const path = `apps/${app}/tailwind.config.js`
    sources.push({ path, content: await Bun.file(path).text() })
  }
  return sources.sort((a, b) => a.path.localeCompare(b.path))
}
