import { describe, expect, it } from "bun:test"
import {
  getPendingEventMerchantRequests,
  getEventParticipationStatus,
} from "../apps/merchant/src/lib/event-market-enrollment-presentation"

describe("event organizer request presentation", () => {
  it("surfaces observed requests ahead of existing merchants without treating invitations as approval", () => {
    expect(
      getPendingEventMerchantRequests(
        [{ pubkey: "approved" }],
        [
          { merchantPubkey: "approved", status: "requested" },
          { merchantPubkey: "new-seller", status: "requested" },
          { merchantPubkey: "invited", status: "invited" },
          { merchantPubkey: "withdrawn", status: "withdrawn" },
          { merchantPubkey: "declined", status: "declined" },
        ]
      )
    ).toEqual(["new-seller"])
    expect(getPendingEventMerchantRequests([], undefined)).toEqual([])
  })
})

describe("merchant participation status", () => {
  it("distinguishes sending, saved delivery, requested and signed approval", () => {
    const initial = {
      approved: false,
      revoked: false,
      busy: false,
      pendingDelivery: false,
    }
    expect(getEventParticipationStatus(initial)).toBe("Join this event")
    expect(getEventParticipationStatus({ ...initial, busy: true })).toBe(
      "Sending participation…"
    )
    expect(
      getEventParticipationStatus({ ...initial, pendingDelivery: true })
    ).toBe("Participation saved; delivery needs retry.")
    expect(
      getEventParticipationStatus({ ...initial, enrollmentStatus: "requested" })
    ).toBe("Request pending")
    expect(
      getEventParticipationStatus({ ...initial, enrollmentStatus: "invited" })
    ).toBe("Invited to join")
    expect(
      getEventParticipationStatus({
        ...initial,
        approved: true,
        enrollmentStatus: "requested",
      })
    ).toBe("Approved to sell")
    expect(getEventParticipationStatus({ ...initial, revoked: true })).toBe(
      "Approval revoked"
    )
  })
})
