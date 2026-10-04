import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  planDebug,
  readPublicEvents,
  runDebug,
} from "../scripts/dev/nostr-debug"
import { toolEnvironment, verifyArchive } from "../scripts/dev/deed-tool"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "conduit-deed-test-"))
  directories.push(root)
  const binary = join(root, "deed")
  writeFileSync(
    binary,
    "#!/bin/sh\nprintf '%s\\n' '{\"kind\":30402,\"content\":\"public fixture\"}'\nprintf 'relay supplied personal text' >&2\nexit 1\n"
  )
  chmodSync(binary, 0o700)
  return { root, binary }
}
const query = [
  "req",
  "--relay",
  "wss://relay.conduit.market",
  "--kind",
  "30402",
]

describe("public Deed harness", () => {
  test("agent queries retain public-kind, target, and duration bounds", () => {
    expect(planDebug(["agent", ...query])).toEqual(planDebug(query))
    expect(planDebug(["agent", "doctor"]).args).toEqual(["version"])
    for (const options of [
      ["--limit", "101"],
      ["--timeout", "30001"],
      ["--limit", "1", "--limit", "2"],
    ])
      expect(() => planDebug(["agent", ...query, ...options])).toThrow()
    for (const kind of ["4", "1059"])
      expect(() => planDebug(["agent", ...query.slice(0, -1), kind])).toThrow()
  })
  test("agent identity and file modes are rejected before executing Deed", () => {
    const { root, binary } = fixture()
    writeFileSync(binary, '#!/bin/sh\nprintf executed > "$0.args"\n')
    for (const args of [
      [...query, "--author", "public-identity-marker"],
      [...query, "--id", "public-event-marker"],
      [...query, "--save", "events.jsonl"],
      ["decode", "encoded-identity-marker"],
      ["verify", "events.jsonl"],
      ["doctor", "public-identity-marker"],
      ["agent", ...query],
    ])
      expect(() => runDebug(["agent", ...args], binary, root)).toThrow()
    expect(existsSync(`${binary}.args`)).toBe(false)
  })
  test("agent relay origins cannot carry identity paths or normalized path aliases", () => {
    for (const relay of [
      "wss://relay.conduit.market/public-identity-marker",
      "wss://relay.conduit.market/private/..",
      "wss://relay.conduit.market/%2e",
      "wss://public-identity-marker@relay.conduit.market",
      "wss://relay.conduit.market?identity=public-marker",
      "wss://relay.conduit.market#public-marker",
      "wss://localhost",
      "wss://127.0.0.1",
    ])
      expect(() =>
        planDebug(["agent", "req", "--relay", relay, "--kind", "30402"])
      ).toThrow()
  })
  test("skill examples invoke the aggregate entry point without identity inputs, raw output, or captures", () => {
    const skill = readFileSync(".agents/skills/deed-debug/SKILL.md", "utf8")
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts
    const examples = [...skill.matchAll(/^bun run (nostr:debug\S*) (.+)$/gm)]
    expect(examples.length).toBeGreaterThan(0)
    const { root, binary } = fixture()
    writeFileSync(
      binary,
      [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" > "$0.args"',
        'if [ "$1" = version ]; then',
        "  printf 'deed 0.3.2\\n'",
        "else",
        '  printf \'%s\\n\' \'{"kind":30402,"pubkey":"public identity marker","content":"personal content marker"}\'',
        "  printf 'relay personal diagnostic marker' >&2",
        "  exit 1",
        "fi",
      ].join("\n")
    )
    const output = mock((message: string) => {
      void message
    })
    const original = console.log
    console.log = output
    try {
      for (const [, script, command] of examples) {
        expect(script).toBe("nostr:debug:agent")
        const invocation = [
          ...scripts[script].split(" ").slice(2),
          ...command.split(" "),
        ]
        expect(invocation[0]).toBe("agent")
        expect(invocation.join(" ")).not.toMatch(
          /--author|--id|--save|decode|verify|[a-f0-9]{64}|(?:npub|nprofile|nevent|naddr|note)1/
        )
        expect([0, 1]).toContain(runDebug(invocation, binary, root))
      }
      const childArguments = readFileSync(`${binary}.args`, "utf8")
      expect(childArguments).not.toMatch(/public identity|personal|^-a$|^-i$/m)
      expect(childArguments).toContain("30402")
      expect(existsSync(join(root, "context", "nostr-debug"))).toBe(false)
      const transcript = JSON.stringify(output.mock.calls)
      expect(transcript).not.toMatch(
        /public identity|personal content|personal diagnostic/
      )
      expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual({
        command: "req",
        exitCode: 1,
        eventCount: 1,
        diagnosticsPresent: true,
        coverage: "not_established",
        saved: false,
      })
    } finally {
      console.log = original
    }
  })
  test("constructs an explicit bounded public query", () => {
    expect(planDebug(query)).toEqual({
      command: "req",
      args: [
        "req",
        "-k",
        "30402",
        "-l",
        "20",
        "--timeout",
        "10000",
        "wss://relay.conduit.market/",
      ],
      timeout: 16000,
      save: undefined,
    })
  })
  test("refuses state-changing commands, secret references, private kinds, and unbounded flags", () => {
    for (const argv of [
      ["publish"],
      ["event"],
      ["key"],
      ["decrypt"],
      ["fetch", "nevent1abc"],
      ["decode", ["nsec", "1ac"].join("")],
      [...query, "--stream"],
      [...query, "--sec", "secret"],
      ["req", "--relay", "wss://relay.conduit.market", "--kind", "1059"],
      ["req", "--relay", "wss://relay.conduit.market", "--kind", "4"],
    ]) {
      expect(() => planDebug(argv)).toThrow()
    }
  })
  test("rejects ambiguous targets, duplicate flags, excessive limits and capture traversal", () => {
    for (const relay of [
      "ws://relay.conduit.market",
      "wss://127.0.0.1",
      "wss://[::1]",
      "wss://localhost",
      "wss://host.internal",
      "wss://fixture@relay.example",
      "wss://relay.example?token=x",
    ])
      expect(() =>
        planDebug(["req", "--relay", relay, "--kind", "30402"])
      ).toThrow()
    for (const options of [
      ["--limit", "101"],
      ["--timeout", "30001"],
      ["--limit", "1", "--limit", "2"],
      ["--save", "../events.jsonl"],
    ])
      expect(() => planDebug([...query, ...options])).toThrow()
  })
  test("checks pinned archive integrity before installation", () => {
    const bytes = Buffer.from("verified fixture archive")
    const digest = createHash("sha256").update(bytes).digest("hex")
    expect(() => verifyArchive(bytes, digest)).not.toThrow()
    expect(() =>
      verifyArchive(Buffer.from("tampered archive"), digest)
    ).toThrow("checksum mismatch")
  })
  test("does not pass signing or wallet credentials into the subprocess", () => {
    expect(Object.keys(toolEnvironment()).sort()).toEqual(["PATH", "TMPDIR"])
  })
  test("refuses empty/private verification input before spawning", () => {
    const { root } = fixture()
    const input = join(root, "events.jsonl")
    writeFileSync(input, "")
    expect(() => readPublicEvents(input)).toThrow("No public events")
    writeFileSync(input, '{"kind":1059,"content":"private fixture"}\n')
    expect(() => readPublicEvents(input)).toThrow("Only documented public")
  })
  test("retains partial failure without exposing upstream text, and saves only on explicit request", () => {
    const { root, binary } = fixture()
    const output = mock((message: string) => {
      void message
    })
    const original = console.log
    console.log = output
    try {
      expect(
        runDebug([...query, "--save", "partial.jsonl"], binary, root)
      ).toBe(1)
      const summary = JSON.parse(output.mock.calls[0][0])
      expect(summary).toEqual({
        command: "req",
        exitCode: 1,
        eventCount: 1,
        diagnosticsPresent: true,
        coverage: "not_established",
        saved: true,
      })
      expect(JSON.stringify(output.mock.calls)).not.toContain("personal text")
      expect(JSON.stringify(output.mock.calls)).not.toContain("public fixture")
      expect(
        readFileSync(join(root, "context/nostr-debug/partial.jsonl"), "utf8")
      ).toContain("public fixture")
      expect(() =>
        runDebug([...query, "--save", "partial.jsonl"], binary, root)
      ).toThrow()
    } finally {
      console.log = original
    }
  })
  test("decode reports status without exposing public identifiers", () => {
    const { root, binary } = fixture()
    writeFileSync(
      binary,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"pubkey":"public identifier fixture","relays":[]}\'\n'
    )
    const output = mock((message: string) => {
      void message
    })
    const original = console.log
    console.log = output
    try {
      expect(
        runDebug(
          ["decode", "npub1ac", "--save", "reference.json"],
          binary,
          root
        )
      ).toBe(0)
      expect(JSON.parse(output.mock.calls[0][0])).toEqual({
        command: "decode",
        exitCode: 0,
        referenceType: "npub",
        diagnosticsPresent: false,
        saved: true,
      })
      expect(JSON.stringify(output.mock.calls)).not.toContain(
        "public identifier"
      )
      expect(
        readFileSync(join(root, "context/nostr-debug/reference.json"), "utf8")
      ).toContain("public identifier")
    } finally {
      console.log = original
    }
  })
  test("an outer deadline terminates a hung executable", () => {
    const { root, binary } = fixture()
    writeFileSync(binary, "#!/bin/sh\nexec sleep 60\n")
    const original = console.error
    console.error = () => {}
    const started = Date.now()
    try {
      expect(runDebug(["doctor"], binary, root)).toBe(1)
      expect(Date.now() - started).toBeLessThan(8000)
    } finally {
      console.error = original
    }
  }, 10000)
  test("doctor rejects a mismatched executable version", () => {
    const { root, binary } = fixture()
    const original = console.error
    console.error = () => {}
    try {
      expect(runDebug(["doctor"], binary, root)).toBe(1)
    } finally {
      console.error = original
    }
  })
})
