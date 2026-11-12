import { config } from "../config"
import { configuredRelayTargets } from "./account-network-local-state"

/** Public catalog/display reads; never purchase or mutation authority. */
export type PublicReadScope = "public_feed"

/** Resolve only the centrally configured commerce peers, before hint discovery.
 * App grants retain final account admission and app-layer disable semantics.
 * An empty set is explicit and must not invoke a transport's default relays.
 */
export function getPublicFeedReadPlan(maxRelayAttempts?: number) {
  const relayTargets = configuredRelayTargets(
    { kind: "app", operation: "read", bucket: "commerce_read" },
    config.commerceDiscoveryRelayUrls
  )
  const relayUrls = relayTargets.map((target) => target.url)
  return {
    relayUrls,
    relayTargets,
    candidateRelayUrls: relayUrls,
    maxRelayAttempts,
    parkedRelayUrls: [] as string[],
    hintRelayUrls: [] as string[],
    ownerSelectedRelayUrls: [] as string[],
    appRelayUrls: relayUrls,
    personalRelayUrls: [] as string[],
    independentRelayUrls: [] as string[],
  }
}

/** Fetch identity only: signed evidence custody remains shared across scopes. */
export function getPublicFeedReadScopeKey(readScope?: PublicReadScope): string {
  return readScope === "public_feed"
    ? JSON.stringify(["public_feed_v1", getPublicFeedReadPlan().relayUrls])
    : "authority"
}
