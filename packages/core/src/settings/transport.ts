import type {
  AccountSigner,
  SignedNostrEvent,
} from "../protocol/nostr-event-signer"
import { fetchSignedEventsFanoutDetailed } from "../protocol/relay-reader"
import { getRelayLists } from "../protocol/relay-list"
import {
  loadRelaySettingsPlanningSnapshot,
  normalizeOwnerSelectedRelayUrls,
} from "../protocol/relay-settings"
import { readDurableAccountRelaySettingsPlanningSnapshot } from "../protocol/network-preferences"
import { planRelayReads } from "../protocol/relay-planner"
import { mergeRelayTargets } from "../protocol/relay-authority"
import { configuredRelayTargets } from "../protocol/account-network-local-state"
import { accountStorageRelayTargets } from "../protocol/account-storage-relay-policy"
import { publishWithPlanner } from "../protocol/relay-publish"
import { PRIVATE_SETTINGS_KIND } from "./documents"
import { commerceRelayExecutor } from "../protocol/relay-executor"
import { getProtectedReadAuthorization } from "../protocol/protected-read-authorization"
import { filterEligibleAccountRelayTargets } from "../protocol/account-network-local-state"

export interface SettingsRead {
  events: SignedNostrEvent[]
  coverage: "complete" | "partial" | "unavailable"
}
export interface SettingsTransport {
  read(
    owner: string,
    kind: number,
    active: () => boolean,
    id?: string
  ): Promise<SettingsRead>
  publish(
    event: SignedNostrEvent,
    active: () => boolean,
    priority?: "foreground" | "background"
  ): Promise<boolean>
}
export function createSettingsTransport(
  signer?: AccountSigner
): SettingsTransport {
  return {
    async read(owner, kind, active, id) {
      const privateDocument = kind === PRIVATE_SETTINGS_KIND
      if (privateDocument && signer?.pubkey !== owner)
        return { events: [], coverage: "unavailable" }
      const publicPlan = privateDocument
        ? undefined
        : await publicReadPlan(owner, signer, active)
      const targets = privateDocument
        ? accountStorageRelayTargets("read")
        : publicPlan!.targets
      const relayUrls = targets.map((target) => target.url)
      if (privateDocument) {
        const authorization = getProtectedReadAuthorization(owner)
        if (!authorization) return { events: [], coverage: "unavailable" }
        const eligible = await filterEligibleAccountRelayTargets({
          accountPubkey: owner,
          authenticatedPubkey: owner,
          targets: targets!,
          operation: "read",
        })
        const result = await commerceRelayExecutor.query(
          {
            operation: "private_settings_read",
            relayUrls: eligible.map((t) => t.url),
            filters: [
              {
                authors: [owner],
                kinds: [kind],
                ...(id ? { ids: [id] } : {}),
                limit: 8,
              },
            ],
          },
          {
            authorization,
            admitRelay: async (url) =>
              active() &&
              (
                await filterEligibleAccountRelayTargets({
                  accountPubkey: owner,
                  authenticatedPubkey: owner,
                  targets: targets!,
                  operation: "read",
                })
              ).some((t) => t.url === url),
            connectTimeoutMs: 2000,
            queryTimeoutMs: 3000,
            maxEventsPerRelay: 8,
            maxBytesPerRelay: 400000,
          }
        )
        return {
          events: result.events,
          coverage:
            result.status === "success" &&
            result.relays.length > 0 &&
            result.relays.every(
              (r) =>
                r.status === "success" &&
                r.malformedCount === 0 &&
                r.unusableCount === 0
            ) &&
            result.events.length < 8
              ? "complete"
              : result.status === "partial"
                ? "partial"
                : "unavailable",
        }
      }
      const result = await fetchSignedEventsFanoutDetailed(
        {
          authors: [owner],
          kinds: [kind],
          ...(id ? { ids: [id] } : {}),
          limit: 8,
        },
        {
          relayUrls,
          relayTargets: targets,
          maxRelayAttempts: 8,
          connectTimeoutMs: 2000,
          fetchTimeoutMs: 3000,
          accountPubkey: signer?.pubkey,
          authenticatedPubkey: signer?.pubkey,
          shouldContinue: active,
        }
      )
      return {
        events: result.events,
        coverage:
          result.relays.length === relayUrls.length &&
          result.relays.length > 0 &&
          result.relays.every((r) => r.status === "success") &&
          result.events.length < 8
            ? "complete"
            : result.relays.some((r) => r.status === "success")
              ? "partial"
              : "unavailable",
      }
    },
    async publish(event, active, priority = "background") {
      const privateDocument = event.kind === PRIVATE_SETTINGS_KIND
      const targets = privateDocument
        ? accountStorageRelayTargets("write")
        : undefined
      const result = await publishWithPlanner(event, {
        intent: "author_event",
        authorPubkey: event.pubkey,
        accountPubkey: signer?.pubkey,
        authenticatedPubkey: signer?.pubkey,
        shouldContinue: active,
        deliveryMode: privateDocument ? "critical" : "standard",
        ...(targets
          ? {
              exclusiveRelayUrls: targets.map((t) => t.url),
              relayTargets: targets,
            }
          : {}),
        ...(signer && privateDocument
          ? {
              relayAuthentication: {
                expectedPubkey: signer.pubkey,
                signer: {
                  authMethod: signer.authMethod,
                  getPublicKey: () => signer.getPublicKey(),
                  signEvent: (draft) => signer.signEvent(draft, { priority }),
                },
                sessionScope: signer,
              },
            }
          : {}),
      })
      return result.successfulRelayUrls.length > 0
    },
  }
}

async function publicReadPlan(
  owner: string,
  signer: AccountSigner | undefined,
  active: () => boolean
) {
  const snapshot = signer
    ? await readDurableAccountRelaySettingsPlanningSnapshot(signer.pubkey)
    : loadRelaySettingsPlanningSnapshot()
  const context = {
    authenticatedPubkey: signer?.pubkey,
    ownerSelectedRelayUrls: signer
      ? normalizeOwnerSelectedRelayUrls(
          snapshot.settings.entries.flatMap((entry) =>
            entry.readEnabled || entry.writeEnabled ? [entry.url] : []
          )
        )
      : [],
    settings: snapshot.settings,
    signedRelayListAuthoritative: snapshot.signedRelayListAuthoritative,
    maxRelays: 8,
  }
  const discovery = planRelayReads({ ...context, intent: "relay_lists" })
  const relayLists = await getRelayLists([owner], {
    accountPubkey: signer?.pubkey,
    authenticatedPubkey: signer?.pubkey,
    relayUrls: discovery.candidateRelayUrls,
    relayTargets: discovery.relayTargets,
    maxRelayAttempts: discovery.maxRelayAttempts,
    shouldContinue: active,
    ownerSelectedRelayUrls: discovery.ownerSelectedRelayUrls,
    appRelayUrls: discovery.appRelayUrls,
    personalRelayUrls: discovery.personalRelayUrls,
    independentRelayUrls: discovery.independentRelayUrls,
  })
  const plan = planRelayReads({
    ...context,
    intent: "general",
    authors: [owner],
    relayLists,
  })
  const targets = mergeRelayTargets(
    plan.relayTargets,
    configuredRelayTargets({
      kind: "app",
      operation: "read",
      bucket: "author_readback",
    }),
    configuredRelayTargets({
      kind: "public_fallback",
      operation: "read",
      bucket: "core_public",
    })
  ).slice(0, 8)
  return { targets }
}
