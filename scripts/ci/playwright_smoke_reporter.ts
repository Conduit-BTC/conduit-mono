import { chmodSync, readFileSync, writeFileSync } from "node:fs"

import ts from "typescript"

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter"

type ReporterOptions = {
  outputFile: string
}

type SafeSmokeEvidence = {
  baseSha: string
  sourceHeadSha: string
  testedSha: string
}

type SafeLocation = {
  column?: number
  file: string
  line?: number
}

type SafeResult = {
  duration: number
  error?: { location: SafeLocation }
  retry: number
  status: TestResult["status"]
}

type SafeSpec = {
  file: string
  line: number
  ok: boolean
  tags: string[]
  tests: Array<{
    expectedStatus: TestCase["expectedStatus"]
    results: SafeResult[]
    status: ReturnType<TestCase["outcome"]>
  }>
  title: string
}

const approvedAreaTags = ["@market", "@merchant", "@commerce"] as const
const approvedAreaTagSet = new Set<string>(approvedAreaTags)
const redactedTitle = "redacted smoke test"
const gitObjectIdPattern = /^[0-9a-f]{40}$/
const unsafeTitlePatterns = [
  /\b(?:bunker|nostrconnect|nostr\+walletconnect):\/\//i,
  /\b(?:naddr1|nevent1|nprofile1|npub1|nsec1)[0-9a-z]{16,}\b/i,
  /\b(?:lnbc|lnbcrt|lntb)[0-9a-z]{20,}\b/i,
  /\b[0-9a-f]{40,}\b/i,
  /[A-Za-z0-9_-]{32,}/,
  /(?:^|[?&])(?:code|key|secret|token)=/i,
] as const

const allowlistedDynamicTitles: Readonly<Record<string, readonly RegExp[]>> = {
  "e2e/about-page.playwright.ts": [
    /^(market|merchant) signed-out About renders visitor content in the public app shell @\1$/,
    /^(market|merchant) signed-out About remains usable at a mobile viewport @\1$/,
  ],
  "e2e/client-error-telemetry.playwright.ts": [
    /^(market|merchant) client-error telemetry covers runtime, boundary, and host gates @\1$/,
  ],
  "e2e/network-settings-ui.playwright.ts": [
    /^(market|merchant) (?:desktop|mobile) reconstructs signed Network preferences despite obsolete local settings @\1$/,
    /^(market|merchant) (?:desktop|mobile) warns before discarding unpublished relay edits @\1$/,
  ],
  "e2e/product-legal.playwright.ts": [
    /^(market|merchant) \/(?:privacy-policy|terms-of-service) is public and isolated @\1$/,
    /^(market|merchant) \/(?:privacy-policy|terms-of-service)\/ keeps the legal startup boundary @\1$/,
    /^merchant \/(?:privacy-policy|terms-of-service) bypasses (?:restoring|signed_in) signer state @merchant$/,
    /^(market|merchant) \/(?:privacy-policy|terms-of-service) remains usable at a mobile viewport @\1$/,
  ],
  "e2e/theme-selection.playwright.ts": [
    /^Market theme toggle briefly swaps its icon for the selected label @market$/,
    /^Merchant theme toggle briefly swaps its icon for the selected label @merchant$/,
  ],
}

const staticTitleCache = new Map<
  string,
  readonly { line: number; title: string }[]
>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeSmokeEvidence(metadata: unknown): SafeSmokeEvidence | null {
  if (!isRecord(metadata) || !isRecord(metadata.smokeEvidence)) return null
  const { baseSha, sourceHeadSha, testedSha } = metadata.smokeEvidence
  if (
    typeof baseSha !== "string" ||
    typeof sourceHeadSha !== "string" ||
    typeof testedSha !== "string" ||
    !gitObjectIdPattern.test(baseSha) ||
    !gitObjectIdPattern.test(sourceHeadSha) ||
    !gitObjectIdPattern.test(testedSha)
  ) {
    return null
  }
  return { baseSha, sourceHeadSha, testedSha }
}

function safeMetadata(metadata: unknown): Record<string, unknown> {
  const smokeEvidence = safeSmokeEvidence(metadata)
  return smokeEvidence ? { smokeEvidence } : {}
}

function safeTags(tags: readonly string[]): string[] {
  const provided = new Set(
    tags.map((tag) => (tag.startsWith("@") ? tag : `@${tag}`))
  )
  return approvedAreaTags.filter((tag) => provided.has(tag))
}

function isPlaywrightTestCall(expression: ts.Expression): boolean {
  let current = expression
  while (ts.isPropertyAccessExpression(current)) current = current.expression
  return ts.isIdentifier(current) && current.text === "test"
}

function staticTitlesForFile(
  file: string
): readonly { line: number; title: string }[] {
  const cached = staticTitleCache.get(file)
  if (cached) return cached

  const titles: Array<{ line: number; title: string }> = []
  try {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        isPlaywrightTestCall(node.expression) &&
        node.arguments[0] &&
        (ts.isStringLiteral(node.arguments[0]) ||
          ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
      ) {
        titles.push({
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          title: node.arguments[0].text,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  } catch {
    // Unreadable or generated sources do not earn a title serialization path.
  }
  staticTitleCache.set(file, titles)
  return titles
}

function hasOnlyApprovedTitleTags(title: string): boolean {
  return Array.from(title.matchAll(/@[A-Za-z0-9_-]+/g)).every((match) =>
    approvedAreaTagSet.has(match[0])
  )
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function safeTitle(test: TestCase, file: string): string {
  const title = test.title
  if (
    title.length === 0 ||
    title.length > 240 ||
    hasControlCharacter(title) ||
    !hasOnlyApprovedTitleTags(title) ||
    unsafeTitlePatterns.some((pattern) => pattern.test(title))
  ) {
    return redactedTitle
  }

  const isStaticLiteral = staticTitlesForFile(test.location.file).some(
    (candidate) =>
      candidate.line === test.location.line && candidate.title === title
  )
  const isAllowlistedDynamic = (allowlistedDynamicTitles[file] ?? []).some(
    (pattern) => pattern.test(title)
  )
  return isStaticLiteral || isAllowlistedDynamic ? title : redactedTitle
}

function safeFile(file: string | undefined): string {
  if (!file) return "unknown"
  const normalized = file.replaceAll("\\", "/")
  const e2eIndex = normalized.lastIndexOf("/e2e/")
  if (e2eIndex >= 0) return normalized.slice(e2eIndex + 1)
  return normalized.startsWith("e2e/") ? normalized : "unknown"
}

function safeLocation(
  location: TestError["location"] | undefined
): SafeLocation | undefined {
  if (!location) return undefined
  const file = safeFile(location.file)
  if (file === "unknown") return undefined
  return {
    file,
    ...(location.line ? { line: location.line } : {}),
    ...(location.column ? { column: location.column } : {}),
  }
}

/**
 * CI evidence reporter with an intentionally narrow schema.
 *
 * It never serializes error text, stdio, steps, attachments, page URLs, or
 * browser state. The full runner output remains suppressed and this file is
 * deleted after the content-free smoke verifier consumes it.
 */
export class PrivacySafeSmokeReporter implements Reporter {
  private readonly outputFile: string
  private metadata: Record<string, unknown> = {}
  private readonly specs = new Map<string, SafeSpec>()
  private topLevelErrorCount = 0

  constructor(options: ReporterOptions) {
    this.outputFile = options.outputFile
  }

  printsToStdio(): boolean {
    return true
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    void _suite
    this.metadata = safeMetadata(config.metadata)
  }

  onError(_error: TestError): void {
    void _error
    this.topLevelErrorCount += 1
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const existing = this.specs.get(test.id)
    const location = safeLocation(result.error?.location)
    const safeResult: SafeResult = {
      duration: Math.max(0, Math.round(result.duration)),
      retry: Math.max(0, result.retry),
      status: result.status,
      ...(location ? { error: { location } } : {}),
    }
    if (existing) {
      existing.ok = test.ok()
      existing.tests[0]!.status = test.outcome()
      existing.tests[0]!.results.push(safeResult)
      return
    }

    const file = safeFile(test.location.file)
    this.specs.set(test.id, {
      file,
      line: test.location.line,
      ok: test.ok(),
      tags: safeTags(test.tags),
      tests: [
        {
          expectedStatus: test.expectedStatus,
          results: [safeResult],
          status: test.outcome(),
        },
      ],
      title: safeTitle(test, file),
    })
  }

  onEnd(_result: FullResult): void {
    void _result
    const specs = [...this.specs.values()]
    const outcomes = specs.map((spec) => spec.tests[0]!.status)
    const report = {
      config: { metadata: this.metadata },
      errors: Array.from({ length: this.topLevelErrorCount }, () => ({})),
      stats: {
        flaky: outcomes.filter((outcome) => outcome === "flaky").length,
        skipped: outcomes.filter((outcome) => outcome === "skipped").length,
        unexpected: outcomes.filter((outcome) => outcome === "unexpected")
          .length,
      },
      suites: [{ specs }],
    }

    writeFileSync(this.outputFile, `${JSON.stringify(report)}\n`, {
      mode: 0o600,
    })
    chmodSync(this.outputFile, 0o600)
  }
}

export default PrivacySafeSmokeReporter
