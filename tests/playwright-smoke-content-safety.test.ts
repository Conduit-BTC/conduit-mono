import { describe, expect, it } from "bun:test"

type UnsafeEvidenceFinding = {
  file: string
  line: number
  rule: string
}

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
})
