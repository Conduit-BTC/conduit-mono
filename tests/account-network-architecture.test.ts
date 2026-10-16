import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  applyInboxDeclarationDistributionStage,
  createInMemoryInboxDeclarationEvidenceRepository,
} from "../packages/core/src/protocol/inbox-declaration-evidence"
import {
  readRetainedInboxDeclaration,
  __resetInboxDeclarationCache,
  planInboxReadRelays,
  selectPrivateMessageDeliveryRoute,
} from "../packages/core/src/protocol/private-message-routing"
import {
  hydrateAccountNetworkPreferences,
  reconcileAccountNetworkPreferences,
} from "../packages/core/src/protocol/network-preferences"
import {
  createInMemoryOwnerRelayListEvidenceRepository,
  accountNetworkDiscoveryRelayUrls,
  __resetOwnerRelayListEvidenceForTests,
  reconcileOwnerRelayListEvidence,
} from "../packages/core/src/protocol/owner-relay-list-evidence"
import {
  createInMemoryAccountNetworkLocalStateRepository,
  filterEligibleAccountRelayTargets,
} from "../packages/core/src/protocol/account-network-local-state"
import { setAccountNetworkRoutingSourceEnabled } from "../packages/core/src/protocol/account-network-routing-policy"
import { relayTargetsFromUrls } from "../packages/core/src/protocol/relay-authority"
import { planRelayReads } from "../packages/core/src/protocol/relay-planner"
import { createRelaySettingsFromPreferences } from "../packages/core/src/protocol/relay-settings"
import {
  attachEventSourceRelayUrl,
  type fetchPublicEventsWithDiagnostics,
} from "../packages/core/src/protocol/relay-reader"
import { config } from "../packages/core/src/config"
import type { VerifiedNostrEvent } from "../packages/core/src/protocol/verified-public-event"
import { buildAccountNetworkSettingsView } from "../packages/core/src/protocol/network-settings-view"
import { admitFixture } from "./helpers/public-event"

async function stagedInbox() {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const relay = "wss://current-inbox.synthetic.example"
  const signedEvent = await admitFixture(
    finalizeEvent(
      {
        kind: 10050,
        created_at: 100,
        content: "",
        tags: [["relay", relay]],
      },
      secret
    )
  )
  const record = applyInboxDeclarationDistributionStage(
    undefined,
    {
      pubkey,
      signedEvent,
      expectedCurrentEventId: null,
      publishRelayUrls: ["wss://discovery.synthetic.example"],
      confirmationRelayUrls: ["wss://discovery.synthetic.example"],
      stagedAt: 100_000,
    },
    () => 100_000
  )
  const repository = createInMemoryInboxDeclarationEvidenceRepository(
    [record],
    () => 100_000
  )
  return { pubkey, relay, repository }
}

async function lifecycleFixture() {
  const secret = generateSecretKey()
  const pubkey = getPublicKey(secret)
  const local = createInMemoryAccountNetworkLocalStateRepository()
  const owner = createInMemoryOwnerRelayListEvidenceRepository()
  const inbox = createInMemoryInboxDeclarationEvidenceRepository()
  const appRelay = config.appReadRelayUrls[0]!
  const discovery = accountNetworkDiscoveryRelayUrls().slice(0, 2)
  let observedAt = 100_000
  let outcome:
    "complete" | "partial" | "auth_required" | "verification_failed" =
    "complete"
  const events = new Map<number, VerifiedNostrEvent[]>()
  const sign = async (kind: number, tags: string[][], created_at = 100) =>
    await admitFixture(
      finalizeEvent({ kind, tags, created_at, content: "" }, secret)
    )
  const fetchEventsWithDiagnostics: typeof fetchPublicEventsWithDiagnostics =
    async (filter, options = {}) => {
      const kind = (Array.isArray(filter) ? filter[0] : filter)?.kinds?.[0]
      const targets = [...(options.relayUrls ?? [])]
      const selected =
        outcome === "auth_required" || outcome === "verification_failed"
          ? []
          : (events.get(kind!) ?? [])
      const successful =
        outcome === "complete"
          ? targets
          : outcome === "partial"
            ? targets.slice(0, 1)
            : []
      for (const event of selected)
        for (const url of successful) attachEventSourceRelayUrl(event, url)
      return {
        events: selected,
        attemptedRelayUrls: targets,
        admittedRelayUrls: targets,
        successfulRelayUrls: successful,
        failedRelayUrls: targets.filter((url) => !successful.includes(url)),
        relays: targets.map((relayUrl) => ({
          relayUrl,
          eventCount: selected.length,
          status: successful.includes(relayUrl)
            ? ("success" as const)
            : ("failed" as const),
          outcome: successful.includes(relayUrl)
            ? ("eose" as const)
            : outcome === "partial"
              ? ("timeout" as const)
              : outcome === "complete"
                ? ("eose" as const)
                : outcome,
        })),
      }
    }
  const options = () => ({
    relayUrls: discovery,
    authenticatedPubkey: pubkey,
    requestingAccountPubkey: pubkey,
    localStateRepository: local,
    ownerRelayList: {
      evidenceRepository: owner,
      fetchEventsWithDiagnostics,
      now: () => observedAt,
    },
    inboxDeclaration: {
      evidenceRepository: inbox,
      fetchEventsWithDiagnostics,
      now: () => observedAt,
    },
  })
  const refresh = async () => {
    observedAt += 1_000
    return await reconcileAccountNetworkPreferences(pubkey, options())
  }
  const restore = async () =>
    await hydrateAccountNetworkPreferences(pubkey, options())
  return {
    pubkey,
    appRelay,
    local,
    owner,
    inbox,
    events,
    sign,
    refresh,
    restore,
    setOutcome: (next: typeof outcome) => {
      outcome = next
    },
  }
}

describe("Account Network architecture through real consumers", () => {
  it("routes a valid staged inbox independently of distribution readback", async () => {
    const { pubkey, relay, repository } = await stagedInbox()
    const declaration = await readRetainedInboxDeclaration(pubkey, {
      evidenceRepository: repository,
      now: () => 100_001,
    })
    expect(declaration).not.toBeNull()
    const route = selectPrivateMessageDeliveryRoute({
      rumorKind: 14,
      declaration: declaration!,
      validatedOrder: false,
    })
    expect(route.route).toBe("declared_inbox")
    expect(route.relayUrls).toEqual([relay])
  })

  it("restores a pending current inbox without inventing historical recovery", async () => {
    const { pubkey, relay, repository } = await stagedInbox()
    const reconciliation = await hydrateAccountNetworkPreferences(pubkey, {
      inboxDeclaration: { evidenceRepository: repository, now: () => 100_001 },
      ownerRelayList: {
        evidenceRepository: createInMemoryOwnerRelayListEvidenceRepository(),
      },
    })
    const view = buildAccountNetworkSettingsView({
      reconciliation,
      localState: null,
    })
    const current = view.rows.find((row) => row.url === relay)!
    expect(current.privateInboxEnabled).toBe(true)
    expect(current.privateInboxState).toBe("pending")
    expect(current.recoveryReadOnly).not.toBe(true)
    expect(view.pendingExactDeliveries[0]?.eligibleTargetCount).toBe(1)
    expect(view.appRelays?.warning ?? "").not.toContain(
      "a current Private inbox"
    )
  })

  it("initializes and reconciles untouched switches only from complete scoped absence, then preserves an explicit choice", async () => {
    const fixture = await lifecycleFixture()
    const initial = await fixture.restore()
    expect(initial.ownerRelayList.state).toBe("lookup_unavailable")
    expect(
      (await fixture.local.get(fixture.pubkey))?.routingPolicy
        .personalRelaysEnabled ?? true
    ).toBe(true)
    for (const outcome of [
      "partial",
      "auth_required",
      "verification_failed",
    ] as const) {
      fixture.setOutcome(outcome)
      await fixture.refresh()
      expect(
        (await fixture.local.get(fixture.pubkey))?.routingPolicy
          .personalRelaysEnabled
      ).toBe(true)
    }
    fixture.setOutcome("complete")
    await fixture.refresh()
    expect(
      (await fixture.local.get(fixture.pubkey))?.routingPolicy
        .personalRelaysEnabled
    ).toBe(false)
    fixture.events.set(10002, [
      await fixture.sign(10002, [["r", fixture.appRelay]]),
    ])
    await fixture.refresh()
    expect(
      (await fixture.local.get(fixture.pubkey))?.routingPolicy
        .personalRelaysEnabled
    ).toBe(true)
    await fixture.local.updateRoutingPolicy(fixture.pubkey, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", false)
    )
    fixture.setOutcome("auth_required")
    await fixture.refresh()
    fixture.setOutcome("complete")
    await fixture.refresh()
    await fixture.restore()
    expect(
      (await fixture.local.get(fixture.pubkey))?.routingPolicy
    ).toMatchObject({
      personalRelaysEnabled: false,
      personalRelaysTouched: true,
    })
  })

  it("preserves signed recommendation and independent inbox authority through toggle changes, outages and restart", async () => {
    const fixture = await lifecycleFixture()
    const recommended = config.appRelayDefinitions.filter(
      (definition) => definition.nip65Preset
    )
    const ownerEvent = await fixture.sign(
      10002,
      recommended.map((definition) =>
        definition.nip65Preset === "write"
          ? ["r", definition.url, "write"]
          : ["r", definition.url]
      )
    )
    const inboxEvent = await fixture.sign(10050, [["relay", fixture.appRelay]])
    fixture.events.set(10002, [ownerEvent])
    fixture.events.set(10050, [inboxEvent])
    await fixture.refresh()
    await fixture.local.updateRoutingPolicy(fixture.pubkey, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "app", false)
    )
    const ownerTarget = relayTargetsFromUrls([fixture.appRelay], {
      kind: "owner_nip65",
      operation: "read",
      selection: "read",
      ownerPubkey: fixture.pubkey,
    })
    const admit = async (
      targets: Parameters<
        typeof filterEligibleAccountRelayTargets
      >[0]["targets"],
      operation: "read" | "write"
    ) =>
      await filterEligibleAccountRelayTargets({
        accountPubkey: fixture.pubkey,
        authenticatedPubkey: fixture.pubkey,
        operation,
        targets,
        repository: fixture.local,
        ownerRelayListEvidenceRepository: fixture.owner,
        inboxDeclarationEvidenceRepository: fixture.inbox,
      })
    expect(await admit(ownerTarget, "read")).toHaveLength(1)
    await fixture.local.updateRoutingPolicy(fixture.pubkey, (policy) =>
      setAccountNetworkRoutingSourceEnabled(policy, "personal", false)
    )
    expect(await admit(ownerTarget, "read")).toEqual([])
    fixture.setOutcome("auth_required")
    const degraded = await fixture.refresh()
    expect(degraded.inboxDeclaration.state).toBe("declared")
    expect(degraded.inboxDeclaration.stale).toBe(true)
    expect(
      degraded.inboxDeclaration.observation?.sources?.some(
        (source) => source.availability === "auth_required"
      )
    ).toBe(true)
    const readPlan = planInboxReadRelays({
      declaration: degraded.inboxDeclaration,
      authenticatedPubkey: fixture.pubkey,
      compatibilityRelayUrls: [],
    })
    expect(
      (await admit(readPlan.relayTargets, "read")).map((target) => target.url)
    ).toEqual([fixture.appRelay])
    __resetInboxDeclarationCache()
    __resetOwnerRelayListEvidenceForTests()
    const restored = await fixture.restore()
    expect(restored.inboxDeclaration.eventId).toBe(inboxEvent.id)
    expect(
      selectPrivateMessageDeliveryRoute({
        rumorKind: 14,
        declaration: restored.inboxDeclaration,
        validatedOrder: false,
      }).relayUrls
    ).toEqual([fixture.appRelay])
    const view = buildAccountNetworkSettingsView({
      reconciliation: restored,
      localState: (await fixture.local.get(fixture.pubkey)) ?? null,
    })
    expect(
      view.rows.find((row) => row.url === fixture.appRelay)?.recoveryReadOnly
    ).not.toBe(true)
  })

  it("keeps recipient NIP-17 delivery independent of both sender layer switches", async () => {
    const recipient = await lifecycleFixture()
    const event = await recipient.sign(10050, [["relay", recipient.appRelay]])
    recipient.events.set(10050, [event])
    const current = (await recipient.refresh()).inboxDeclaration
    const sender = await lifecycleFixture()
    for (const source of ["app", "personal"] as const)
      await sender.local.updateRoutingPolicy(sender.pubkey, (policy) =>
        setAccountNetworkRoutingSourceEnabled(policy, source, false)
      )
    const route = selectPrivateMessageDeliveryRoute({
      rumorKind: 14,
      declaration: current,
      validatedOrder: false,
    })
    const targets = await filterEligibleAccountRelayTargets({
      accountPubkey: sender.pubkey,
      authenticatedPubkey: sender.pubkey,
      targets: route.relayTargets,
      operation: "write",
      repository: sender.local,
      inboxDeclarationEvidenceRepository: recipient.inbox,
    })
    expect(targets.map((target) => target.url)).toEqual([recipient.appRelay])
    expect(targets[0]?.grants.map((grant) => grant.kind)).toEqual([
      "recipient_nip17",
    ])
  })

  it("selects the same current authority after concurrent equal-time signed observations in either order", async () => {
    const fixture = await lifecycleFixture()
    const first = await fixture.sign(10002, [["r", fixture.appRelay]], 101)
    const second = await fixture.sign(
      10002,
      [["r", "wss://other.synthetic.example"]],
      101
    )
    const snapshots = []
    for (const order of [
      [first, second],
      [second, first],
    ]) {
      __resetOwnerRelayListEvidenceForTests()
      const repository = createInMemoryOwnerRelayListEvidenceRepository()
      await Promise.all(
        order.map((signedEvent) =>
          reconcileOwnerRelayListEvidence(
            {
              pubkey: fixture.pubkey,
              observations: [{ signedEvent, observedAt: 101_000 }],
              lookup: {
                observedAt: 101_000,
                coverage: "complete",
                hadEvent: true,
                eventId: signedEvent.id,
              },
            },
            repository
          )
        )
      )
      const restored = await hydrateAccountNetworkPreferences(fixture.pubkey, {
        ownerRelayList: { evidenceRepository: repository },
        inboxDeclaration: { evidenceRepository: fixture.inbox },
        localStateRepository: fixture.local,
      })
      const plan = planRelayReads({
        intent: "general",
        authenticatedPubkey: fixture.pubkey,
        ownerSelectedRelayUrls: restored.ownerRelayList.preferences.map(
          (entry) => entry.url
        ),
        settings: createRelaySettingsFromPreferences(
          restored.ownerRelayList.preferences,
          "published"
        ),
        signedRelayListAuthoritative: true,
        skipHealthFilter: true,
      })
      snapshots.push({
        id: restored.ownerRelayList.current?.signedEvent.id,
        urls: plan.relayTargets
          .filter((target) =>
            target.grants.some((grant) => grant.kind === "owner_nip65")
          )
          .map((target) => target.url),
      })
    }
    expect(snapshots[0]).toEqual(snapshots[1])
    expect(snapshots[0]?.id).toBe([first.id, second.id].sort()[0])
  })
})
