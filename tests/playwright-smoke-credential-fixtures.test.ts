import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"

type CredentialFixtureFinding = {
  commit?: string
  file: string
  line: number
  rule: string
}

type StaticCredentialRule = {
  rule: string
  pattern: RegExp
}

const staticCredentialRules = [
  {
    rule: "encoded secret key",
    pattern: /\bnsec1[0-9a-z]+\b/gi,
  },
  {
    rule: "secret-key encoding",
    pattern: /\bnsecEncode\s*\(/g,
  },
  {
    rule: "fixed private scalar",
    pattern:
      /\b(?:const|let|var)\s+[A-Z0-9_]*(?:PRIVATE|SECRET)[A-Z0-9_]*\s*=\s*(?:new\s+Uint8Array\s*\(\s*32\s*\)\.fill\s*\(|["'`][0-9a-f]+["'`]\.repeat\s*\(|["'`][0-9a-f]{64}["'`])/gi,
  },
  {
    rule: "fixed credential variable",
    pattern:
      /\b(?:const|let|var)\s+[A-Z0-9_]*(?:PRIVATE_KEY|SECRET_KEY|CLIENT_SECRET|PAIRING_SECRET|PASSWORD|PASSPHRASE|MNEMONIC|RECOVERY_PHRASE)[A-Z0-9_]*\s*=\s*["'`][^"'`]+["'`]/gi,
  },
  {
    rule: "fixed account-key identifier",
    pattern:
      /["'`]?\b(?:[A-Za-z0-9_$]*(?:nsec(?:hex|value|bytes)?|(?:account|signing|signer|merchant|buyer)(?:private|secret)?key(?:hex|value|bytes)?|client(?:private|secret)?key(?:hex|value|bytes)?)|[A-Za-z0-9_$]*(?:nsec(?:_(?:hex|value|bytes))?|(?:account|signing|signer|merchant|buyer)(?:_(?:private|secret))?_key(?:_(?:hex|value|bytes))?|client_(?:(?:private|secret)_)?key(?:_(?:hex|value|bytes))?))\b["'`]?\s*(?:=|:)\s*(?:["'`][^"'`\r\n]+["'`]|(?:new\s+Uint8Array|Uint8Array\.from)\s*\()/gi,
  },
  {
    rule: "fixed credential property",
    pattern:
      /\b(?:credential|privateKey|secretKey|clientPrivateKey|clientSecret|pairingSecret|recoveryPhrase|mnemonic|passphrase|password|salt|iv|ciphertext)\s*:\s*["'`][^"'`]+["'`]/gi,
  },
  {
    rule: "constructed credential property",
    pattern:
      /\b(?:credential|privateKey|secretKey|clientPrivateKey|clientSecret|pairingSecret|recoveryPhrase|mnemonic|passphrase|password|salt|iv|ciphertext|secret)\s*:\s*(?:["'`][0-9a-f]["'`]\.repeat\(\s*64\s*\)|["'`][0-9a-f]{2}["'`]\.repeat\(\s*32\s*\))/gi,
  },
  {
    rule: "deterministic derived private scalar",
    pattern:
      /\b(?:const|let|var)\s+[A-Za-z0-9_$]*(?:scalar|privateKey|secretKey|signingKey|signerKey)[A-Za-z0-9_$]*\s*=\s*(?:new\s+Uint8Array\s*\(\s*)?createHash\s*\([^)]*\)\s*\.update\s*\(\s*["'`][^"'`\r\n]+["'`](?:\s*,\s*["'`][^"'`\r\n]+["'`])?\s*\)\s*\.digest\s*\(\s*\)\s*\)?/gi,
  },
  {
    rule: "fixed credential input",
    pattern:
      /\b(?:password|passphrase|recovery|mnemonic|privateKey|secret)[A-Za-z0-9_]*\.fill\s*\(\s*["'`][^"'`]+["'`]\s*\)/gi,
  },
  {
    rule: "fixed vault value",
    pattern:
      /\bvault\.store\s*\(\s*[^,]+,\s*(?:["'`][0-9a-f]{2}["'`]\.repeat\s*\(\s*32\s*\)|["'`][0-9a-f]{64}["'`])/gi,
  },
  {
    rule: "credential-bearing signer URI",
    pattern:
      /\b(?:bunker|nostrconnect|nostr\+walletconnect):\/\/[^\s"'`]*\bsecret=[^\s&"'`]+/gi,
  },
  {
    rule: "credential-bearing URL userinfo",
    pattern: /\b(?:https?|wss?):\/\/[^/\s"'`:@]+:[^/@\s"'`]+@/gi,
  },
] as const

const protectedAccountReferenceRules = [
  {
    rule: "account nsec reference",
    pattern:
      /(?:\b(?:(?:[A-Za-z0-9]+_)+(?:nsec|NSEC|Nsec)(?:_[A-Za-z0-9]+)*|(?:nsec|NSEC|Nsec)_(?:[A-Za-z0-9]+_?)+|[A-Za-z0-9_$]+Nsec[A-Za-z0-9_$]*|Nsec[A-Za-z0-9_$]+)\b|\b(?:const|let|var)\s+(?:nsec|NSEC|Nsec)\b|\b(?:process\.env|secrets)\.(?:nsec|NSEC|Nsec)\b|\b(?:nsec|NSEC|Nsec)\s*:)/g,
  },
  {
    rule: "account private-key reference",
    pattern:
      /\b(?:(?:[A-Za-z0-9]+_)*(?:account|merchant|buyer|signing|signer|nostr)(?:_(?:private|secret))?_key(?:_[A-Za-z0-9]+)*|[A-Za-z0-9_$]*(?:account|merchant|buyer|signing|signer|nostr)(?:Private|Secret)?Key[A-Za-z0-9_$]*)\b/gi,
  },
] as const

const fixed32ByteHexRule = {
  rule: "fixed 32-byte hex literal",
  pattern:
    /(?:new\s+Uint8Array\s*\(\s*32\s*\)\.fill\s*\(|\b[0-9a-f]{64}\b|["'`][0-9a-f]["'`]\.repeat\(\s*64\s*\))/gi,
} as const

const commitMessageCredentialRules = [
  ...staticCredentialRules.filter(({ rule }) =>
    [
      "encoded secret key",
      "credential-bearing signer URI",
      "credential-bearing URL userinfo",
    ].includes(rule)
  ),
  fixed32ByteHexRule,
] as const

const protectedSmokeFiles = new Set([
  ".github/workflows/guest-checkout-order-smoke.yml",
  "scripts/ci/validate_guest_checkout_order_evidence.ts",
  "scripts/smoke/guest_checkout_order.ts",
  "scripts/smoke/guest_checkout_order_evidence.ts",
  "scripts/smoke/guest_checkout_order_runner.ts",
  "tests/guest-checkout-order-smoke.test.ts",
])

function credentialRulesForFile(file: string): readonly StaticCredentialRule[] {
  const baseRules = staticCredentialRules
  return protectedSmokeFiles.has(file)
    ? [...baseRules, ...protectedAccountReferenceRules, fixed32ByteHexRule]
    : baseRules
}

function snapshotCredentialRules(
  rules: readonly StaticCredentialRule[]
): Array<[rule: string, source: string, flags: string]> {
  return rules.map(({ rule, pattern }) => [rule, pattern.source, pattern.flags])
}

function sourceLine(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length
}

function findStaticCredentialFixtures(
  file: string,
  source: string,
  commit?: string,
  firstLine = 1,
  rules: readonly StaticCredentialRule[] = staticCredentialRules
): CredentialFixtureFinding[] {
  return rules.flatMap(({ pattern, rule }) =>
    Array.from(source.matchAll(pattern), (match) => ({
      ...(commit ? { commit } : {}),
      file,
      line: firstLine + sourceLine(source, match.index) - 1,
      rule,
    }))
  )
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error("Static credential history inspection failed.")
  }
  return result.stdout.trim()
}

function readHistoryRange(): { base: string; head: string } | null {
  const configuredBase = process.env.SMOKE_CREDENTIAL_BASE_SHA?.trim()
  const configuredHead = process.env.SMOKE_CREDENTIAL_HEAD_SHA?.trim()
  if (configuredBase || configuredHead) {
    if (!configuredBase || !configuredHead) {
      throw new Error("Static credential history range is incomplete.")
    }
    return { base: configuredBase, head: configuredHead }
  }

  const head = runGit(["rev-parse", "HEAD"])
  for (const candidate of ["origin/main", "main"]) {
    const result = spawnSync("git", ["merge-base", candidate, head], {
      encoding: "utf8",
    })
    if (result.status === 0 && result.stdout.trim()) {
      return { base: result.stdout.trim(), head }
    }
  }
  return null
}

function scanAddedHunks(
  commit: string,
  diff: string,
  selectRules: (
    file: string
  ) => readonly StaticCredentialRule[] = credentialRulesForFile
): CredentialFixtureFinding[] {
  const findings: CredentialFixtureFinding[] = []
  let file = "unknown"
  let inHunk = false
  let nextLine = 0
  let addedStart = 0
  let addedLines: string[] = []

  const flushAddedBlock = () => {
    if (addedLines.length === 0) return
    findings.push(
      ...findStaticCredentialFixtures(
        file,
        addedLines.join("\n"),
        commit,
        addedStart,
        selectRules(file)
      )
    )
    addedLines = []
    addedStart = 0
  }

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      flushAddedBlock()
      file = line.slice("+++ b/".length)
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      flushAddedBlock()
      inHunk = true
      nextLine = Number(hunk[1])
      continue
    }
    if (!inHunk || line.startsWith("\\ No newline")) continue
    if (line.startsWith("+")) {
      if (addedLines.length === 0) addedStart = nextLine
      addedLines.push(line.slice(1))
      nextLine += 1
      continue
    }
    flushAddedBlock()
    if (line.startsWith(" ")) {
      nextLine += 1
      continue
    }
    if (!line.startsWith("-")) inHunk = false
  }
  flushAddedBlock()
  return findings
}

function findHistoryCredentialFixtures(
  base: string,
  head: string
): CredentialFixtureFinding[] {
  const commits = runGit([
    "rev-list",
    "--reverse",
    "--topo-order",
    `${base}..${head}`,
  ])
    .split("\n")
    .filter(Boolean)
  const findings: CredentialFixtureFinding[] = []

  for (const commit of commits) {
    const commitMessage = runGit(["show", "-s", "--format=%B", commit])
    findings.push(
      ...findStaticCredentialFixtures(
        "commit-message",
        commitMessage,
        commit,
        1,
        commitMessageCredentialRules
      )
    )
    const parents = runGit(["rev-list", "--parents", "-n", "1", commit])
      .split(" ")
      .slice(1)
    const diff =
      parents.length > 0
        ? runGit([
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            "--unified=0",
            parents[0],
            commit,
          ])
        : runGit([
            "show",
            "--root",
            "--format=",
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            "--unified=0",
            commit,
          ])
    findings.push(...scanAddedHunks(commit, diff))
  }

  return findings
}

describe("Playwright smoke credential fixtures", () => {
  it("keeps the scanner non-vacuous without constructing credentials", () => {
    const expectedStaticRuleSnapshots = [
      ["encoded secret key", /\bnsec1[0-9a-z]+\b/gi.source, "gi"],
      ["secret-key encoding", /\bnsecEncode\s*\(/g.source, "g"],
      [
        "fixed private scalar",
        /\b(?:const|let|var)\s+[A-Z0-9_]*(?:PRIVATE|SECRET)[A-Z0-9_]*\s*=\s*(?:new\s+Uint8Array\s*\(\s*32\s*\)\.fill\s*\(|["'`][0-9a-f]+["'`]\.repeat\s*\(|["'`][0-9a-f]{64}["'`])/gi
          .source,
        "gi",
      ],
      [
        "fixed credential variable",
        /\b(?:const|let|var)\s+[A-Z0-9_]*(?:PRIVATE_KEY|SECRET_KEY|CLIENT_SECRET|PAIRING_SECRET|PASSWORD|PASSPHRASE|MNEMONIC|RECOVERY_PHRASE)[A-Z0-9_]*\s*=\s*["'`][^"'`]+["'`]/gi
          .source,
        "gi",
      ],
      [
        "fixed account-key identifier",
        /["'`]?\b(?:[A-Za-z0-9_$]*(?:nsec(?:hex|value|bytes)?|(?:account|signing|signer|merchant|buyer)(?:private|secret)?key(?:hex|value|bytes)?|client(?:private|secret)?key(?:hex|value|bytes)?)|[A-Za-z0-9_$]*(?:nsec(?:_(?:hex|value|bytes))?|(?:account|signing|signer|merchant|buyer)(?:_(?:private|secret))?_key(?:_(?:hex|value|bytes))?|client_(?:(?:private|secret)_)?key(?:_(?:hex|value|bytes))?))\b["'`]?\s*(?:=|:)\s*(?:["'`][^"'`\r\n]+["'`]|(?:new\s+Uint8Array|Uint8Array\.from)\s*\()/gi
          .source,
        "gi",
      ],
      [
        "fixed credential property",
        /\b(?:credential|privateKey|secretKey|clientPrivateKey|clientSecret|pairingSecret|recoveryPhrase|mnemonic|passphrase|password|salt|iv|ciphertext)\s*:\s*["'`][^"'`]+["'`]/gi
          .source,
        "gi",
      ],
      [
        "constructed credential property",
        /\b(?:credential|privateKey|secretKey|clientPrivateKey|clientSecret|pairingSecret|recoveryPhrase|mnemonic|passphrase|password|salt|iv|ciphertext|secret)\s*:\s*(?:["'`][0-9a-f]["'`]\.repeat\(\s*64\s*\)|["'`][0-9a-f]{2}["'`]\.repeat\(\s*32\s*\))/gi
          .source,
        "gi",
      ],
      [
        "deterministic derived private scalar",
        /\b(?:const|let|var)\s+[A-Za-z0-9_$]*(?:scalar|privateKey|secretKey|signingKey|signerKey)[A-Za-z0-9_$]*\s*=\s*(?:new\s+Uint8Array\s*\(\s*)?createHash\s*\([^)]*\)\s*\.update\s*\(\s*["'`][^"'`\r\n]+["'`](?:\s*,\s*["'`][^"'`\r\n]+["'`])?\s*\)\s*\.digest\s*\(\s*\)\s*\)?/gi
          .source,
        "gi",
      ],
      [
        "fixed credential input",
        /\b(?:password|passphrase|recovery|mnemonic|privateKey|secret)[A-Za-z0-9_]*\.fill\s*\(\s*["'`][^"'`]+["'`]\s*\)/gi
          .source,
        "gi",
      ],
      [
        "fixed vault value",
        /\bvault\.store\s*\(\s*[^,]+,\s*(?:["'`][0-9a-f]{2}["'`]\.repeat\s*\(\s*32\s*\)|["'`][0-9a-f]{64}["'`])/gi
          .source,
        "gi",
      ],
      [
        "credential-bearing signer URI",
        /\b(?:bunker|nostrconnect|nostr\+walletconnect):\/\/[^\s"'`]*\bsecret=[^\s&"'`]+/gi
          .source,
        "gi",
      ],
      [
        "credential-bearing URL userinfo",
        /\b(?:https?|wss?):\/\/[^/\s"'`:@]+:[^/@\s"'`]+@/gi.source,
        "gi",
      ],
    ] satisfies Array<[rule: string, source: string, flags: string]>
    const expectedProtectedReferenceRuleSnapshots = [
      [
        "account nsec reference",
        /(?:\b(?:(?:[A-Za-z0-9]+_)+(?:nsec|NSEC|Nsec)(?:_[A-Za-z0-9]+)*|(?:nsec|NSEC|Nsec)_(?:[A-Za-z0-9]+_?)+|[A-Za-z0-9_$]+Nsec[A-Za-z0-9_$]*|Nsec[A-Za-z0-9_$]+)\b|\b(?:const|let|var)\s+(?:nsec|NSEC|Nsec)\b|\b(?:process\.env|secrets)\.(?:nsec|NSEC|Nsec)\b|\b(?:nsec|NSEC|Nsec)\s*:)/g
          .source,
        "g",
      ],
      [
        "account private-key reference",
        /\b(?:(?:[A-Za-z0-9]+_)*(?:account|merchant|buyer|signing|signer|nostr)(?:_(?:private|secret))?_key(?:_[A-Za-z0-9]+)*|[A-Za-z0-9_$]*(?:account|merchant|buyer|signing|signer|nostr)(?:Private|Secret)?Key[A-Za-z0-9_$]*)\b/gi
          .source,
        "gi",
      ],
    ] satisfies Array<[rule: string, source: string, flags: string]>
    const expectedFixed32ByteRuleSnapshot = [
      [
        "fixed 32-byte hex literal",
        /(?:new\s+Uint8Array\s*\(\s*32\s*\)\.fill\s*\(|\b[0-9a-f]{64}\b|["'`][0-9a-f]["'`]\.repeat\(\s*64\s*\))/gi
          .source,
        "gi",
      ],
    ] satisfies Array<[rule: string, source: string, flags: string]>
    const expectedProtectedFiles = [
      ".github/workflows/guest-checkout-order-smoke.yml",
      "scripts/ci/validate_guest_checkout_order_evidence.ts",
      "scripts/smoke/guest_checkout_order.ts",
      "scripts/smoke/guest_checkout_order_evidence.ts",
      "scripts/smoke/guest_checkout_order_runner.ts",
      "tests/guest-checkout-order-smoke.test.ts",
    ]
    const findings = findStaticCredentialFixtures(
      "fixture.playwright.ts",
      "allowed marker\nsynthetic prohibited marker",
      undefined,
      1,
      [{ rule: "synthetic rule", pattern: /synthetic prohibited marker/g }]
    )

    expect(findings).toEqual([
      {
        file: "fixture.playwright.ts",
        line: 2,
        rule: "synthetic rule",
      },
    ])
    expect(snapshotCredentialRules(staticCredentialRules)).toEqual(
      expectedStaticRuleSnapshots
    )
    expect(snapshotCredentialRules(protectedAccountReferenceRules)).toEqual(
      expectedProtectedReferenceRuleSnapshots
    )
    expect(snapshotCredentialRules([fixed32ByteHexRule])).toEqual(
      expectedFixed32ByteRuleSnapshot
    )
    expect([...protectedSmokeFiles].sort()).toEqual(
      [...expectedProtectedFiles].sort()
    )
    for (const file of expectedProtectedFiles) {
      expect(snapshotCredentialRules(credentialRulesForFile(file))).toEqual([
        ...expectedStaticRuleSnapshots,
        ...expectedProtectedReferenceRuleSnapshots,
        ...expectedFixed32ByteRuleSnapshot,
      ])
    }
    expect(
      snapshotCredentialRules(
        credentialRulesForFile("e2e/harmless.playwright.ts")
      )
    ).toEqual(expectedStaticRuleSnapshots)
    expect(
      findStaticCredentialFixtures(
        "e2e/public-identifiers.playwright.ts",
        [
          'const TEST_PUBKEY = "public-marker"',
          'const EVENT_ID = "event-marker"',
          'const clientKeyId = "identifier-marker"',
        ].join("\n")
      )
    ).toEqual([])
    expect(
      findStaticCredentialFixtures(
        "scripts/smoke/guest_checkout_order_runner.ts",
        "const insecureTransport = true",
        undefined,
        1,
        credentialRulesForFile("scripts/smoke/guest_checkout_order_runner.ts")
      )
    ).toEqual([])
    const constructedSecretProperty = [
      'const connection = { secret: "',
      "d",
      '".repeat(',
      "64",
      ") }",
    ].join("")
    expect(
      findStaticCredentialFixtures(
        "tests/constructed-credential.ts",
        constructedSecretProperty
      )
    ).toEqual([
      {
        file: "tests/constructed-credential.ts",
        line: 1,
        rule: "constructed credential property",
      },
    ])
    const deterministicDerivedScalar = [
      "const fixture",
      "Scalar = new Uint8Array(create",
      'Hash("sha256").update("authored label", "utf8").digest())',
    ].join("")
    expect(
      findStaticCredentialFixtures(
        "tests/deterministic-derived-scalar.ts",
        deterministicDerivedScalar
      )
    ).toEqual([
      {
        file: "tests/deterministic-derived-scalar.ts",
        line: 1,
        rule: "deterministic derived private scalar",
      },
    ])

    expect(
      findStaticCredentialFixtures(
        "tests/random-process-scalar.ts",
        "const fixtureScalar = secp256k1.utils.randomSecretKey()"
      )
    ).toEqual([])

    expect(
      scanAddedHunks(
        "synthetic-commit",
        [
          "diff --git a/example.ts b/example.ts",
          "+++ b/example.ts",
          "@@ -0,0 +1 @@",
          "+synthetic prohibited marker",
        ].join("\n"),
        () => [
          { rule: "synthetic rule", pattern: /synthetic prohibited marker/g },
        ]
      )
    ).toEqual([
      {
        commit: "synthetic-commit",
        file: "example.ts",
        line: 1,
        rule: "synthetic rule",
      },
    ])
    expect(
      scanAddedHunks(
        "synthetic-commit",
        [
          "diff --git a/example.ts b/example.ts",
          "+++ b/example.ts",
          "@@ -10,2 +10,4 @@",
          "+synthetic prohibited marker",
          " context line",
          "-removed line",
          "+safe added line",
          "+synthetic prohibited marker",
        ].join("\n"),
        () => [
          { rule: "synthetic rule", pattern: /synthetic prohibited marker/g },
        ]
      )
    ).toEqual([
      {
        commit: "synthetic-commit",
        file: "example.ts",
        line: 10,
        rule: "synthetic rule",
      },
      {
        commit: "synthetic-commit",
        file: "example.ts",
        line: 13,
        rule: "synthetic rule",
      },
    ])
    expect(
      scanAddedHunks(
        "synthetic-commit",
        [
          "diff --git a/example.ts b/example.ts",
          "+++ b/example.ts",
          "@@ -1,1 +1,3 @@",
          "+synthetic first",
          " context line",
          "+synthetic second",
        ].join("\n"),
        () => [
          {
            rule: "synthetic cross-gap rule",
            pattern: /synthetic first\nsynthetic second/g,
          },
        ]
      )
    ).toEqual([])
  })

  it("keeps static credential-shaped material out of E2E sources", async () => {
    const findings: CredentialFixtureFinding[] = []
    const glob = new Bun.Glob("e2e/**/*.ts")
    let scannedSourceCount = 0

    for await (const file of glob.scan({ cwd: ".", onlyFiles: true })) {
      const source = await Bun.file(file).text()
      scannedSourceCount += 1
      findings.push(...findStaticCredentialFixtures(file, source))
    }

    findings.sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.rule.localeCompare(right.rule)
    )

    expect(scannedSourceCount).toBeGreaterThan(0)
    expect(findings).toEqual([])
  })

  it("keeps protected smoke sources free of account private-key references", async () => {
    const findings: CredentialFixtureFinding[] = []
    let scannedSourceCount = 0

    for (const file of protectedSmokeFiles) {
      const sourceFile = Bun.file(file)
      if (!(await sourceFile.exists())) continue
      scannedSourceCount += 1
      findings.push(
        ...findStaticCredentialFixtures(
          file,
          await sourceFile.text(),
          undefined,
          1,
          credentialRulesForFile(file)
        )
      )
    }

    findings.sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.rule.localeCompare(right.rule)
    )

    if (scannedSourceCount > 0) expect(findings).toEqual([])
  })

  it("keeps static credential-shaped material out of authored history", () => {
    const range = readHistoryRange()
    if (!range) return

    const findings = findHistoryCredentialFixtures(range.base, range.head).sort(
      (left, right) =>
        (left.commit ?? "").localeCompare(right.commit ?? "") ||
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.rule.localeCompare(right.rule)
    )

    expect(findings).toEqual([])
  })
})
