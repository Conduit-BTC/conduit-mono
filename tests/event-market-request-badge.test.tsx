import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { generateSecretKey, getPublicKey } from "nostr-tools/pure"
import {
  buildDirectMessageRumor,
  parseDirectMessageRumor,
  type ParsedDirectMessage,
} from "@conduit/core/protocol/messaging"
import type { EventMarketEnrollmentPayload } from "@conduit/core/protocol/event-market-enrollment"
import {
  getEventRequestBadgeDescription,
  getObservedEventRequests,
  projectEventRequestBadge,
} from "../apps/merchant/src/lib/event-market-request-badge"
import { EventMarketRequestBadge } from "../apps/merchant/src/components/EventMarketRequestBadge"

const organizer = getPublicKey(generateSecretKey())
const merchant = getPublicKey(generateSecretKey())
const other = getPublicKey(generateSecretKey())
const coordinate = `30409:${organizer}:fair`

function message(
  action: EventMarketEnrollmentPayload["action"] = "request",
  createdAt = 100,
  marketCoordinate = coordinate,
  merchantPubkey = merchant
): ParsedDirectMessage {
  const merchantAction = action === "request" || action === "withdraw"
  const parsed = parseDirectMessageRumor(
    buildDirectMessageRumor({
      senderPubkey: merchantAction ? merchantPubkey : organizer,
      recipientPubkey: merchantAction ? organizer : merchantPubkey,
      content: `Event Market participation v1\n${JSON.stringify({
        version: 1,
        action,
        marketCoordinate,
        merchantPubkey,
        organizerPubkey: organizer,
        createdAt,
      })}`,
      createdAt,
      appId: "merchant",
    })
  )
  if (!parsed) throw new Error("Participation fixture did not parse.")
  return parsed
}

describe("observed Event request badge", () => {
  it("uses authenticated enrollment rules and deduplicates each market/merchant", () => {
    const request = message()
    const messages = [request, request, message("request", 101)]
    const requests = getObservedEventRequests(organizer, messages)
    expect(requests.size).toBe(1)
    expect(requests.get(coordinate)?.length).toBe(1)
    expect(getObservedEventRequests(other, messages).size).toBe(0)
    expect(getObservedEventRequests(null, messages).size).toBe(0)
    expect(
      getObservedEventRequests(organizer, [
        { ...request, transport: "nip04" },
        { ...request, senderPubkey: other },
        { ...request, createdAt: request.createdAt + 1 },
      ]).size
    ).toBe(0)
  })

  it("counts distinct event requests, not all private messages or past decisions", () => {
    const messages = [
      message(),
      message("request", 100, `30409:${organizer}:second`),
      message("request", 100, coordinate, other),
      { ...message(), content: "Unrelated private message" },
    ]
    const requests = getObservedEventRequests(organizer, messages)
    expect(requests.size).toBe(2)
    expect(
      projectEventRequestBadge(
        requests,
        new Map(
          [...requests.keys()].map((key) => [
            key,
            { state: "current", merchants: [] },
          ])
        )
      )
    ).toEqual({ pending: 3, unresolved: 0 })
    for (const action of ["withdraw", "decline", "invite"] as const) {
      expect(
        getObservedEventRequests(organizer, [message(), message(action, 101)])
          .size
      ).toBe(0)
    }
    expect(
      getObservedEventRequests(organizer, [message("withdraw", 99), message()])
        .size
    ).toBe(1)
  })

  it("removes admitted merchants but keeps unknown or failed event status distinct", () => {
    const requests = getObservedEventRequests(organizer, [message()])
    expect(projectEventRequestBadge(requests, new Map())).toEqual({
      pending: 0,
      unresolved: 1,
    })
    expect(
      projectEventRequestBadge(
        requests,
        new Map([[coordinate, { state: "unresolved" }]])
      )
    ).toEqual({ pending: 0, unresolved: 1 })
    expect(
      projectEventRequestBadge(
        requests,
        new Map([[coordinate, { state: "current", merchants: [merchant] }]])
      )
    ).toEqual({ pending: 0, unresolved: 0 })
    expect(
      projectEventRequestBadge(
        requests,
        new Map([[coordinate, { state: "current", merchants: [other] }]])
      )
    ).toEqual({ pending: 1, unresolved: 0 })
  })

  it("does not retain a previous account's requests in the next projection", () => {
    const previous = getObservedEventRequests(organizer, [message()])
    const rosters = new Map([
      [coordinate, { state: "current" as const, merchants: [] }],
    ])
    expect(projectEventRequestBadge(previous, rosters).pending).toBe(1)
    expect(
      projectEventRequestBadge(
        getObservedEventRequests(other, [message()]),
        rosters
      )
    ).toEqual({ pending: 0, unresolved: 0 })
  })

  it("keeps the parent Events name separate from an honest badge description", () => {
    expect(
      getEventRequestBadgeDescription({ pending: 0, unresolved: 0 })
    ).toBeNull()
    for (const [state, label, description] of [
      [
        { pending: 2, unresolved: 0 },
        "2",
        "2 observed pending merchant requests",
      ],
      [
        { pending: 2, unresolved: 1 },
        "2+",
        "Some event statuses are unavailable",
      ],
      [{ pending: 0, unresolved: 1 }, "!", "need an event-status check"],
      [{ pending: 102, unresolved: 0 }, "99+", "102 observed"],
    ] as const) {
      const html = renderToStaticMarkup(
        <a aria-label="Events" aria-describedby="requests">
          Events
          <EventMarketRequestBadge state={state} descriptionId="requests" />
        </a>
      )
      expect(html).toContain('aria-label="Events"')
      expect(html).toContain('aria-hidden="true"')
      expect(html).toContain('id="requests"')
      expect(html).toContain(`>${label}</div>`)
      expect(html).toContain(description)
      expect(html).not.toContain("Unread")
    }
    expect(
      renderToStaticMarkup(
        <EventMarketRequestBadge
          state={{ pending: 0, unresolved: 0 }}
          descriptionId="none"
        />
      )
    ).toBe("")
  })
})
