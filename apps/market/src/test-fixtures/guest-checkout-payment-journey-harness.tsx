import { useState } from "react"
import { createRoot } from "react-dom/client"

import { Button } from "@conduit/ui"

import {
  GuestCheckoutPaymentJourneyPrototype,
  type GuestCheckoutJourneyState,
  type GuestCheckoutMerchantObligation,
  type GuestCheckoutPaymentJourneyPrototypeProps,
} from "../components/GuestCheckoutPaymentJourneyPrototype"

export const guestCheckoutJourneyStates = [
  "authorization",
  "approved",
  "funded",
  "remaining_leg",
  "recovery_needed",
  "settlement",
  "retired",
] as const satisfies readonly GuestCheckoutJourneyState[]

const STATE_LABELS: Record<GuestCheckoutJourneyState, string> = {
  authorization: "Review purchase plan",
  approved: "Approved, not funded",
  funded: "Funding received",
  remaining_leg: "One payment left",
  recovery_needed: "Recovery needed",
  settlement: "Final settlement",
  retired: "Retired",
}

const BASE_OBLIGATIONS = [
  {
    id: "merchant-one",
    merchantLabel: "Olive Grove Supply",
    purposeLabel: "Event basket items",
    recipientRoleLabel: "Merchant commerce recipient",
    recipientIdentityLabel: "fixture-recipient:olive-grove-v1",
    amountLabel: "640 sats",
  },
  {
    id: "merchant-two",
    merchantLabel: "North Loop Roasters",
    purposeLabel: "Event pickup order",
    recipientRoleLabel: "Merchant commerce recipient",
    recipientIdentityLabel: "fixture-recipient:north-loop-v1",
    amountLabel: "360 sats",
  },
] as const

function buildObligations(
  state: GuestCheckoutJourneyState
): GuestCheckoutMerchantObligation[] {
  if (state === "settlement" || state === "retired") {
    return BASE_OBLIGATIONS.map((obligation) => ({
      ...obligation,
      status: "complete" as const,
    }))
  }

  if (state === "remaining_leg") {
    return [
      { ...BASE_OBLIGATIONS[0], status: "complete" },
      { ...BASE_OBLIGATIONS[1], status: "waiting" },
    ]
  }

  if (state === "recovery_needed") {
    return [
      { ...BASE_OBLIGATIONS[0], status: "complete" },
      { ...BASE_OBLIGATIONS[1], status: "recovery_needed" },
    ]
  }

  return BASE_OBLIGATIONS.map((obligation) => ({
    ...obligation,
    status: "waiting" as const,
  }))
}

export function createGuestCheckoutPaymentJourneyFixture(
  state: GuestCheckoutJourneyState
): GuestCheckoutPaymentJourneyPrototypeProps {
  const funded = state !== "authorization" && state !== "approved"
  const remainingBalanceByState: Record<GuestCheckoutJourneyState, string> = {
    authorization: "0 sats",
    approved: "0 sats",
    funded: "1,150 sats",
    remaining_leg: "510 sats",
    recovery_needed: "510 sats",
    settlement: "150 sats",
    retired: "0 sats",
  }

  return {
    state,
    purchaseLabel: "Two merchant payments from one guest funding invoice",
    commerceTotalLabel: "1,000 sats",
    feeLabel: "100 sats",
    routingAllowanceLabel: "30 sats",
    maximumExtraCompensationLabel: "20 sats",
    maximumDebitLabel: "1,150 sats",
    syntheticRoutingCostLabel: "30 sats (example)",
    syntheticResidualCompensationLabel: "20 sats (example)",
    conduitRecipientIdentityLabel: "fixture-recipient:conduit-fee-v1",
    fundingReceivedLabel: funded ? "1,150 sats" : "Not funded",
    remainingBalanceLabel: remainingBalanceByState[state],
    merchantObligations: buildObligations(state),
    retirementEvidence: {
      sendsLabel: "Resolved (fixture)",
      receivesLabel: "Resolved (fixture)",
      claimsLabel: "Resolved (fixture)",
      refundsLabel: "None pending (fixture)",
      availableBalanceLabel: "0 sats (fixture)",
      ownedBalanceLabel: "0 sats (fixture)",
      incomingBalanceLabel: "0 sats (fixture)",
    },
  }
}

function GuestCheckoutPaymentJourneyHarness({
  initialState,
}: {
  initialState: GuestCheckoutJourneyState
}) {
  const [state, setState] = useState<GuestCheckoutJourneyState>(initialState)

  return (
    <main
      data-testid="guest-checkout-payment-journey-harness"
      className="min-h-[100dvh] bg-[var(--background)] px-4 py-8 sm:px-6"
    >
      <div className="mx-auto mb-4 flex w-full max-w-5xl flex-wrap gap-2">
        {guestCheckoutJourneyStates.map((candidate) => (
          <Button
            key={candidate}
            aria-pressed={candidate === state}
            onClick={() => setState(candidate)}
            size="sm"
            type="button"
            variant={candidate === state ? "primary" : "outline"}
          >
            {STATE_LABELS[candidate]}
          </Button>
        ))}
      </div>
      <output
        data-testid="guest-checkout-payment-journey-harness-state"
        className="sr-only"
      >
        {state}
      </output>
      <GuestCheckoutPaymentJourneyPrototype
        {...createGuestCheckoutPaymentJourneyFixture(state)}
      />
    </main>
  )
}

export function mountGuestCheckoutPaymentJourneyHarness(
  container: HTMLElement,
  initialState: GuestCheckoutJourneyState = "authorization"
): () => void {
  const root = createRoot(container)
  root.render(
    <GuestCheckoutPaymentJourneyHarness initialState={initialState} />
  )
  return () => root.unmount()
}
