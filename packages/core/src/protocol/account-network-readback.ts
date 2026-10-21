import { classifyAccountNetworkReadback } from "./account-network-evidence"
import type { NetworkPreferenceReadbackObservation } from "./network-preference-delivery"
import { NostrSignerError } from "./nostr-event-signer"
import {
  getProtectedReadAuthorization,
  hasProtectedReadAuthority,
} from "./protected-read-authorization"
import {
  commerceRelayExecutor,
  type CommerceRelayExecutor,
} from "./relay-executor"
import {
  fetchSignedEventsFanoutDetailed,
  type PublicRelayReadOptions,
} from "./relay-reader"
import type { SignedPublicNostrEvent } from "./signed-event"
import {
  admitPublicEvent,
  sameSignedPublicEvent,
} from "./verified-public-event"

/** Foreground exact confirmation only; general preference discovery stays anonymous. */
export async function readExactAccountNetworkPreference(input: {
  signedEvent: SignedPublicNostrEvent
  relayUrl: string
  authenticatedPubkey: string | null
  options: PublicRelayReadOptions
  admitRelay: () => Promise<boolean>
  fetchEvents?: typeof fetchSignedEventsFanoutDetailed
  executor?: CommerceRelayExecutor
  authTimeoutMs?: number
}): Promise<NetworkPreferenceReadbackObservation["status"]> {
  const { signedEvent, options, relayUrl } = input
  if (
    ![10002, 10050].includes(signedEvent.kind) ||
    options.accountPubkey !== signedEvent.pubkey ||
    options.relayUrls?.length !== 1 ||
    options.relayUrls[0] !== relayUrl
  )
    throw new Error("Network confirmation requires an exact owner preference")
  const authorization =
    input.authenticatedPubkey === signedEvent.pubkey
      ? getProtectedReadAuthorization(signedEvent.pubkey)
      : null
  const assertCurrent = () => {
    if (
      options.shouldContinue?.() === false ||
      (authorization && !hasProtectedReadAuthority(authorization))
    ) {
      throw new NostrSignerError("authority_changed")
    }
  }
  assertCurrent()
  const filter = {
    ids: [signedEvent.id],
    kinds: [signedEvent.kind],
    authors: [signedEvent.pubkey],
    limit: 1,
  }
  const anonymous = await (
    input.fetchEvents ?? fetchSignedEventsFanoutDetailed
  )(filter, options)
  assertCurrent()
  const status = classifyAccountNetworkReadback({
    relayUrl,
    signedEvent,
    result: anonymous,
  })
  if (status !== "auth_required" || !authorization) return status
  if (!(await input.admitRelay())) return "policy_blocked"
  assertCurrent()
  const result = await (input.executor ?? commerceRelayExecutor).query(
    {
      operation: "account_network_preference_read",
      relayUrls: [relayUrl],
      filters: [filter],
    },
    {
      authorization,
      signal: options.signal,
      admitRelay: async (url) => {
        assertCurrent()
        const admitted = url === relayUrl && (await input.admitRelay())
        assertCurrent()
        return admitted
      },
      connectTimeoutMs: options.connectTimeoutMs ?? 4000,
      queryTimeoutMs: options.fetchTimeoutMs ?? 6000,
      authTimeoutMs: input.authTimeoutMs,
      maxAuthAttempts: 1,
      maxEventsPerRelay: 1,
    }
  )
  assertCurrent()
  if (!(await input.admitRelay())) return "policy_blocked"
  assertCurrent()
  for (const raw of result.events) {
    const admitted = await admitPublicEvent(raw)
    assertCurrent()
    if (
      admitted.status === "verified" &&
      sameSignedPublicEvent(admitted.event, signedEvent)
    ) {
      if (!(await input.admitRelay())) return "policy_blocked"
      assertCurrent()
      return "observed"
    }
    if (admitted.status === "unavailable") return "verification_unavailable"
  }
  const source = result.relays[0]
  if (source?.failure === "authority_changed")
    throw new NostrSignerError("authority_changed")
  if (
    result.status === "aborted" ||
    source?.failure === "aborted" ||
    source?.failure === "signer_authorization_denied"
  )
    return "cancelled"
  if (
    source?.failure === "authentication_rejected" ||
    source?.failure === "subscription_rejected"
  )
    return "auth_rejected"
  if (
    source?.failure === "authentication_timed_out" ||
    source?.failure === "query_timed_out" ||
    result.observations.some((observation) => observation.type === "timeout")
  )
    return "timed_out"
  if (
    source?.failure === "authentication_required" ||
    source?.failure === "missing_challenge"
  )
    return "auth_required"
  return result.status === "success" &&
    source?.status === "success" &&
    source.malformedCount === 0 &&
    source.unusableCount === 0
    ? "absent"
    : "unavailable"
}
