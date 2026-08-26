import { randomUUID } from "node:crypto"

import { expect, test } from "@playwright/test"

const marketPort = process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
const marketOrigin = `http://127.0.0.1:${marketPort}`
const marketWebSocketOrigin = `ws://127.0.0.1:${marketPort}`
const auditPathPrefix = "/__conduit_network_audit__/"
const harnessUrl = "/src/test-fixtures/network-target-audit-harness.tsx"

const publicMediaUrl =
  "https://media-audit.conduit.market/__conduit_network_audit__/media/public.svg"
const publicFetchUrl =
  "https://pay-audit.conduit.market/__conduit_network_audit__/fetch/public"
const publicRelayUrl =
  "wss://relay-audit.conduit.market/__conduit_network_audit__/relay/public"

function withRuntimeUserInfo(rawUrl: string): string {
  const target = new URL(rawUrl)
  target.username = `audit-${randomUUID()}`
  target.password = randomUUID()
  return target.toString()
}

const credentialHttpTarget = withRuntimeUserInfo(
  "https://media-audit.conduit.market/__conduit_network_audit__/credentials"
)
const credentialRelayTarget = withRuntimeUserInfo(
  "wss://relay-audit.conduit.market/__conduit_network_audit__/credentials"
)

const unsafeHttpTargets = [
  {
    id: "loopback",
    url: "https://127.0.0.1/__conduit_network_audit__/loopback",
  },
  {
    id: "metadata",
    url: "https://169.254.169.254/__conduit_network_audit__/metadata",
  },
  {
    id: "private-v4",
    url: "https://10.0.0.1/__conduit_network_audit__/private-v4",
  },
  {
    id: "private-v6",
    url: "https://[fd00::1]/__conduit_network_audit__/private-v6",
  },
  {
    id: "orchid",
    url: "https://[2001:10::1]/__conduit_network_audit__/orchid",
  },
  {
    id: "orchid-v2",
    url: "https://[2001:20::1]/__conduit_network_audit__/orchid-v2",
  },
  {
    id: "numeric-v4",
    url: "https://2130706433/__conduit_network_audit__/numeric-v4",
  },
  {
    id: "credentials",
    url: credentialHttpTarget,
  },
  {
    id: "special-use",
    url: "https://service.test/__conduit_network_audit__/special-use",
  },
] as const

const mediaTargets = [
  ...unsafeHttpTargets,
  { id: "public", url: publicMediaUrl },
] as const

const fetchTargets = [
  ...unsafeHttpTargets,
  { id: "public", url: publicFetchUrl },
] as const

const relayTargets = [
  "wss://127.0.0.1:9/__conduit_network_audit__/loopback",
  "wss://169.254.169.254/__conduit_network_audit__/metadata",
  "wss://10.0.0.1/__conduit_network_audit__/private-v4",
  "wss://[fd00::1]/__conduit_network_audit__/private-v6",
  "wss://[2001:10::1]/__conduit_network_audit__/orchid",
  "wss://[2001:20::1]/__conduit_network_audit__/orchid-v2",
  "wss://2130706433/__conduit_network_audit__/numeric-v4",
  credentialRelayTarget,
  "wss://service.test/__conduit_network_audit__/special-use",
  "ws://third-party.conduit.market/__conduit_network_audit__/insecure",
  publicRelayUrl,
] as const

test.use({ serviceWorkers: "block" })

test("market blocks untrusted media, fetch, and relay targets before browser dispatch @market", async ({
  context,
  page,
}) => {
  const observedHttp: Array<{ url: string; resourceType: string }> = []
  const observedWebSockets: string[] = []
  const onePixelSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>'

  await context.route("**/*", async (route) => {
    const request = route.request()
    const requestUrl = new URL(request.url())

    if (requestUrl.origin === marketOrigin) {
      await route.continue()
      return
    }

    observedHttp.push({
      url: request.url(),
      resourceType: request.resourceType(),
    })

    if (request.url() === publicMediaUrl) {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: onePixelSvg,
      })
      return
    }

    if (request.url() === publicFetchUrl) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({
          tag: "payRequest",
          callback:
            "https://pay-audit.conduit.market/__conduit_network_audit__/fetch/callback",
          minSendable: 1_000,
          maxSendable: 1_000,
          metadata: "[]",
          allowsNostr: false,
        }),
      })
      return
    }

    // This is the fail-safe that makes the metadata/link-local cases safe: a
    // boundary regression is recorded and aborted before any OS connection.
    await route.abort("blockedbyclient")
  })

  await context.routeWebSocket(/^(?:ws|wss):\/\//, async (socket) => {
    const socketUrl = new URL(socket.url())
    if (socketUrl.origin === marketWebSocketOrigin) {
      const server = socket.connectToServer()
      socket.onMessage((message) => server.send(message))
      server.onMessage((message) => socket.send(message))
      return
    }

    observedWebSockets.push(socket.url())
    if (socket.url() !== publicRelayUrl) {
      await socket.close({ code: 1008, reason: "blocked by request auditor" })
      return
    }

    socket.onMessage((message) => {
      if (typeof message !== "string") return
      let frame: unknown
      try {
        frame = JSON.parse(message)
      } catch {
        return
      }
      if (
        Array.isArray(frame) &&
        frame[0] === "REQ" &&
        typeof frame[1] === "string"
      ) {
        socket.send(JSON.stringify(["EOSE", frame[1]]))
      }
    })
  })

  await page.goto(`${marketOrigin}/privacy-policy`)

  const auditResult = await page.evaluate(
    async ({ fixtureUrl, media, fetches, relays }) => {
      const container = document.createElement("div")
      container.id = "network-target-audit-harness"
      document.body.append(container)
      const fixture = (await import(fixtureUrl)) as {
        mountNetworkTargetAuditHarness: (
          element: HTMLElement,
          targets: readonly { id: string; url: string }[]
        ) => () => void
        runNetworkTargetAudit: (input: {
          fetchTargets: readonly { id: string; url: string }[]
          relayTargets: readonly string[]
        }) => Promise<{
          fetchStatuses: Array<{
            id: string
            status: "fulfilled" | "rejected"
          }>
          acceptedRelayUrls: string[]
          relayStatuses: Array<{
            relayUrl: string
            status: "success" | "partial" | "failed"
          }>
        }>
      }
      fixture.mountNetworkTargetAuditHarness(container, media)
      return await fixture.runNetworkTargetAudit({
        fetchTargets: fetches,
        relayTargets: relays,
      })
    },
    {
      fixtureUrl: harnessUrl,
      media: mediaTargets,
      fetches: fetchTargets,
      relays: relayTargets,
    }
  )

  expect(auditResult.fetchStatuses).toEqual([
    ...unsafeHttpTargets.map(({ id }) => ({ id, status: "rejected" })),
    { id: "public", status: "fulfilled" },
  ])
  expect(auditResult.acceptedRelayUrls).toEqual([publicRelayUrl])
  expect(auditResult.relayStatuses).toEqual([
    { relayUrl: publicRelayUrl, status: "success" },
  ])

  const auditRoot = page.getByTestId("network-target-audit-root")
  await expect(auditRoot.locator("img")).toHaveCount(1)
  await expect(auditRoot.locator("img")).toHaveAttribute("src", publicMediaUrl)
  for (const target of unsafeHttpTargets) {
    await expect(
      auditRoot.getByTestId(`media-${target.id}`).locator("img")
    ).toHaveCount(0)
  }

  await expect.poll(() => observedHttp.length).toBe(2)
  expect(
    [...observedHttp].sort((left, right) => left.url.localeCompare(right.url))
  ).toEqual(
    [
      { url: publicFetchUrl, resourceType: "fetch" },
      { url: publicMediaUrl, resourceType: "image" },
    ].sort((left, right) => left.url.localeCompare(right.url))
  )
  expect(observedWebSockets).toEqual([publicRelayUrl])
  expect(
    observedHttp.every(({ url }) =>
      new URL(url).pathname.startsWith(auditPathPrefix)
    )
  ).toBe(true)
})
