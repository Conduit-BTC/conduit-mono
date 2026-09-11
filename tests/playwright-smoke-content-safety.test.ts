import { describe, expect, it } from "bun:test"

type UnsafeEvidenceFinding = {
  file: string
  line: number
  rule: string
}

const normalizeLines = (value: string) => value.replaceAll("\r\n", "\n")
const commerceSmoke = normalizeLines(
  await Bun.file("e2e/commerce.playwright.ts").text()
)

const unsafeEvidenceRules = [
  {
    rule: "signed event assertion",
    pattern:
      /expect\(\s*[A-Za-z0-9_?[\].]+signedEvent(?:\.(?:pubkey|tags|sig))?\s*\)\.(?:toBe|toEqual|toContainEqual|toMatch)/g,
  },
  {
    rule: "published event assertion",
    pattern:
      /expect\(\s*[A-Za-z0-9_?[\].]+Publishes[A-Za-z0-9_?[\].]*\.event\s*\)\.(?:toBe|toEqual|toMatchObject)/g,
  },
  {
    rule: "content-bearing collection assertion",
    pattern:
      /expect\(\s*(?:runtimeEvents|boundaryEvents|dexieMessages|retryResponseErrors|lnurlRequests)\s*\)\.(?:toEqual|toStrictEqual|toContain|toContainEqual|toMatchObject)/g,
  },
  {
    rule: "identity-bearing cache assertion",
    pattern:
      /expect\(\s*(?:migrated\.(?:product|tombstone)|result\.(?:inboxReadByV11|nativeState|contactListReadByV12|inboxReadByV12))\s*\)\.toEqual/g,
  },
  {
    rule: "relay delivery assertion",
    pattern:
      /expect\(\s*[A-Za-z0-9_?[\].]+relay(?:Plan|Delivery)[\s\S]{0,160}?\)\.(?:toEqual|toMatchObject)/g,
  },
  {
    rule: "request payload assertion",
    pattern: /expect\(\s*request\.(?:body|url)\s*\)\./g,
  },
  {
    rule: "stored signer identity assertion",
    pattern: /\.poll\(\s*\(\)\s*=>\s*storedAuthPubkey\(/g,
  },
  {
    rule: "credential value assertion",
    pattern: /expect\(\s*unlockPassword\s*\)\.toHaveValue/g,
  },
  {
    rule: "vault revision assertion",
    pattern:
      /expect\(\s*result\.revision\s*\)\.(?:toBe|toContain|toEqual|toMatch)/g,
  },
  {
    rule: "raw error message assertion",
    pattern:
      /expect\(\s*message\s*\)\.(?:not\.)?(?:toBe|toContain|toEqual|toMatch)/g,
  },
  {
    rule: "serialized telemetry assertion",
    pattern: /expect\(\s*JSON\.stringify\((?:runtime|boundary)Events\)\s*\)\./g,
  },
  {
    rule: "identity-bearing product collection assertion",
    pattern: /\.poll\([\s\S]{0,500}?productId[\s\S]{0,200}?\)\s*\.toEqual/g,
  },
] as const

const unsafeCommerceSourceRules = [
  {
    rule: "direct commerce-sensitive value assertion",
    pattern:
      /expect\(\s*(?:[A-Za-z0-9_$]+\.)?(?:ciphertext|connectionString|content|invoice|npub|nsec|orderId|payload|paymentHash|plaintext|preimage|productTitle|pubkey|secret)\s*\)\.(?:not\.)?(?:toBe|toContain|toEqual|toMatch|toMatchObject)/g,
  },
  {
    rule: "commerce-sensitive expected assertion value",
    pattern:
      /\.(?:toBe|toContain|toContainEqual|toEqual|toHaveText|toHaveValue|toMatch|toMatchObject)\(\s*(?:[A-Za-z0-9_$]+\.)?(?:ciphertext|connectionString|content|invoice|npub|nsec|orderId|payload|paymentHash|plaintext|preimage|productTitle|pubkey|secret)\b/g,
  },
  {
    rule: "Playwright attachment",
    pattern: /\.attach\(/g,
  },
  {
    rule: "browser screenshot",
    pattern: /\.(?:screenshot|toHaveScreenshot)\(/g,
  },
  {
    rule: "browser trace capture",
    pattern: /\btracing\.(?:start|startChunk|stop|stopChunk)\(/g,
  },
  {
    rule: "browser video capture",
    pattern: /\.video\(\)/g,
  },
  {
    rule: "console capture",
    pattern: /\b(?:context|page)\.on\(\s*["'`](?:console|pageerror)\b/g,
  },
  {
    rule: "console output",
    pattern: /\bconsole\.(?:debug|error|info|log|trace|warn)\(/g,
  },
  {
    rule: "network capture listener",
    pattern:
      /\b(?:context|page)\.on\(\s*["'`](?:request|requestfailed|requestfinished|response|websocket)\b/g,
  },
  {
    rule: "network body capture",
    pattern:
      /\b(?:request|response)\.(?:allHeaders|body|headers|headersArray|json|postData|postDataBuffer|text)\(/g,
  },
  {
    rule: "recorded browser artifact configuration",
    pattern: /\b(?:recordHar|recordVideo)\s*:/g,
  },
] as const

function sourceLine(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length
}

function findUnsafeEvidenceAssertions(
  file: string,
  source: string
): UnsafeEvidenceFinding[] {
  return unsafeEvidenceRules.flatMap(({ pattern, rule }) =>
    Array.from(source.matchAll(pattern), (match) => ({
      file,
      line: sourceLine(source, match.index),
      rule,
    }))
  )
}

describe("Playwright smoke content safety", () => {
  it("ignores generated smoke execution result files", async () => {
    const gitignore = await Bun.file(".gitignore").text()

    expect(gitignore).toContain("playwright-smoke-*-results.json")
  })

  it("detects every prohibited content-bearing assertion form", () => {
    const unsafeSources = [
      ["signed event assertion", "expect(job.signedEvent).toEqual(expected)"],
      [
        "published event assertion",
        "expect(retryPublishes[0].event).toEqual(expected)",
      ],
      [
        "content-bearing collection assertion",
        "expect(runtimeEvents).toEqual(expected)",
      ],
      [
        "identity-bearing cache assertion",
        "expect(result.inboxReadByV11).toEqual(expected)",
      ],
      ["relay delivery assertion", "expect(job.relayDelivery).toEqual([])"],
      ["request payload assertion", "expect(request.body).toBeNull()"],
      [
        "stored signer identity assertion",
        "expect.poll(() => storedAuthPubkey(page)).toBe(expected)",
      ],
      [
        "credential value assertion",
        'expect(unlockPassword).toHaveValue("secret")',
      ],
      ["vault revision assertion", "expect(result.revision).toMatch(uuid)"],
      ["raw error message assertion", 'expect(message).toContain("secret")'],
      [
        "serialized telemetry assertion",
        'expect(JSON.stringify(runtimeEvents)).not.toContain("secret")',
      ],
      [
        "identity-bearing product collection assertion",
        "expect.poll(() => items.map(({ productId }) => productId)).toEqual([])",
      ],
    ] as const

    for (const [expectedRule, source] of unsafeSources) {
      expect(
        findUnsafeEvidenceAssertions("fixture.playwright.ts", source).some(
          ({ rule }) => rule === expectedRule
        )
      ).toBe(true)
    }
  })

  it("detects prohibited commerce capture and assertion forms", () => {
    const unsafeSources = [
      ["Playwright attachment", 'await testInfo.attach("trace", value)'],
      ["browser screenshot", "await page.screenshot()"],
      ["browser trace capture", "await context.tracing.start()"],
      ["browser video capture", "await page.video()"],
      ["console capture", 'page.on("console", () => {})'],
      ["console output", 'console.log("browser state")'],
      ["network capture listener", 'page.on("request", () => {})'],
      ["network body capture", "await response.body()"],
      ["recorded browser artifact configuration", "recordHar: {}"],
      [
        "direct commerce-sensitive value assertion",
        "expect(orderId).toEqual(expected)",
      ],
      [
        "commerce-sensitive expected assertion value",
        "expect(locator).toHaveValue(connectionString)",
      ],
    ] as const

    for (const [expectedRule, source] of unsafeSources) {
      expect(
        unsafeCommerceSourceRules.some(
          ({ pattern, rule }) =>
            rule === expectedRule &&
            Array.from(source.matchAll(pattern)).length > 0
        )
      ).toBe(true)
    }
  })

  it("keeps content-bearing values out of assertion failure output", async () => {
    const findings: UnsafeEvidenceFinding[] = []
    const glob = new Bun.Glob("e2e/**/*.playwright.ts")
    let scannedSpecCount = 0

    for await (const file of glob.scan({ cwd: ".", onlyFiles: true })) {
      const source = await Bun.file(file).text()
      scannedSpecCount += 1
      findings.push(...findUnsafeEvidenceAssertions(file, source))
    }

    findings.sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.rule.localeCompare(right.rule)
    )

    expect(scannedSpecCount).toBeGreaterThan(0)
    expect(findings).toEqual([])
  })

  it("forces the commerce smoke to remain free of browser artifacts and captures", () => {
    expect(commerceSmoke).toContain(
      'test.use({ screenshot: "off", trace: "off", video: "off" })'
    )

    const findings = [
      ...findUnsafeEvidenceAssertions(
        "e2e/commerce.playwright.ts",
        commerceSmoke
      ),
      ...unsafeCommerceSourceRules.flatMap(({ pattern, rule }) =>
        Array.from(commerceSmoke.matchAll(pattern), (match) => ({
          file: "e2e/commerce.playwright.ts",
          line: sourceLine(commerceSmoke, match.index),
          rule,
        }))
      ),
    ].sort(
      (left, right) =>
        left.line - right.line || left.rule.localeCompare(right.rule)
    )

    expect(findings).toEqual([])
  })
})
