import { expect, test } from "bun:test"
import { inspectRelayPolicy } from "../scripts/ci/relay_policy"

const path = "packages/core/src/protocol/new-feature.ts"
test("rejects feature-owned endpoint defaults without banning URL-shaped protocol strings", () => {
  expect(
    inspectRelayPolicy([
      { path, content: 'const defaults = ["wss://relay.vendor.com"]' },
    ]).map((finding) => finding.rule)
  ).toEqual(["endpoint-owner"])
  expect(
    inspectRelayPolicy([
      {
        path,
        content: 'const protocol = "wss:"; const url = signedEvent.tags[0][1]',
      },
    ])
  ).toEqual([])
})
test("rejects derived configured-grant bypasses including imported aliases", () => {
  const content =
    'import { relayTargetsFromUrls as make } from "./relay-authority"; const grant = { kind: "app", operation: "read", bucket: "general_read" } as const; make(config.defaultRelays, grant)'
  expect(
    inspectRelayPolicy([{ path, content }]).map((finding) => finding.rule)
  ).toEqual(["configured-grant-owner"])
  expect(
    inspectRelayPolicy([
      {
        path,
        content:
          'configuredRelayTargets({kind:"app", operation:"read", bucket:"general_read"})',
      },
    ])
  ).toEqual([])
})
test("keeps signed, provider and historical destinations distinct from default authority", () => {
  expect(
    inspectRelayPolicy([
      {
        path,
        content:
          'relayTargetsFromUrls(signedRelays,{kind:"owner_nip17",ownerPubkey,operation:"read"}); relayTargetsFromUrls(savedPlan,{kind:"source_delivery",operation:"write"})',
      },
    ])
  ).toEqual([])
  expect(
    inspectRelayPolicy([
      {
        path: "tests/relay-fixture.ts",
        content: 'const relay="wss://fixture.example"; new WebSocket(relay)',
      },
    ])
  ).toEqual([])
})
test("rejects a new unchecked transport without blocking the existing presence adapter", () => {
  expect(
    inspectRelayPolicy([{ path, content: "new WebSocket(destination)" }]).map(
      (finding) => finding.rule
    )
  ).toEqual(["transport-owner"])
  expect(
    inspectRelayPolicy([
      {
        path: "apps/market/src/hooks/useLivePresenceCount.ts",
        content: "new WebSocket(url)",
      },
    ])
  ).toEqual([])
})
test("presentation and non-Nostr exceptions do not exempt executable defaults in those files", () => {
  expect(
    inspectRelayPolicy([
      {
        path: "packages/ui/src/components/RelaySettingsPanel.tsx",
        content:
          '<Input placeholder="wss://relay.example.com" />; const defaults=["wss://hidden.example"]',
      },
    ]).map((finding) => finding.rule)
  ).toEqual(["endpoint-owner"])
  expect(
    inspectRelayPolicy([
      {
        path: "apps/market/src/lib/live-presence.ts",
        content:
          'const PRODUCTION_LIVE_PRESENCE_WEBSOCKET_URL="wss://presence.example"; const nostrDefaults=["wss://hidden.example"]',
      },
    ]).map((finding) => finding.rule)
  ).toEqual(["endpoint-owner"])
  expect(
    inspectRelayPolicy([{ path, content: 'const broken="wss://["' }]).map(
      (finding) => finding.rule
    )
  ).toEqual(["endpoint-owner"])
})
