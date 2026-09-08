import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  createServer,
  type ViteDevServer,
} from "../apps/market/node_modules/vite/dist/node/index.js"
import type { AccountNetworkPreferenceUpdateRecord } from "../packages/core/src/db"

const marketAppDir = fileURLToPath(new URL("../apps/market", import.meta.url))
const marketViteConfig = fileURLToPath(
  new URL("../apps/market/vite.config.ts", import.meta.url)
)
const updateStateModuleUrl = `/@fs${process.cwd()}/packages/core/src/protocol/network-preference-update-state.ts`
const routingModuleUrl = `/@fs${process.cwd()}/packages/core/src/protocol/private-message-routing.ts`

let productionMarketServer: ViteDevServer
let productionMarketUrl: string

test.beforeAll(async () => {
  productionMarketServer = await createServer({
    configFile: marketViteConfig,
    root: marketAppDir,
    mode: "mainnet",
    server: { host: "127.0.0.1", port: 0 },
  })
  await productionMarketServer.listen()
  const address = productionMarketServer.httpServer?.address()
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve the isolated Market test server")
  }
  productionMarketUrl = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await productionMarketServer?.close()
})

test("a staged whole removal constrains the next read and write in another tab @market", async ({
  context,
}) => {
  await context.routeWebSocket(/^(?:ws|wss):\/\//, (socket) => {
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

  const ownerSecret = generateSecretKey()
  const owner = getPublicKey(ownerSecret)
  const other = getPublicKey(generateSecretKey())
  const removedRelay = "wss://removed-cross-tab.example"
  const permittedRelay = "wss://permitted-cross-tab.example"
  const secondaryRelay = "wss://secondary-cross-tab.example"
  const publishRelay = "wss://publish-cross-tab.example"
  const stagedAt = Date.now()
  const relayList = finalizeEvent(
    {
      kind: 10_002,
      created_at: 100,
      tags: [
        ["r", permittedRelay],
        ["r", secondaryRelay, "read"],
      ],
      content: "",
    },
    ownerSecret
  )
  const inbox = finalizeEvent(
    {
      kind: 10_050,
      created_at: 100,
      tags: [["relay", permittedRelay]],
      content: "",
    },
    ownerSecret
  )
  const checkpoints: AccountNetworkPreferenceUpdateRecord["checkpoints"] = [
    {
      kind: 10_002,
      signedEvent: relayList,
      stagedAt,
      relayPlan: [publishRelay],
      relayOutcomes: [
        {
          relayUrl: publishRelay,
          publishStatus: "pending",
          publishAttemptCount: 0,
          readbackStatus: "pending",
          readbackAttemptCount: 0,
        },
      ],
      state: "active",
    },
    {
      kind: 10_050,
      signedEvent: inbox,
      stagedAt,
      relayPlan: [publishRelay],
      relayOutcomes: [
        {
          relayUrl: publishRelay,
          publishStatus: "pending",
          publishAttemptCount: 0,
          readbackStatus: "pending",
          readbackAttemptCount: 0,
        },
      ],
      state: "active",
    },
  ]
  const record: AccountNetworkPreferenceUpdateRecord = {
    pubkey: owner,
    updateId: checkpoints
      .map((checkpoint) => `${checkpoint.kind}:${checkpoint.signedEvent.id}`)
      .join("|"),
    action: "whole_relay_removal",
    removedRelayUrl: removedRelay,
    baseRelayList: {
      eventId: null,
      createdAt: null,
      state: "not_observed",
    },
    baseInboxDeclaration: {
      eventId: null,
      createdAt: null,
      state: "not_observed",
    },
    nip65Preferences: [
      {
        url: permittedRelay,
        readEnabled: true,
        writeEnabled: true,
      },
      {
        url: secondaryRelay,
        readEnabled: true,
        writeEnabled: false,
      },
    ],
    inboxRelayUrls: [permittedRelay],
    previousInboxRelayUrls: [removedRelay],
    legacyRecoveryRemovedRelayUrls: [removedRelay],
    legacyRecoveryDiscarded: true,
    cutoverPolicyVersion: 1,
    cutoverGraceMs: 30 * 24 * 60 * 60 * 1_000,
    checkpoints,
    stagedAt,
    updatedAt: stagedAt,
  }

  const firstPage = await context.newPage()
  const secondPage = await context.newPage()
  const runtimeErrors: string[] = []
  for (const [name, page] of [
    ["first", firstPage],
    ["second", secondPage],
  ] as const) {
    page.on("pageerror", (error) =>
      runtimeErrors.push(`${name}: ${error.message}`)
    )
  }
  await Promise.all([
    firstPage.goto(`${productionMarketUrl}/products`),
    secondPage.goto(`${productionMarketUrl}/products`),
  ])

  await secondPage.evaluate(
    async ({ moduleUrl, ownerPubkey }) => {
      const { subscribeToAccountNetworkPreferenceRuntimeState } = (await import(
        moduleUrl
      )) as typeof import("../packages/core/src/protocol/network-preference-update-state")
      const probe = window as typeof window & {
        __networkPreferenceRuntimeEvents?: string[][]
        __unsubscribeNetworkPreferenceRuntime?: () => void
      }
      probe.__networkPreferenceRuntimeEvents = []
      probe.__unsubscribeNetworkPreferenceRuntime =
        subscribeToAccountNetworkPreferenceRuntimeState(ownerPubkey, {
          onChange({ relayCutoff }) {
            probe.__networkPreferenceRuntimeEvents?.push([
              ...relayCutoff.excludedRelayUrls,
            ])
          },
          onError(error) {
            throw error
          },
        })
    },
    { moduleUrl: updateStateModuleUrl, ownerPubkey: owner }
  )
  await expect
    .poll(() =>
      secondPage.evaluate(
        () =>
          (
            window as typeof window & {
              __networkPreferenceRuntimeEvents?: string[][]
            }
          ).__networkPreferenceRuntimeEvents?.length ?? 0
      )
    )
    .toBeGreaterThan(0)

  await firstPage.evaluate(
    async ({ moduleUrl, stagedRecord }) => {
      const { dexieAccountNetworkPreferenceUpdateRepository } = (await import(
        moduleUrl
      )) as typeof import("../packages/core/src/protocol/network-preference-update-state")
      await dexieAccountNetworkPreferenceUpdateRepository.stage({
        record: stagedRecord,
        expectedUpdateId: null,
      })
    },
    { moduleUrl: updateStateModuleUrl, stagedRecord: record }
  )

  const decisions = await secondPage.evaluate(
    async ({
      stateUrl,
      routingUrl,
      ownerPubkey,
      otherPubkey,
      removed,
      kept,
    }) => {
      const { loadAccountPrivateMessageRelayCutoff } = (await import(
        stateUrl
      )) as typeof import("../packages/core/src/protocol/network-preference-update-state")
      const { planInboxReadRelays, selectPrivateMessageDeliveryRoute } =
        (await import(
          routingUrl
        )) as typeof import("../packages/core/src/protocol/private-message-routing")
      const declaration = (pubkey: string) => ({
        pubkey,
        state: "declared" as const,
        relayUrls: [removed, kept],
        stale: false,
        fetchedAt: Date.now(),
      })

      const ownerCutoff =
        await loadAccountPrivateMessageRelayCutoff(ownerPubkey)
      const ownerRead = planInboxReadRelays({
        declaration: declaration(ownerPubkey),
        authenticatedPubkey: ownerPubkey,
        relayCutoff: ownerCutoff,
        localReadRelayUrls: [],
        compatibilityRelayUrls: [],
        requiredCompatibilityRelayUrls: [],
      }).relayUrls
      const ownerDeclaredWrite = selectPrivateMessageDeliveryRoute({
        rumorKind: 14,
        declaration: declaration(otherPubkey),
        authenticatedPubkey: ownerPubkey,
        relayCutoff: ownerCutoff,
        validatedOrder: false,
      }).relayUrls
      const ownerCompatibilityWrite = selectPrivateMessageDeliveryRoute({
        rumorKind: 16,
        declaration: {
          ...declaration(otherPubkey),
          state: "not_observed",
          relayUrls: [],
        },
        authenticatedPubkey: ownerPubkey,
        relayCutoff: ownerCutoff,
        validatedOrder: true,
        compatibilityEnabled: true,
        compatibilityRelayUrls: [removed, kept],
        recipientReadRelayUrls: [removed, kept],
      }).relayUrls

      const otherCutoff =
        await loadAccountPrivateMessageRelayCutoff(otherPubkey)
      const otherRead = planInboxReadRelays({
        declaration: declaration(otherPubkey),
        authenticatedPubkey: otherPubkey,
        relayCutoff: otherCutoff,
        localReadRelayUrls: [],
        compatibilityRelayUrls: [],
        requiredCompatibilityRelayUrls: [],
      }).relayUrls
      const otherWrite = selectPrivateMessageDeliveryRoute({
        rumorKind: 14,
        declaration: declaration(ownerPubkey),
        authenticatedPubkey: otherPubkey,
        relayCutoff: otherCutoff,
        validatedOrder: false,
      }).relayUrls

      return {
        ownerCutoff: ownerCutoff.excludedRelayUrls,
        ownerRead,
        ownerDeclaredWrite,
        ownerCompatibilityWrite,
        otherCutoff: otherCutoff.excludedRelayUrls,
        otherRead,
        otherWrite,
      }
    },
    {
      stateUrl: updateStateModuleUrl,
      routingUrl: routingModuleUrl,
      ownerPubkey: owner,
      otherPubkey: other,
      removed: removedRelay,
      kept: permittedRelay,
    }
  )

  expect(decisions).toEqual({
    ownerCutoff: [removedRelay],
    ownerRead: [permittedRelay],
    ownerDeclaredWrite: [permittedRelay],
    ownerCompatibilityWrite: [permittedRelay],
    otherCutoff: [],
    otherRead: [removedRelay, permittedRelay],
    otherWrite: [removedRelay, permittedRelay],
  })
  await expect
    .poll(() =>
      secondPage.evaluate(
        () =>
          (
            window as typeof window & {
              __networkPreferenceRuntimeEvents?: string[][]
            }
          ).__networkPreferenceRuntimeEvents?.at(-1) ?? []
      )
    )
    .toEqual([removedRelay])
  await secondPage.evaluate(() => {
    const probe = window as typeof window & {
      __unsubscribeNetworkPreferenceRuntime?: () => void
    }
    probe.__unsubscribeNetworkPreferenceRuntime?.()
  })
  expect(runtimeErrors).toEqual([])
})
