import type { EventMarketOrganizerFeeTerms } from "@conduit/core"
import {
  getEventActorIdentityView,
  type EventActorIdentityView,
} from "../lib/event-actor-identity"
import { EventActorName } from "./EventActorIdentity"

/** Presentation only; signed fee admission and amount calculation stay shared. */
export function CheckoutEventOrganizerFeeDisclosure({
  terms,
  organizerIdentity,
}: {
  terms: Extract<EventMarketOrganizerFeeTerms, { state: "active" }>
  organizerIdentity: EventActorIdentityView | null
}) {
  return (
    <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
      Event organizer fee paid to{" "}
      <EventActorName
        identity={
          organizerIdentity ??
          getEventActorIdentityView({ pubkey: terms.organizerPubkey })
        }
      />
      : {terms.basisPoints / 100}% of items and shipping
      {terms.minimumSats > 0
        ? `, minimum ${terms.minimumSats.toLocaleString()} sats`
        : ""}
      .
    </p>
  )
}
