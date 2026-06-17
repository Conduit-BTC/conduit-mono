import { config } from "../config"
import type { DmRelayList } from "./dm-relay-list"
import { partitionByHealth } from "./relay-health"
import {
  getGeneralWriteRelayUrls,
  type RelayPlanOptions,
  type RelaySettingsState,
} from "./relay-settings"
import type { RelayWritePlan } from "./relay-planner"

export const ORDER_MESSAGE_PRIMARY_FANOUT = 4
export const ORDER_MESSAGE_BROADCAST_FANOUT = 4
export const ORDER_MESSAGE_READ_FANOUT = 8

function dedupeOrdered(urls: readonly (string | undefined | null)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of urls) {
    if (!url) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

function clampFanout(urls: string[], limit: number | undefined): string[] {
  if (limit === undefined || limit <= 0) return urls
  return urls.slice(0, limit)
}

function applyHealthFilter(
  urls: readonly string[],
  skipHealthFilter: boolean | undefined,
  now: number | undefined
): { kept: string[]; parked: string[] } {
  if (skipHealthFilter) return { kept: dedupeOrdered(urls), parked: [] }
  const { healthy, parked } = partitionByHealth(urls, now ?? Date.now())
  return { kept: dedupeOrdered(healthy), parked: dedupeOrdered(parked) }
}

function settingsPlanOptions(input: {
  settings?: RelaySettingsState
}): RelayPlanOptions {
  return {
    settings: input.settings,
    fallbackRelayUrls: [],
  }
}

function recipientInboxRelayUrls(
  recipients: readonly string[],
  dmRelayLists: ReadonlyMap<string, DmRelayList> | undefined
): { relayUrls: string[]; missingRecipients: string[] } {
  const relayUrls: string[] = []
  const missingRecipients: string[] = []

  for (const recipient of recipients) {
    const list = dmRelayLists?.get(recipient)
    if (!list || list.relayUrls.length === 0) {
      missingRecipients.push(recipient)
      continue
    }
    relayUrls.push(...list.relayUrls)
  }

  return {
    relayUrls: dedupeOrdered(relayUrls),
    missingRecipients,
  }
}

export interface Nip17OrderMessageDeliveryPlanInput {
  recipientPubkeys: readonly string[]
  dmRelayLists?: ReadonlyMap<string, DmRelayList>
  settings?: RelaySettingsState
  maxPrimaryRelays?: number
  maxBroadcastRelays?: number
  skipHealthFilter?: boolean
  now?: number
}

/**
 * Plan encrypted order-message delivery.
 *
 * NIP-17 kind:10050 inbox relays are the preferred primary targets. Missing
 * or invalid inbox lists fall back to Conduit's bounded commerce DM relay set.
 * The user's write relays are only best-effort broadcast targets and do not
 * make recipient delivery successful by themselves.
 */
export function planNip17OrderMessageDelivery(
  input: Nip17OrderMessageDeliveryPlanInput
): RelayWritePlan {
  const recipients = dedupeOrdered(input.recipientPubkeys)
  const userWriteRelays = getGeneralWriteRelayUrls(
    settingsPlanOptions({ settings: input.settings })
  )
  const { relayUrls: inboxRelayUrls, missingRecipients } =
    recipientInboxRelayUrls(recipients, input.dmRelayLists)

  const shouldUseFallback = missingRecipients.length > 0
  const fallbackRelayUrls = shouldUseFallback
    ? config.commerceDmFallbackRelayUrls
    : []
  const primaryCandidates = dedupeOrdered([
    ...inboxRelayUrls,
    ...fallbackRelayUrls,
  ])
  let primaryHealth = applyHealthFilter(
    primaryCandidates,
    input.skipHealthFilter,
    input.now
  )

  if (
    primaryHealth.kept.length === 0 &&
    inboxRelayUrls.length > 0 &&
    config.commerceDmFallbackRelayUrls.length > 0
  ) {
    const fallbackHealth = applyHealthFilter(
      config.commerceDmFallbackRelayUrls,
      input.skipHealthFilter,
      input.now
    )
    primaryHealth = {
      kept: fallbackHealth.kept,
      parked: dedupeOrdered([
        ...primaryHealth.parked,
        ...fallbackHealth.parked,
      ]),
    }
  }

  const primaryRelayUrls = clampFanout(
    primaryHealth.kept,
    input.maxPrimaryRelays ?? ORDER_MESSAGE_PRIMARY_FANOUT
  )
  const broadcastOrdered = dedupeOrdered(
    userWriteRelays.filter((url) => !primaryRelayUrls.includes(url))
  )
  const broadcastHealth = applyHealthFilter(
    broadcastOrdered,
    input.skipHealthFilter,
    input.now
  )

  return {
    intent: "recipient_event",
    primaryRelayUrls,
    broadcastRelayUrls: clampFanout(
      broadcastHealth.kept,
      input.maxBroadcastRelays ?? ORDER_MESSAGE_BROADCAST_FANOUT
    ),
    parkedRelayUrls: dedupeOrdered([
      ...primaryHealth.parked,
      ...broadcastHealth.parked,
    ]),
  }
}

export interface Nip17OrderMessageReadPlanInput {
  recipientPubkey: string
  dmRelayList?: DmRelayList
  maxRelays?: number
  skipHealthFilter?: boolean
  now?: number
}

export interface Nip17OrderMessageReadPlan {
  relayUrls: string[]
  inboxRelayUrls: string[]
  fallbackRelayUrls: string[]
  parkedRelayUrls: string[]
}

export function planNip17OrderMessageReads(
  input: Nip17OrderMessageReadPlanInput
): Nip17OrderMessageReadPlan {
  const inboxRelayUrls = dedupeOrdered(input.dmRelayList?.relayUrls ?? [])
  const fallbackRelayUrls = dedupeOrdered(config.commerceDmFallbackRelayUrls)
  const ordered = dedupeOrdered([...inboxRelayUrls, ...fallbackRelayUrls])
  const { kept, parked } = applyHealthFilter(
    ordered,
    input.skipHealthFilter,
    input.now
  )

  return {
    relayUrls: clampFanout(kept, input.maxRelays ?? ORDER_MESSAGE_READ_FANOUT),
    inboxRelayUrls,
    fallbackRelayUrls,
    parkedRelayUrls: parked,
  }
}
