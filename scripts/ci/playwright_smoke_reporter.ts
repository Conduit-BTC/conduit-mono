import {
  appendFileSync,
  chmodSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"

import ts from "typescript"
import {
  safeRetainedSmokeFailureContext,
  safeSmokeDiagnostics,
  smokeFailureContextFromAnnotations,
  type SmokeFailureContext,
} from "../../e2e/helpers/smoke-diagnostics"

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter"
import {
  HERMETIC_NETWORK_DIAGNOSTIC_ANNOTATIONS,
  HERMETIC_NETWORK_FAILURE_CATEGORIES,
  HERMETIC_NETWORK_FAILURE_OPERATIONS,
  HERMETIC_NETWORK_FAILURE_SOURCES,
  type HermeticNetworkFailureDiagnostic,
} from "../../e2e/helpers/hermetic-network"
import {
  formatRouterSmokeDiagnostic,
  parseRouterSmokeDiagnostic,
  routerSmokeDiagnosticFromAnnotations,
  type RouterSmokeDiagnostic,
} from "./router_smoke_diagnostic"

type ReporterOptions = {
  outputFile: string
  progressFile?: string
  evidenceFile?: string
  evidence?: SafeSmokeEvidence
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
  diagnostic?: HermeticNetworkFailureDiagnostic
  router?: RouterSmokeDiagnostic
  duration: number
  diagnostics?: Array<Record<string, string | number | boolean>>
  error?: { location: SafeLocation }
  retry: number
  status: TestResult["status"]
  failure?: {
    category: "timeout" | "assertion" | "interrupted" | "unknown"
    context?: SmokeFailureContext
    failedStep?: SafeStep
    lastCompletedStep?: SafeStep
  }
}

type SafeStep = {
  category:
    | "assertion"
    | "browser-operation"
    | "fixture"
    | "setup"
    | "teardown"
    | "test"
    | "unknown"
  location?: SafeLocation
}

function safeStep(step: TestStep): SafeStep {
  const categories: Record<string, SafeStep["category"]> = {
    expect: "assertion",
    "pw:api": "browser-operation",
    fixture: "fixture",
    "test.step": "test",
  }
  const category =
    step.category === "hook"
      ? step.title === "Before Hooks"
        ? "setup"
        : step.title === "After Hooks"
          ? "teardown"
          : "unknown"
      : (categories[step.category] ?? "unknown")
  const location = safeLocation(step.location)
  return { category, ...(location ? { location } : {}) }
}

type SafeSpec = {
  file: string
  line: number
  ok: boolean
  project: string
  smokeId: string
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
const approvedProjects = new Set([
  "chromium",
  "mobile-chromium",
  "mobile-webkit",
])
const approvedHermeticNetworkOperations = new Set<string>(
  HERMETIC_NETWORK_FAILURE_OPERATIONS
)
const approvedHermeticNetworkSources = new Set<string>(
  HERMETIC_NETWORK_FAILURE_SOURCES
)
const approvedHermeticNetworkCategories = new Set<string>(
  HERMETIC_NETWORK_FAILURE_CATEGORIES
)
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
  "e2e/shared-ui-surface-audit.playwright.ts": [
    /^market surface audit in (?:day-market|night-market): \/(?:products|merchants|sellers|zapouts|events|cart|checkout|orders|messages|profile|preferences|wallet|network|about|terms-of-service|privacy-policy)? @market$/,
    /^merchant surface audit in (?:day-market|night-market): \/(?:products|events(?:\/new)?|orders|messages|profile|wallet|shipping|network|about|terms-of-service|privacy-policy)? @merchant$/,
  ],
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

function safeProject(test: TestCase): string {
  const project = test.parent?.project?.()?.name
  return project && approvedProjects.has(project) ? project : "unknown"
}

export function safePlaywrightSmokeId(id: string | undefined): string {
  return id ? createHash("sha256").update(id).digest("hex") : "unknown"
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

export function safePlaywrightSmokeTitle({
  file,
  line,
  sourceFile,
  title,
}: {
  file: string
  line: number
  sourceFile: string
  title: string
}): string {
  if (
    title.length === 0 ||
    title.length > 240 ||
    hasControlCharacter(title) ||
    !hasOnlyApprovedTitleTags(title) ||
    unsafeTitlePatterns.some((pattern) => pattern.test(title))
  ) {
    return redactedTitle
  }

  const isStaticLiteral = staticTitlesForFile(sourceFile).some(
    (candidate) => candidate.line === line && candidate.title === title
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
  const relative = e2eIndex >= 0 ? normalized.slice(e2eIndex + 1) : normalized
  return /^e2e\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(?:playwright\.)?tsx?$/.test(
    relative
  ) &&
    relative.length <= 200 &&
    !unsafeTitlePatterns.some((pattern) => pattern.test(relative))
    ? relative
    : "unknown"
}

function safeLocation(
  location: SafeLocation | undefined
): SafeLocation | undefined {
  if (!location) return undefined
  const file = safeFile(location.file)
  if (file === "unknown") return undefined
  return {
    file,
    ...(Number.isSafeInteger(location.line) && location.line! > 0
      ? { line: location.line }
      : {}),
    ...(Number.isSafeInteger(location.column) && location.column! > 0
      ? { column: location.column }
      : {}),
  }
}

function safeHermeticNetworkDiagnostic(
  annotations: TestResult["annotations"] | undefined
): HermeticNetworkFailureDiagnostic | undefined {
  const operations = (annotations ?? []).filter(
    ({ type }) => type === HERMETIC_NETWORK_DIAGNOSTIC_ANNOTATIONS.operation
  )
  const sources = (annotations ?? []).filter(
    ({ type }) => type === HERMETIC_NETWORK_DIAGNOSTIC_ANNOTATIONS.source
  )
  const categories = (annotations ?? []).filter(
    ({ type }) => type === HERMETIC_NETWORK_DIAGNOSTIC_ANNOTATIONS.category
  )
  if (
    operations.length !== 1 ||
    sources.length !== 1 ||
    categories.length !== 1
  ) {
    return undefined
  }
  const operation = operations[0]?.description
  const source = sources[0]?.description
  const category = categories[0]?.description
  if (
    !operation ||
    !source ||
    !category ||
    !approvedHermeticNetworkOperations.has(operation) ||
    !approvedHermeticNetworkSources.has(source) ||
    !approvedHermeticNetworkCategories.has(category)
  ) {
    return undefined
  }
  return {
    operation: operation as HermeticNetworkFailureDiagnostic["operation"],
    source: source as HermeticNetworkFailureDiagnostic["source"],
    category: category as HermeticNetworkFailureDiagnostic["category"],
  }
}

export function safePlaywrightFailure(
  value: unknown,
  file?: string
): SafeResult["failure"] | undefined {
  if (
    !isRecord(value) ||
    typeof value.category !== "string" ||
    !["timeout", "assertion", "interrupted", "unknown"].includes(value.category)
  )
    return undefined
  const step = (value: unknown): SafeStep | undefined => {
    if (
      !isRecord(value) ||
      typeof value.category !== "string" ||
      ![
        "assertion",
        "browser-operation",
        "fixture",
        "setup",
        "teardown",
        "test",
        "unknown",
      ].includes(value.category)
    )
      return undefined
    const location =
      isRecord(value.location) && typeof value.location.file === "string"
        ? safeLocation(value.location as SafeLocation)
        : undefined
    return {
      category: value.category as SafeStep["category"],
      ...(location ? { location } : {}),
    }
  }
  const failedStep = step(value.failedStep)
  const lastCompletedStep = step(value.lastCompletedStep)
  const context = file
    ? safeRetainedSmokeFailureContext(file, value.context)
    : undefined
  return {
    category: value.category as NonNullable<SafeResult["failure"]>["category"],
    ...(context ? { context } : {}),
    ...(failedStep ? { failedStep } : {}),
    ...(lastCompletedStep ? { lastCompletedStep } : {}),
  }
}

export function safePlaywrightRunnerError(
  value: unknown
):
  | { phase: "startup" | "runner"; category: "web-server" | "unknown" }
  | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    (value.phase !== "startup" && value.phase !== "runner") ||
    (value.category !== "web-server" && value.category !== "unknown")
  )
    return undefined
  return { phase: value.phase, category: value.category }
}

const durationBuckets = [
  "under-1s",
  "1-5s",
  "5-15s",
  "15-30s",
  "30-60s",
  "1-5m",
  "5-15m",
  "15m-plus",
  "unknown",
] as const

/** Lower bounds are inclusive; upper bounds are exclusive. */
export function smokeDurationBucket(
  milliseconds: number
): (typeof durationBuckets)[number] {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown"
  const thresholds = [1000, 5000, 15000, 30000, 60000, 300000, 900000]
  const index = thresholds.findIndex((threshold) => milliseconds < threshold)
  return durationBuckets[index < 0 ? 7 : index]!
}

function retainedDiagnostic(
  diagnostic: Record<string, string | number | boolean>
) {
  const durationFields: Record<string, string> = {
    elapsedSeconds: "elapsedBucket",
    phaseSeconds: "phaseBucket",
    slowestSeconds: "slowestBucket",
  }
  return Object.fromEntries(
    Object.entries(diagnostic).map(([key, value]) => {
      const bucketKey = durationFields[key]
      return bucketKey
        ? [
            bucketKey,
            smokeDurationBucket(typeof value === "number" ? value * 1000 : NaN),
          ]
        : [key, value]
    })
  )
}

export function serializeSmokeEvidence(evidence: unknown): string {
  // Only opaque case hashes and commit identities may contain long hex values.
  const scanned = JSON.stringify(evidence, (key, value) => {
    if (
      key === "duration" ||
      /(?:Ms|Seconds)$/.test(key) ||
      (key.endsWith("Bucket") && !durationBuckets.includes(value))
    ) {
      throw new Error("Smoke evidence contains an unapproved duration field.")
    }
    if (
      ["baseSha", "sourceHeadSha", "testedSha"].includes(key) &&
      typeof value === "string" &&
      gitObjectIdPattern.test(value)
    )
      return "commit"
    if (
      key === "smokeId" &&
      typeof value === "string" &&
      /^[0-9a-f]{64}$/.test(value)
    )
      return "case"
    return value
  })
  if (
    unsafeTitlePatterns.some((pattern) => pattern.test(scanned)) ||
    /https?:\/\/|wss?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(scanned)
  ) {
    throw new Error("Smoke evidence failed the content-safety scan.")
  }
  return `${JSON.stringify(evidence)}\n`
}

/**
 * CI evidence reporter with an intentionally narrow schema.
 *
 * It never serializes error text, stdio, step titles, attachments, page URLs,
 * or browser state. Only the separate title-free evidence file is retained.
 */
export class PrivacySafeSmokeReporter implements Reporter {
  private readonly outputFile: string
  private readonly progressFile?: string
  private readonly evidenceFile?: string
  private metadata: Record<string, unknown> = {}
  private readonly specs = new Map<string, SafeSpec>()
  private startedAt = Date.now()
  private readonly createdAt = Date.now()
  private firstTestAt?: number
  private readonly runnerErrors: Array<{
    phase: "startup" | "runner"
    category: "web-server" | "unknown"
  }> = []
  private readonly steps = new WeakMap<
    TestResult,
    {
      active?: { step: TestStep; value: SafeStep }
      failures?: Array<{ step: TestStep; completed?: SafeStep }>
      completed?: SafeStep
      teardown?: boolean
    }
  >()
  private completedAttempts = 0
  private readonly browserSignals = {
    launched: 0,
    networkProcessCrashed: 0,
    segmentationFault: 0,
    aborted: 0,
    heapCorruption: 0,
  }

  constructor(options: ReporterOptions) {
    this.outputFile = options.outputFile
    this.progressFile = options.progressFile
    this.evidenceFile = options.evidenceFile
    if (this.evidenceFile) rmSync(this.evidenceFile, { force: true })
    this.metadata = safeMetadata({ smokeEvidence: options.evidence })
  }

  printsToStdio(): boolean {
    return true
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.metadata = safeMetadata(config.metadata)
    this.startedAt = Date.now()
    this.progress(`selected=${suite.allTests().length}`)
  }

  private progress(message: string): void {
    if (!this.progressFile) return
    appendFileSync(this.progressFile, `[smoke] ${message}\n`, { mode: 0o600 })
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.firstTestAt ??= Date.now()
    const file = safeFile(test.location.file)
    const title = safePlaywrightSmokeTitle({
      file,
      line: test.location.line,
      sourceFile: test.location.file,
      title: test.title,
    })
    this.progress(
      `start elapsed=${Math.round((Date.now() - this.startedAt) / 1000)}s retry=${result.retry} project=${safeProject(test)} ${file}:${test.location.line} case=${safePlaywrightSmokeId(test.id)} ${title}`
    )
  }

  onStepBegin(_test: TestCase, result: TestResult, step: TestStep): void {
    const state = this.steps.get(result) ?? {}
    const value = safeStep(step)
    if (value.category === "teardown") state.teardown = true
    state.active = { step, value }
    this.steps.set(result, state)
  }

  onStepEnd(_test: TestCase, result: TestResult, step: TestStep): void {
    const state = this.steps.get(result) ?? {}
    if (step.error) {
      state.failures ??= []
      state.failures.push({ step, completed: state.completed })
    } else if (!state.teardown) state.completed = safeStep(step)
    if (state.active?.step === step) delete state.active
    this.steps.set(result, state)
  }

  onStdErr(chunk: string | Buffer): void {
    // DEBUG=pw:browser reaches this boundary through the runner. Do not forward
    // or retain the chunk: it can include process arguments and private data.
    const text = chunk.toString()
    if (!text.includes("pw:browser")) return
    const signals = {
      launched: /<launched>/.test(text),
      networkProcessCrashed: /Network process crashed/i.test(text),
      segmentationFault: /SIGSEGV|segmentation fault/i.test(text),
      aborted: /SIGABRT/.test(text),
      heapCorruption:
        /double free|corrupted double-linked list|malloc\(\):.*corrupt/i.test(
          text
        ),
    }
    for (const key of Object.keys(signals) as (keyof typeof signals)[]) {
      if (!signals[key]) continue
      this.browserSignals[key] = Math.min(32768, this.browserSignals[key] + 1)
      this.progress(
        `browser-signal elapsed=${Math.round((Date.now() - this.startedAt) / 1000)}s category=${key}`
      )
    }
  }

  onError(error: TestError): void {
    const observation = {
      phase:
        this.firstTestAt !== undefined
          ? ("runner" as const)
          : ("startup" as const),
      category: /config\.webServer|webServer|web server/i.test(
        error.message ?? ""
      )
        ? ("web-server" as const)
        : ("unknown" as const),
    }
    this.runnerErrors.push(observation)
    this.progress(
      `runner-error phase=${observation.phase} category=${observation.category}`
    )
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.completedAttempts += 1
    const file = safeFile(test.location.file)
    const diagnostic = safeHermeticNetworkDiagnostic(result.annotations)
    const router =
      file === "e2e/commerce-router-recovery.playwright.ts"
        ? routerSmokeDiagnosticFromAnnotations(result.annotations)
        : undefined
    this.progress(
      `end completed=${this.completedAttempts} elapsed=${Math.round((Date.now() - this.startedAt) / 1000)}s duration=${Math.max(0, Math.round(result.duration))}ms retry=${Math.max(0, result.retry)} status=${result.status} project=${safeProject(test)} ${file}:${test.location.line} case=${safePlaywrightSmokeId(test.id)}${diagnostic ? ` diagnostic_operation=${diagnostic.operation} diagnostic_source=${diagnostic.source} diagnostic_category=${diagnostic.category}` : ""}${router ? ` ${formatRouterSmokeDiagnostic(router)}` : ""}`
    )
    const existing = this.specs.get(test.id)
    const location = safeLocation(result.error?.location)
    const diagnostics = safeSmokeDiagnostics(file, result.annotations)
    if (result.status !== "passed") {
      for (const diagnostic of diagnostics)
        this.progress(
          `diagnostic retry=${result.retry} project=${safeProject(test)} ${file}:${test.location.line} ${JSON.stringify(diagnostic)}`
        )
    }
    const safeResult: SafeResult = {
      duration: Math.max(0, Math.round(result.duration)),
      retry: Math.max(0, result.retry),
      status: result.status,
      ...(diagnostic ? { diagnostic } : {}),
      ...(router ? { router } : {}),
      ...(location ? { error: { location } } : {}),
      ...(diagnostics.length ? { diagnostics } : {}),
    }
    if (result.status !== "passed" && result.status !== "skipped") {
      const state = this.steps.get(result)
      // Polls and caught operations can emit failed steps without failing the
      // test. Attribute only an error that reached the result, preserving the
      // boundary captured before that error rather than subsequent cleanup.
      // Error contents are compared in memory only and never serialized.
      const error = result.errors?.[0]
      const matching =
        state?.failures?.filter(
          ({ step }) =>
            error &&
            (step.error === error ||
              (step.error?.message !== undefined &&
                step.error.message === error.message &&
                step.error.stack === error.stack))
        ) ?? []
      // IPC copies errors, so equal contents can represent distinct occurrences.
      // Prefer the latest leaf; parent propagation must not replace its boundary.
      const propagatedParents = new Set(matching.map(({ step }) => step.parent))
      const failed = matching
        .reverse()
        .find(({ step }) => !propagatedParents.has(step))
      const failedStep = failed ? safeStep(failed.step) : state?.active?.value
      const completed = failed ? failed.completed : state?.completed
      const context = smokeFailureContextFromAnnotations(
        file,
        result.annotations
      )
      safeResult.failure = {
        category:
          result.status === "timedOut"
            ? "timeout"
            : result.status === "interrupted"
              ? "interrupted"
              : failedStep?.category === "assertion"
                ? "assertion"
                : "unknown",
        ...(context ? { context } : {}),
        ...(failedStep ? { failedStep } : {}),
        ...(completed ? { lastCompletedStep: completed } : {}),
      }
      this.progress(
        `failure case=${safePlaywrightSmokeId(test.id)} ${JSON.stringify(safeResult.failure)}`
      )
      const area = safeTags(test.tags)[0]?.slice(1)
      const project = safeProject(test)
      if (area && file !== "unknown" && project !== "unknown") {
        this.progress(
          `reproduce-source-group case=${safePlaywrightSmokeId(test.id)} CI=true PLAYWRIGHT_SMOKE_RESULT_FILE="$(mktemp)" PLAYWRIGHT_SMOKE_PROGRESS_FILE=/dev/stdout PLAYWRIGHT_SMOKE_AREA=${area} bun run test:e2e ${file}:${test.location.line} --project=${project} --workers=1 --retries=0`
        )
      }
    }
    if (existing) {
      existing.ok = test.ok()
      existing.tests[0]!.status = test.outcome()
      existing.tests[0]!.results.push(safeResult)
      return
    }

    this.specs.set(test.id, {
      file,
      line: test.location.line,
      ok: test.ok(),
      project: safeProject(test),
      smokeId: safePlaywrightSmokeId(test.id),
      tags: safeTags(test.tags),
      tests: [
        {
          expectedStatus: test.expectedStatus,
          results: [safeResult],
          status: test.outcome(),
        },
      ],
      title: safePlaywrightSmokeTitle({
        file,
        line: test.location.line,
        sourceFile: test.location.file,
        title: test.title,
      }),
    })
  }

  onEnd(result: FullResult): void {
    this.progress(
      `finished completed=${this.completedAttempts} elapsed=${Math.round((Date.now() - this.startedAt) / 1000)}s`
    )
    if (Object.values(this.browserSignals).some(Boolean))
      this.progress(`browser-signals ${JSON.stringify(this.browserSignals)}`)
    const specs = [...this.specs.values()]
    const outcomes = specs.map((spec) => spec.tests[0]!.status)
    const report = {
      config: { metadata: this.metadata },
      errors: this.runnerErrors,
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
    if (this.evidenceFile) {
      const endedAt = Date.now()
      // Construct an allowlisted, title-free artifact. Never copy raw reports,
      // annotations, error messages, or attachments into an upload directory.
      const evidence = {
        schemaVersion: 2,
        evidence: safeSmokeEvidence(this.metadata),
        status: ["passed", "failed", "timedout", "interrupted"].includes(
          result.status
        )
          ? result.status
          : "unknown",
        timing: {
          reporterSetupBucket: smokeDurationBucket(
            (this.firstTestAt ?? endedAt) - this.createdAt
          ),
          executionBucket: smokeDurationBucket(
            this.firstTestAt !== undefined ? endedAt - this.firstTestAt : 0
          ),
          completedAttempts: this.completedAttempts,
        },
        errors: this.runnerErrors,
        browserSignals: this.browserSignals,
        tests: specs.map((spec) => ({
          smokeId: spec.smokeId,
          file: spec.file,
          line: spec.line,
          project: spec.project,
          tags: spec.tags,
          ok: spec.ok,
          tests: spec.tests.map((test) => ({
            expectedStatus: test.expectedStatus,
            status: test.status,
            results: test.results.map((attempt) => ({
              durationBucket: smokeDurationBucket(attempt.duration),
              retry: attempt.retry,
              status: attempt.status,
              ...(attempt.error ? { error: attempt.error } : {}),
              ...(attempt.failure ? { failure: attempt.failure } : {}),
              ...(spec.file === "e2e/commerce-router-recovery.playwright.ts" &&
              attempt.router &&
              parseRouterSmokeDiagnostic(attempt.router)
                ? { router: parseRouterSmokeDiagnostic(attempt.router) }
                : {}),
              ...(attempt.diagnostics
                ? {
                    diagnostics: attempt.diagnostics.map(retainedDiagnostic),
                  }
                : {}),
            })),
          })),
        })),
      }
      writeFileSync(this.evidenceFile, serializeSmokeEvidence(evidence), {
        mode: 0o600,
      })
      chmodSync(this.evidenceFile, 0o600)
    }
  }
}

export default PrivacySafeSmokeReporter
