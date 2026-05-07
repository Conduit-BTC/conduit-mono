import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  EVENT_KINDS,
  buildConduitHandlerEventContent,
  buildConduitHandlerEventTags,
  getConduitNip89AppDefinition,
  type ConduitAppId,
} from "../packages/core/src/protocol"

type CliOptions = {
  appId: ConduitAppId
  nsec: string
  relayUrls?: string[]
  dryRun: boolean
}

const HELP_TEXT = [
  "Usage:",
  "  bun scripts/publish_nip89_handlers.ts --app market --nsec <nsec>",
  "  bun scripts/publish_nip89_handlers.ts --app merchant --nsec <nsec> --relay wss://conduitl2.fly.dev",
  "  bun run nip89:publish-handler -- --app market --nsec <nsec> --dry-run",
  "",
  "Local-only helper for publishing the Conduit NIP-89 kind 31990 handler event.",
  "Use --dry-run to print the exact event content and tags without publishing.",
  "If VITE_NIP89_*_PUBKEY is set locally, the script verifies it matches the provided nsec.",
  "",
  "Options:",
  "  --app <market|merchant>  Required app identity to publish.",
  "  --nsec <nsec>            Required signer secret for the selected app.",
  "  --relay <url>            Relay URL to publish to. Repeat for multiple relays.",
  "  --relays <csv>           Comma-separated relay URLs.",
  "  --dry-run                Print the event Conduit would publish and exit.",
  "  --help                   Show this message.",
  "",
  "Environment fallback:",
  "  NIP89_APP",
  "  NIP89_NSEC",
  "  NIP89_RELAY_URLS",
].join("\n")

function fail(message: string): never {
  console.error(message)
  console.error("\n" + HELP_TEXT)
  process.exit(1)
}

function parseRelayUrls(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  const relayUrls = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return relayUrls.length > 0 ? relayUrls : undefined
}

function isAppId(value: string): value is ConduitAppId {
  return value === "market" || value === "merchant"
}

function parseArgs(argv: string[]): CliOptions {
  let appId = process.env.NIP89_APP?.trim() ?? ""
  let nsec = process.env.NIP89_NSEC?.trim() ?? ""
  const relayArgs: string[] = []
  const envRelayUrls = parseRelayUrls(
    process.env.NIP89_RELAY_URLS?.trim() ?? null
  )
  let dryRun = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      console.log(HELP_TEXT)
      process.exit(0)
    }
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "--app") {
      appId = argv[index + 1] ?? ""
      index += 1
      continue
    }
    if (arg === "--nsec") {
      nsec = argv[index + 1] ?? ""
      index += 1
      continue
    }
    if (arg === "--relay") {
      const relayUrl = argv[index + 1] ?? ""
      if (!relayUrl) fail("Missing value for --relay")
      relayArgs.push(relayUrl)
      index += 1
      continue
    }
    if (arg === "--relays") {
      const parsedRelayUrls = parseRelayUrls(argv[index + 1] ?? null)
      if (!parsedRelayUrls) fail("Missing value for --relays")
      relayArgs.push(...parsedRelayUrls)
      index += 1
      continue
    }
    fail(`Unknown argument: ${arg}`)
  }

  if (!isAppId(appId)) {
    fail("Missing or invalid --app. Expected market or merchant.")
  }
  if (!nsec) {
    fail("Missing --nsec. Pass it directly or set NIP89_NSEC.")
  }

  const relayUrls = [...(envRelayUrls ?? []), ...relayArgs].filter(
    (url, index, all) => all.indexOf(url) === index
  )

  return {
    appId,
    nsec,
    relayUrls: relayUrls.length > 0 ? relayUrls : undefined,
    dryRun,
  }
}

function buildHandlerAddress(appId: ConduitAppId, pubkey: string): string {
  const app = getConduitNip89AppDefinition(appId)
  return `${EVENT_KINDS.APPLICATION_HANDLER}:${pubkey}:${app.dTag}`
}

async function printDryRun(
  appId: ConduitAppId,
  nsec: string,
  relayUrls?: string[]
): Promise<void> {
  const app = getConduitNip89AppDefinition(appId)
  const signer = new NDKPrivateKeySigner(nsec)
  const signerUser = await signer.user()
  const payload = {
    appId,
    relayUrls: relayUrls ?? [app.relayHint],
    event: {
      kind: EVENT_KINDS.APPLICATION_HANDLER,
      pubkey: signerUser.pubkey,
      content: JSON.parse(buildConduitHandlerEventContent(appId)),
      tags: buildConduitHandlerEventTags(appId),
    },
    address: buildHandlerAddress(appId, signerUser.pubkey),
  }

  console.log(JSON.stringify(payload, null, 2))
}

async function publishHandler(
  appId: ConduitAppId,
  nsec: string,
  relayUrls?: string[]
): Promise<{ eventId: string; address: string }> {
  const app = getConduitNip89AppDefinition(appId)
  const signer = new NDKPrivateKeySigner(nsec)
  const signerUser = await signer.user()

  if (app.pubkey && app.pubkey !== signerUser.pubkey) {
    throw new Error(
      `Configured pubkey for ${appId} does not match the provided NSEC`
    )
  }

  const ndk = new NDK({
    explicitRelayUrls:
      relayUrls && relayUrls.length > 0 ? relayUrls : [app.relayHint],
    signer,
  })

  await ndk.connect(5000)

  try {
    const event = new NDKEvent(ndk)
    event.kind = EVENT_KINDS.APPLICATION_HANDLER
    event.created_at = Math.floor(Date.now() / 1000)
    event.content = buildConduitHandlerEventContent(appId)
    event.tags = buildConduitHandlerEventTags(appId)

    await event.sign(signer)
    await event.publish()

    return {
      eventId: event.id,
      address: buildHandlerAddress(appId, signerUser.pubkey),
    }
  } finally {
    for (const [, relay] of ndk.pool?.relays?.entries() ?? []) {
      relay.disconnect()
    }
  }
}

async function main(): Promise<void> {
  const { appId, nsec, relayUrls, dryRun } = parseArgs(process.argv.slice(2))

  if (dryRun) {
    await printDryRun(appId, nsec, relayUrls)
    return
  }

  const result = await publishHandler(appId, nsec, relayUrls)
  console.log(
    `Published ${appId} handler: ${result.address} (${result.eventId})`
  )
}

await main()
