import { parseProductEvent } from "../../packages/core/src/protocol/products"
import { parseProfileEvent } from "../../packages/core/src/protocol/profiles"
import { parseEventMarketCalendarEvent } from "../../packages/core/src/protocol/event-market"
import { parseEventMarketSeriesEvent } from "../../packages/core/src/protocol/event-market-schedule"
import { parseEventMarketRosterEvent } from "../../packages/core/src/protocol/event-market-roster"
import { parseEventMarketAuthorizationEvent } from "../../packages/core/src/protocol/event-market-authorization"
import { parseRelayListEvent } from "../../packages/core/src/protocol/relay-list"
import { parseShippingOptionEvent } from "../../packages/core/src/protocol/shipping"
import type { SignedPublicNostrEvent } from "../../packages/core/src/protocol/signed-event"
import type { VerifiedNostrEvent } from "../../packages/core/src/protocol/verified-public-event"
import type {
  FollowListAuthorRead,
  FollowListReadResult,
  RetainedOwnFollowListSnapshot,
} from "../../packages/core/src/protocol/follows"

declare const raw: SignedPublicNostrEvent
declare const trusted: VerifiedNostrEvent
declare const followRead: FollowListReadResult
declare const retainedFollow: RetainedOwnFollowListSnapshot

// Admitted read results preserve proof through the entire in-memory handoff.
const followEvent: VerifiedNostrEvent = followRead.events[0]
const retainedEvent: VerifiedNostrEvent = retainedFollow.event
void followEvent
void retainedEvent
// @ts-expect-error A restored owner snapshot cannot expose a raw signed copy.
const rawFollow: RetainedOwnFollowListSnapshot["event"] = raw
void rawFollow
// @ts-expect-error A public author read cannot lose proof when metadata is merged.
const rawAuthorFollow: FollowListAuthorRead["event"] = raw
void rawAuthorFollow

// @ts-expect-error Raw signed fields cannot construct an admitted event.
const forged: VerifiedNostrEvent = raw
void forged
// @ts-expect-error The signed envelope is immutable.
trusted.content = "changed"
// @ts-expect-error The tag collection is immutable.
trusted.tags.push(["changed"])
// @ts-expect-error Individual tags are immutable.
trusted.tags[0][0] = "changed"

// @ts-expect-error Public product parsing requires admission.
parseProductEvent(raw)
// @ts-expect-error Public profile parsing requires admission.
parseProfileEvent(raw)
// @ts-expect-error Public calendar parsing requires admission.
parseEventMarketCalendarEvent(raw)
// @ts-expect-error Public series parsing requires admission.
parseEventMarketSeriesEvent(raw)
// @ts-expect-error Public roster parsing requires admission.
parseEventMarketRosterEvent(raw)
// @ts-expect-error Public authorization parsing requires admission.
parseEventMarketAuthorizationEvent(raw)
// @ts-expect-error Public relay-list parsing requires admission.
parseRelayListEvent(raw)
// @ts-expect-error Public shipping parsing requires admission.
parseShippingOptionEvent(raw)

parseProductEvent(trusted)
parseProfileEvent(trusted)
parseEventMarketCalendarEvent(trusted)
parseEventMarketSeriesEvent(trusted)
parseEventMarketRosterEvent(trusted)
parseEventMarketAuthorizationEvent(trusted)
parseRelayListEvent(trusted)
parseShippingOptionEvent(trusted)
