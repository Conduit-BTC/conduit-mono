import { describe, expect, it } from "bun:test"
import { ESLint } from "eslint"
import {
  applyUiExceptions,
  inspectUiSources,
  readUiSources,
  type UiException,
} from "../scripts/ci/ui_foundation_policy"

const owner = {
  path: "packages/ui/src/styles/theme.css",
  content: ":root { --surface: white; --foreground: black; }",
}
const appPath = "apps/market/src/routes/example.tsx"

describe("shared UI foundation policy", () => {
  it("rejects misspelled variables, even with a fallback, and permits declared layout and Radix geometry", () => {
    const findings = inspectUiSources([
      owner,
      {
        path: appPath,
        content:
          'const style = { "--local-height": "10px" }; const classes = "bg-[var(--surfac,white)] h-[var(--local-height)] w-[var(--radix-select-trigger-width)]"',
      },
    ])
    expect(findings.map((finding) => [finding.rule, finding.value])).toEqual([
      ["undefined-variable", "--surfac"],
    ])
  })
  it("rejects duplicate token owners and app-local Tailwind maps", () => {
    const findings = inspectUiSources([
      owner,
      {
        path: "apps/market/src/styles/index.css",
        content: ":root[data-theme=day-market] { --surface: pink; }",
      },
      {
        path: "apps/market/tailwind.config.js",
        content: "export default { theme: { extend: {} } }",
      },
    ])
    expect(findings.every((finding) => finding.rule === "theme-owner")).toBe(
      true
    )
    expect(findings).toHaveLength(3)
  })
  it("catches palette utilities in templates and CSS without treating product data as presentation", () => {
    const findings = inspectUiSources([
      {
        path: appPath,
        content:
          'const data = { color: "blue" }; const classes = `hover:bg-blue-500 ${selected ? "text-red-400" : "text-primary-500"}`',
      },
      {
        path: "apps/market/src/styles/index.css",
        content: ".example { @apply border-emerald-500; }",
      },
    ])
    expect(findings.map((finding) => finding.value)).toEqual([
      "hover:bg-blue-500".slice(6),
      "text-red-400",
      "border-emerald-500",
    ])
  })
  it("uses the real ESLint configuration to reject native and ARIA replacements and stale disables", async () => {
    const eslint = new ESLint()
    const [result] = await eslint.lintText(
      'export const view = <><Select /><button\n onClick={act}>Save</button><div role="dialog" /><textarea /></>',
      { filePath: appPath }
    )
    expect(
      result.messages.filter(
        (message) => message.ruleId === "no-restricted-syntax"
      )
    ).toHaveLength(3)
    const [legacy] = await eslint.lintText(
      "export const view = (\n// eslint-disable-next-line no-restricted-syntax -- Existing control pending adoption.\n<button />\n)",
      { filePath: appPath }
    )
    expect(
      legacy.messages.filter(
        (message) => message.ruleId === "no-restricted-syntax"
      )
    ).toHaveLength(0)
    const [stale] = await eslint.lintText(
      "export const view = (\n// eslint-disable-next-line no-restricted-syntax -- Existing control pending adoption.\n<Button />\n)",
      { filePath: appPath }
    )
    expect(
      stale.messages.some(
        (message) =>
          message.severity === 2 &&
          message.message.includes("Unused eslint-disable")
      )
    ).toBe(true)
  })
  it("requires exact, bounded exceptions with reasons and detects additions and stale entries", () => {
    const finding = {
      path: appPath,
      line: 1,
      rule: "presentation-color" as const,
      value: "text-blue-500",
    }
    const exception = {
      ...finding,
      count: 1,
      reason:
        "Existing provider brand indicator; migration is outside this slice.",
    }
    expect(applyUiExceptions([finding], [exception])).toEqual([])
    expect(applyUiExceptions([finding, finding], [exception])).toHaveLength(1)
    expect(applyUiExceptions([], [exception])).toHaveLength(1)
    expect(
      applyUiExceptions([finding], [{ ...exception, reason: "" }])
    ).toHaveLength(1)
  })
  it("uses readable semantic foreground roles across app and shared surfaces", async () => {
    const sources = await readUiSources()
    const rawForeground =
      /(?:text-\[var\(--(?:info|error)\)\]|text-(?:info|error)(?![\w-]))/g
    expect(
      sources.flatMap((source) =>
        [...source.content.matchAll(rawForeground)].map((match) => ({
          path: source.path,
          value: match[0],
        }))
      )
    ).toEqual([])
  })
  it("enforces the shared foundation across every app and real shared components", async () => {
    const sources = await readUiSources()
    for (const path of [
      owner.path,
      "packages/ui/src/styles/typography.css",
      "packages/ui/workbench/main.tsx",
      "apps/market/src/routes/wallet.tsx",
      "apps/merchant/src/routes/events.tsx",
      "apps/store-builder/src/main.tsx",
    ]) {
      expect(sources.some((source) => source.path === path)).toBe(true)
    }
    const findings = inspectUiSources(sources)
    const exceptions = (await Bun.file(
      "scripts/ci/ui-foundation-exceptions.json"
    ).json()) as UiException[]
    expect(applyUiExceptions(findings, exceptions)).toEqual([])
  })
})
