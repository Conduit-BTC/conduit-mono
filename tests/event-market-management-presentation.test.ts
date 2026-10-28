import { describe, expect, it } from "bun:test"
import {
  getPendingEventMerchantRequests,
  getEventParticipationStatus,
  canInviteEventMerchant,
  getEventMerchantAdmissionHint,
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

describe("organizer admission guidance", () => {
  const ready = {
    pending: false,
    decisionPending: false,
    checking: false,
    failed: false,
    canChange: true,
    assignment: "Booth 4",
  }

  it("explains assignment and blocked admission without weakening signed authority", () => {
    expect(getEventMerchantAdmissionHint(ready)).toBeUndefined()
    expect(
      getEventMerchantAdmissionHint({ ...ready, assignment: " " })
    ).toContain("Add a public booth or pickup assignment")
    expect(getEventMerchantAdmissionHint({ ...ready, pending: true })).toBe(
      "Updating merchant authorization…"
    )
    expect(
      getEventMerchantAdmissionHint({ ...ready, decisionPending: true })
    ).toContain("saved merchant decision needs delivery")
    expect(
      getEventMerchantAdmissionHint({ ...ready, checking: true })
    ).toContain("Checking current merchant authorization")
    expect(getEventMerchantAdmissionHint({ ...ready, failed: true })).toContain(
      "could not be checked"
    )
    expect(
      getEventMerchantAdmissionHint({ ...ready, canChange: false })
    ).toContain("signed authorization must be verified")
    expect(
      getEventMerchantAdmissionHint({
        ...ready,
        assignment: "",
        canChange: false,
      })
    ).toContain("signed authorization must be verified")
  })

  it("offers private invitations only before a request or approval, never to the organizer", () => {
    const candidate = {
      hasRosterRow: false,
      hasApproval: false,
      isOrganizer: false,
    }
    expect(canInviteEventMerchant(candidate)).toBe(true)
    expect(
      canInviteEventMerchant({ ...candidate, enrollmentStatus: "invited" })
    ).toBe(true)
    expect(
      canInviteEventMerchant({ ...candidate, enrollmentStatus: "requested" })
    ).toBe(false)
    expect(canInviteEventMerchant({ ...candidate, hasRosterRow: true })).toBe(
      false
    )
    expect(canInviteEventMerchant({ ...candidate, hasApproval: true })).toBe(
      false
    )
    expect(canInviteEventMerchant({ ...candidate, isOrganizer: true })).toBe(
      false
    )
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
