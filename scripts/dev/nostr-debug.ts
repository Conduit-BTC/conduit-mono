import { spawnSync } from "node:child_process"
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  deedBinary,
  DEED_VERSION,
  repoRoot,
  toolEnvironment,
} from "./deed-tool"

export const publicKinds = new Set([0, 5, 10002, 10050, 30402])
const usage = `Read-only Nostr debugging with pinned Deed ${DEED_VERSION}
  bun run nostr:debug:agent doctor
  bun run nostr:debug:agent req --relay <public-wss-origin> --kind <n> [--limit <1..100>] [--timeout <100..30000>]

Developer-only local commands (never use identity-bearing inputs in agent tools):
  bun run nostr:debug doctor
  bun run nostr:debug decode <npub|note|nprofile|nevent|naddr> [--save <name.json>]
  bun run nostr:debug verify <public-events.jsonl>
  bun run nostr:debug req --relay <wss-url> --kind <n> [--author <hex>] [--id <hex>] [--limit <1..100>] [--timeout <100..30000>] [--save <name.jsonl>]

Public kinds: 0, 5, 10002, 10050, 30402. One explicit relay per query.
Queries print counts only. --save writes raw public events to ignored context/nostr-debug/.
No signing, publishing, key access, encrypted events, authentication, or unbounded streams.
Run bun run nostr:debug:setup if Deed is missing.`

const agentUsage = `Aggregate-only Nostr debugging with pinned Deed ${DEED_VERSION}
  bun run nostr:debug:agent doctor
  bun run nostr:debug:agent req --relay <public-wss-origin> --kind <n> [--limit <1..100>] [--timeout <100..30000>]

Public kinds: 0, 5, 10002, 10050, 30402. Use a public relay origin without personal data.
No targeted filters, reference decoding, file input, captures, or raw output.
Never put identities into agent prompts or tool arguments; rejection happens after invocation is recorded.
Run bun run nostr:debug:setup if Deed is missing.`

export interface DebugPlan {
  command: "doctor" | "decode" | "verify" | "req"
  args: string[]
  timeout: number
  input?: string
  save?: string
}

function integer(
  value: string | undefined,
  minimum: number,
  maximum: number
): number {
  if (!value || !/^\d+$/.test(value))
    throw new Error("Expected a bounded integer.")
  const number = Number(value)
  if (number < minimum || number > maximum)
    throw new Error("Integer exceeds the debug bounds.")
  return number
}

export function planDebug(argv: string[]): DebugPlan {
  if (argv[0] === "agent") return planAgentDebug(argv.slice(1))
  const [command, ...rest] = argv
  if (command === "doctor" && rest.length === 0) {
    return { command, args: ["version"], timeout: 5_000 }
  }
  if (
    command === "decode" &&
    (rest.length === 1 || (rest.length === 3 && rest[1] === "--save")) &&
    /^(npub|note|nprofile|nevent|naddr)1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(
      rest[0]
    )
  ) {
    const save = rest[2]
    if (save && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(save))
      throw new Error("Use a simple .json capture name.")
    return { command, args: ["decode", rest[0]], timeout: 5_000, save }
  }
  if (command === "verify" && rest.length === 1 && !rest[0].startsWith("-")) {
    return { command, args: ["verify"], timeout: 10_000, input: rest[0] }
  }
  if (command !== "req")
    throw new Error(
      "Unsupported command. Use --help for read-only debug commands."
    )
  const flags = new Map<string, string>()
  const supported = new Set([
    "--relay",
    "--kind",
    "--author",
    "--id",
    "--limit",
    "--timeout",
    "--save",
  ])
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!supported.has(flag) || !value || flags.has(flag))
      throw new Error("Unknown, duplicate, or incomplete debug option.")
    flags.set(flag, value)
  }
  const kind = integer(flags.get("--kind"), 0, 65535)
  if (!publicKinds.has(kind))
    throw new Error(
      "This harness only queries the documented public event kinds."
    )
  // Explicit secure public targets; use the existing smoke harness for local/private relays.
  let relay: URL
  try {
    relay = new URL(flags.get("--relay") ?? "")
  } catch {
    throw new Error("An explicit public wss relay is required.")
  }
  if (
    relay.protocol !== "wss:" ||
    relay.username ||
    relay.password ||
    relay.search ||
    relay.hash ||
    !relay.hostname.includes(".") ||
    /^\[|^[\d.]+$/.test(relay.hostname) ||
    /\.(localhost|local|internal|test|invalid)$/.test(relay.hostname)
  ) {
    throw new Error(
      "Use a public wss hostname without credentials, query, or fragment."
    )
  }
  const timeout = integer(flags.get("--timeout") ?? "10000", 100, 30000)
  const args = [
    "req",
    "-k",
    String(kind),
    "-l",
    String(integer(flags.get("--limit") ?? "20", 1, 100)),
    "--timeout",
    String(timeout),
  ]
  for (const [flag, deedFlag] of [
    ["--author", "-a"],
    ["--id", "-i"],
  ]) {
    const value = flags.get(flag)
    if (value) {
      if (!/^[a-f0-9]{64}$/.test(value))
        throw new Error(
          "Author and event identifiers must be lowercase public hex."
        )
      args.push(deedFlag, value)
    }
  }
  args.push(relay.href)
  const save = flags.get("--save")
  if (save && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.jsonl$/.test(save)) {
    throw new Error("Save a simple .jsonl filename in context/nostr-debug/.")
  }
  return { command, args, timeout: timeout + 6_000, save }
}

function planAgentDebug(argv: string[]): DebugPlan {
  const [command, ...rest] = argv
  if (command === "doctor" && rest.length === 0) return planDebug(argv)
  if (command !== "req")
    throw new Error(
      "Agent debugging supports only doctor and aggregate queries."
    )
  const supported = new Set(["--relay", "--kind", "--limit", "--timeout"])
  for (let index = 0; index < rest.length; index += 2) {
    if (!supported.has(rest[index]))
      throw new Error(
        "Agent queries accept only relay, kind, limit, and timeout."
      )
    // Check the literal input too: URL normalization must not hide a path.
    if (
      rest[index] === "--relay" &&
      !/^wss:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?\/?$/.test(rest[index + 1] ?? "")
    )
      throw new Error(
        "Agent queries require a public relay origin without a path."
      )
  }
  return planDebug(argv)
}

export function readPublicEvents(path: string): string {
  const metadata = statSync(path)
  if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024)
    throw new Error("Expected a public event file up to 8 MiB.")
  const input = readFileSync(path, "utf8")
  if (Buffer.byteLength(input) > 8 * 1024 * 1024)
    throw new Error("Public event input exceeds 8 MiB.")
  const lines = input.split("\n").filter((line) => line.trim())
  if (lines.length === 0) throw new Error("No public events to verify.")
  for (const line of lines) {
    const event = JSON.parse(line)
    if (!publicKinds.has(event?.kind))
      throw new Error(
        "Only documented public event kinds can be verified by this harness."
      )
  }
  return input
}

export function runDebug(
  argv: string[],
  binary = deedBinary,
  root = repoRoot
): number {
  const agent = argv[0] === "agent"
  const commandArgs = agent ? argv.slice(1) : argv
  if (
    commandArgs.length === 0 ||
    (commandArgs.length === 1 && ["--help", "help"].includes(commandArgs[0]))
  ) {
    console.log(agent ? agentUsage : usage)
    return 0
  }
  const plan = planDebug(argv)
  const result = spawnSync(binary, plan.args, {
    input: plan.input ? readPublicEvents(resolve(root, plan.input)) : undefined,
    env: toolEnvironment(),
    encoding: "utf8",
    timeout: plan.timeout,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error || result.signal) {
    console.error(
      `Deed unavailable, timed out, or exceeded the output bound. Run nostr:debug:setup and ${agent ? "nostr:debug:agent" : "nostr:debug"} doctor.`
    )
    return 1
  }
  const exitCode = result.status ?? 1
  if (plan.save) {
    const directory = join(root, "context", "nostr-debug")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const location = relative(realpathSync(root), realpathSync(directory))
    if (location.startsWith("..") || isAbsolute(location))
      throw new Error("Debug capture directory must stay inside this checkout.")
    writeFileSync(join(directory, plan.save), result.stdout, {
      flag: "wx",
      mode: 0o600,
    })
  }
  if (plan.command === "doctor") {
    if (exitCode !== 0 || result.stdout.trim() !== `deed ${DEED_VERSION}`) {
      console.error("Pinned Deed version unavailable; run nostr:debug:setup.")
      return 1
    }
    console.log(`Deed ${DEED_VERSION} ready (repo-local, read-only harness).`)
  } else {
    const lines = result.stdout.split("\n").filter((line) => line.trim())
    // Deed diagnostics can contain event IDs or relay-supplied text; never forward them.
    console.log(
      JSON.stringify({
        command: plan.command,
        exitCode,
        eventCount: plan.command === "req" ? lines.length : undefined,
        referenceType:
          plan.command === "decode" ? plan.args[1].split("1")[0] : undefined,
        diagnosticsPresent: Boolean(result.stderr.trim()),
        coverage: plan.command === "req" ? "not_established" : undefined,
        saved: Boolean(plan.save),
      })
    )
  }
  return exitCode
}

if (import.meta.main) {
  try {
    process.exitCode = runDebug(process.argv.slice(2))
  } catch {
    console.error(
      `Invalid debug request or local input. Use ${process.argv[2] === "agent" ? "nostr:debug:agent" : "nostr:debug"} --help; no raw input or upstream diagnostics are printed.`
    )
    process.exitCode = 2
  }
}
