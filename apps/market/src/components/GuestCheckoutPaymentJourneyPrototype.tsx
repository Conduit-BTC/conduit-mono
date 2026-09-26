import {
  ArchiveRestore,
  Download,
  LockKeyhole,
  ReceiptText,
  ShieldCheck,
  WalletCards,
} from "lucide-react"

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  StatusPill,
  StatusStepper,
  type StatusStepperRow,
} from "@conduit/ui"

export type GuestCheckoutJourneyState =
  | "authorization"
  | "approved"
  | "funded"
  | "remaining_leg"
  | "recovery_needed"
  | "settlement"
  | "retired"

export type GuestCheckoutObligationStatus =
  "waiting" | "complete" | "recovery_needed"

export interface GuestCheckoutMerchantObligation {
  id: string
  merchantLabel: string
  purposeLabel: string
  recipientRoleLabel: string
  recipientIdentityLabel: string
  amountLabel: string
  status: GuestCheckoutObligationStatus
}

export interface GuestCheckoutRetirementEvidence {
  sendsLabel: string
  receivesLabel: string
  claimsLabel: string
  refundsLabel: string
  availableBalanceLabel: string
  ownedBalanceLabel: string
  incomingBalanceLabel: string
}

export interface GuestCheckoutPaymentJourneyPrototypeProps {
  state: GuestCheckoutJourneyState
  purchaseLabel: string
  commerceTotalLabel: string
  feeLabel: string
  routingAllowanceLabel: string
  maximumExtraCompensationLabel: string
  maximumDebitLabel: string
  syntheticRoutingCostLabel: string
  syntheticResidualCompensationLabel: string
  conduitRecipientIdentityLabel: string
  fundingReceivedLabel: string
  remainingBalanceLabel: string
  merchantObligations: readonly GuestCheckoutMerchantObligation[]
  retirementEvidence: GuestCheckoutRetirementEvidence
}

type JourneyStateMeta = {
  title: string
  description: string
  pill: string
  pillVariant: "neutral" | "info" | "warning" | "success"
}

const STATE_META: Record<GuestCheckoutJourneyState, JourneyStateMeta> = {
  authorization: {
    title: "Review this guest purchase",
    description:
      "Nothing is authorized or funded yet. Review one invoice for only the purchase shown here.",
    pill: "Ready to review",
    pillVariant: "neutral",
  },
  approved: {
    title: "Purchase approved",
    description:
      "The exact purchase authorization is frozen. The funding invoice has not been paid.",
    pill: "Approved",
    pillVariant: "info",
  },
  funded: {
    title: "Funding received",
    description:
      "The purchase wallet is funded. Merchant payments are tracked separately.",
    pill: "Funded",
    pillVariant: "info",
  },
  remaining_leg: {
    title: "One payment remains",
    description:
      "Completed merchant payments stay complete. Remaining merchant obligations stay ahead of later fee and residual settlement.",
    pill: "Payment remaining",
    pillVariant: "warning",
  },
  recovery_needed: {
    title: "Recovery is needed",
    description:
      "The same frozen purchase and attempt history must be restored before continuing.",
    pill: "Recovery needed",
    pillVariant: "warning",
  },
  settlement: {
    title: "Merchant payments complete",
    description:
      "Required commerce is complete. The fixture now demonstrates final fee and residual settlement before retirement.",
    pill: "Settlement example",
    pillVariant: "info",
  },
  retired: {
    title: "Guest purchase complete",
    description:
      "Every obligation is resolved and active purchase-wallet spending material is retired.",
    pill: "Retired",
    pillVariant: "success",
  },
}

function getMerchantCompletionSummary(
  obligations: readonly GuestCheckoutMerchantObligation[]
): string {
  const completeCount = obligations.filter(
    (obligation) => obligation.status === "complete"
  ).length
  return `${completeCount} of ${obligations.length} merchant payments complete`
}

function getJourneyRows(state: GuestCheckoutJourneyState): StatusStepperRow[] {
  const authorizationComplete = state !== "authorization"
  const fundingComplete = state !== "authorization" && state !== "approved"
  const merchantsComplete = state === "settlement" || state === "retired"
  const merchantsNeedRecovery =
    state === "remaining_leg" || state === "recovery_needed"
  const settlementComplete = state === "retired"
  const settlementInProgress = state === "settlement"

  return [
    {
      key: "authorization",
      title: authorizationComplete
        ? "Purchase authorization frozen"
        : "Purchase plan ready for approval",
      subtitle: authorizationComplete
        ? "Recipients, amounts, routing allowance, and maximum debit cannot drift."
        : "Nothing is authorized or funded until the shopper approves this exact plan.",
      status: authorizationComplete ? "complete" : "in_progress",
      label: authorizationComplete ? "Approved" : "Reviewing",
    },
    {
      key: "funding",
      title: fundingComplete ? "Guest funding received" : "Guest funding",
      subtitle: "Funding is distinct from completing each merchant payment.",
      status: fundingComplete ? "complete" : "waiting",
      label: fundingComplete ? "Received" : "Not funded",
    },
    {
      key: "merchants",
      title: "Merchant obligations completed",
      subtitle:
        "A completed payment is not repeated when another payment needs attention.",
      status: merchantsComplete
        ? "complete"
        : merchantsNeedRecovery
          ? "retry_needed"
          : fundingComplete
            ? "in_progress"
            : "waiting",
      label: merchantsComplete
        ? "Complete"
        : state === "recovery_needed"
          ? "Recover first"
          : state === "remaining_leg"
            ? "One remaining"
            : fundingComplete
              ? "In progress"
              : "Waiting",
    },
    {
      key: "settlement",
      title: "Final fee and residual settlement",
      subtitle: "This step waits until required merchant commerce is complete.",
      status: settlementComplete
        ? "complete"
        : settlementInProgress
          ? "in_progress"
          : "waiting",
      label: settlementComplete
        ? "Complete"
        : settlementInProgress
          ? "Illustrative"
          : "Waiting",
    },
    {
      key: "retirement",
      title: "Purchase wallet retired",
      subtitle:
        "Retirement waits for resolved sends, receives, claims, refunds, and balance.",
      status: state === "retired" ? "complete" : "waiting",
      label: state === "retired" ? "Retired" : "Not ready",
    },
  ]
}

function obligationStatusLabel(status: GuestCheckoutObligationStatus): string {
  switch (status) {
    case "complete":
      return "Paid"
    case "recovery_needed":
      return "Recovery needed"
    case "waiting":
    default:
      return "Waiting"
  }
}

function obligationStatusVariant(
  status: GuestCheckoutObligationStatus
): "neutral" | "warning" | "success" {
  switch (status) {
    case "complete":
      return "success"
    case "recovery_needed":
      return "warning"
    case "waiting":
    default:
      return "neutral"
  }
}

/**
 * Fixture-only review surface for the guest checkout payment journey.
 *
 * This component accepts display-ready sample data. It performs no arithmetic,
 * persistence, wallet operations, checkout wiring, or network work.
 */
export function GuestCheckoutPaymentJourneyPrototype({
  state,
  purchaseLabel,
  commerceTotalLabel,
  feeLabel,
  routingAllowanceLabel,
  maximumExtraCompensationLabel,
  maximumDebitLabel,
  syntheticRoutingCostLabel,
  syntheticResidualCompensationLabel,
  conduitRecipientIdentityLabel,
  fundingReceivedLabel,
  remainingBalanceLabel,
  merchantObligations,
  retirementEvidence,
}: GuestCheckoutPaymentJourneyPrototypeProps) {
  const meta = STATE_META[state]
  const rows = getJourneyRows(state)
  const showRecoveryProposal = state === "authorization" || state === "approved"
  const authorizationComplete = state !== "authorization"
  const showFinalSettlement = state === "settlement" || state === "retired"

  return (
    <section
      aria-labelledby="guest-payment-journey-title"
      data-journey-state={state}
      data-testid="guest-checkout-payment-journey"
      className="mx-auto w-full max-w-5xl space-y-4 text-[var(--text-primary)]"
    >
      <Card className="overflow-hidden">
        <CardHeader className="gap-4 border-b border-[var(--border)] bg-[var(--surface-elevated)] sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
              <ShieldCheck aria-hidden="true" className="h-4 w-4" />
              Review prototype with sample data
            </div>
            <CardTitle
              id="guest-payment-journey-title"
              className="text-2xl leading-tight"
            >
              {meta.title}
            </CardTitle>
            <CardDescription className="max-w-2xl leading-6">
              {meta.description}
            </CardDescription>
          </div>
          <StatusPill variant={meta.pillVariant}>{meta.pill}</StatusPill>
        </CardHeader>

        <CardContent className="space-y-6 pt-6">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
            <section
              aria-labelledby="purchase-authorization-heading"
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 sm:p-5"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--primary-500)_14%,transparent)] text-primary-500">
                  <LockKeyhole aria-hidden="true" className="h-5 w-5" />
                </span>
                <div>
                  <h3
                    id="purchase-authorization-heading"
                    className="font-semibold"
                  >
                    {authorizationComplete
                      ? "Frozen purchase authorization"
                      : "Purchase plan for approval"}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                    {authorizationComplete
                      ? `${purchaseLabel}. This exact plan is approved. Any recipient change or higher maximum requires a new approval.`
                      : `${purchaseLabel}. Approval would freeze these recipients and amounts. No payment is authorized yet.`}
                  </p>
                </div>
              </div>

              <dl
                aria-label="Sample authorization amounts"
                className="mt-5 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2"
              >
                <div>
                  <dt className="text-[var(--text-muted)]">Commerce total</dt>
                  <dd className="mt-1 font-medium">{commerceTotalLabel}</dd>
                </div>
                <div>
                  <dt className="text-[var(--text-muted)]">Conduit fee</dt>
                  <dd className="mt-1 font-medium">{feeLabel}</dd>
                </div>
                <div>
                  <dt className="text-[var(--text-muted)]">
                    Routing allowance
                  </dt>
                  <dd className="mt-1 font-medium">{routingAllowanceLabel}</dd>
                </div>
                <div>
                  <dt className="text-[var(--text-muted)]">
                    Maximum extra compensation
                  </dt>
                  <dd className="mt-1 font-medium">
                    {maximumExtraCompensationLabel}
                  </dd>
                </div>
                <div className="rounded-lg border border-primary-500/50 bg-[color-mix(in_srgb,var(--primary-500)_9%,transparent)] p-3 sm:col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                    Maximum debit
                  </dt>
                  <dd className="mt-1 text-xl font-semibold text-primary-500">
                    {maximumDebitLabel}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs leading-5 text-[var(--text-muted)]">
                These values are preformatted fixture copy. This prototype does
                not calculate fees, reserves, or compensation.
              </p>

              <div className="mt-4 rounded-lg border border-dashed border-[var(--border)] p-3">
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                  {authorizationComplete
                    ? "Frozen recipient plan (fixture)"
                    : "Recipient plan for review (fixture)"}
                </p>
                <ul
                  aria-label="Synthetic purchase recipient authorities"
                  className="mt-3 space-y-3 text-sm"
                >
                  {merchantObligations.map((obligation) => (
                    <li key={`recipient-${obligation.id}`}>
                      <span className="block text-[var(--text-muted)]">
                        {obligation.recipientRoleLabel}
                      </span>
                      <span className="mt-1 block break-all font-mono text-xs font-medium">
                        {obligation.recipientIdentityLabel}
                      </span>
                    </li>
                  ))}
                  <li>
                    <span className="block text-[var(--text-muted)]">
                      Conduit fee recipient
                    </span>
                    <span className="mt-1 block break-all font-mono text-xs font-medium">
                      {conduitRecipientIdentityLabel}
                    </span>
                  </li>
                </ul>
                <p className="mt-3 text-xs leading-5 text-[var(--text-muted)]">
                  Synthetic reviewer-readable authorities only. Production must
                  bind and verify exact recipient keys before approval.
                </p>
              </div>

              {showFinalSettlement && (
                <div
                  aria-label="Synthetic final settlement outcome"
                  className="mt-4 rounded-lg border border-dashed border-[var(--border)] p-3"
                >
                  <p className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                    Synthetic final settlement
                  </p>
                  <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-[var(--text-muted)]">
                        Synthetic Conduit fee
                      </dt>
                      <dd className="mt-1 font-medium">{feeLabel}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--text-muted)]">
                        Synthetic routing-cost example
                      </dt>
                      <dd className="mt-1 font-medium">
                        {syntheticRoutingCostLabel}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[var(--text-muted)]">
                        Synthetic residual-compensation example
                      </dt>
                      <dd className="mt-1 font-medium">
                        {syntheticResidualCompensationLabel}
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs leading-5 text-[var(--text-muted)]">
                    Illustrative, preformatted fixture values only. The real
                    final amount depends on actual routing and a
                    still-unapproved residual policy; this outcome is not
                    calculated, authorized, quoted, or promised.
                  </p>
                </div>
              )}
            </section>

            <section
              aria-labelledby="journey-progress-heading"
              className="rounded-xl border border-[var(--border)] p-4 sm:p-5"
            >
              <h3 id="journey-progress-heading" className="font-semibold">
                Purchase progress
              </h3>
              <StatusStepper
                ariaLabel="Guest purchase payment progress"
                className="mt-5"
                rows={rows}
              />
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section
              aria-labelledby="funding-heading"
              className="rounded-xl border border-[var(--border)] p-4 sm:p-5"
            >
              <div className="flex items-start gap-3">
                <WalletCards
                  aria-hidden="true"
                  className="mt-0.5 h-5 w-5 shrink-0 text-secondary-500"
                />
                <div className="min-w-0 flex-1">
                  <h3 id="funding-heading" className="font-semibold">
                    Funding and obligations
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                    Funding the invoice does not by itself mean every merchant
                    has been paid.
                  </p>
                </div>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-[var(--surface-elevated)] p-3">
                  <dt className="text-xs text-[var(--text-muted)]">
                    Funding received
                  </dt>
                  <dd className="mt-1 font-semibold">{fundingReceivedLabel}</dd>
                </div>
                <div className="rounded-lg bg-[var(--surface-elevated)] p-3">
                  <dt className="text-xs text-[var(--text-muted)]">
                    Purchase wallet balance
                  </dt>
                  <dd className="mt-1 font-semibold">
                    {remainingBalanceLabel}
                  </dd>
                </div>
              </dl>

              <p
                data-testid="merchant-completion-summary"
                className="mt-4 text-sm font-medium"
              >
                {getMerchantCompletionSummary(merchantObligations)}
              </p>
              <ul className="mt-2 space-y-2" aria-label="Merchant obligations">
                {merchantObligations.map((obligation) => (
                  <li
                    key={obligation.id}
                    className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{obligation.merchantLabel}</p>
                      <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                        {obligation.purposeLabel}
                      </p>
                      <p className="mt-2 text-xs text-[var(--text-muted)]">
                        {obligation.recipientRoleLabel}
                      </p>
                      <p className="mt-1 break-all font-mono text-xs font-medium">
                        {obligation.recipientIdentityLabel}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-3 sm:justify-end">
                      <span className="text-sm font-semibold">
                        {obligation.amountLabel}
                      </span>
                      <StatusPill
                        variant={obligationStatusVariant(obligation.status)}
                      >
                        {obligationStatusLabel(obligation.status)}
                      </StatusPill>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {state === "retired" ? (
              <section
                aria-labelledby="retirement-heading"
                className="rounded-xl border border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_7%,var(--surface))] p-4 sm:p-5"
              >
                <div className="flex items-start gap-3">
                  <ArchiveRestore
                    aria-hidden="true"
                    className="mt-0.5 h-5 w-5 shrink-0 text-[var(--success)]"
                  />
                  <div>
                    <StatusPill variant="success">
                      Retirement complete
                    </StatusPill>
                    <h3 id="retirement-heading" className="mt-4 font-semibold">
                      Purchase wallet retired
                    </h3>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                  This fixture represents retirement only after all sends,
                  receives, claims, refunds, and balances are conclusively
                  resolved. Production must collect fresh provider evidence
                  before removing active spending material.
                </p>
                <dl
                  aria-label="Synthetic retirement resolution evidence"
                  className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2"
                >
                  {[
                    ["Sends", retirementEvidence.sendsLabel],
                    ["Receives", retirementEvidence.receivesLabel],
                    ["Claims", retirementEvidence.claimsLabel],
                    ["Refunds", retirementEvidence.refundsLabel],
                    [
                      "Fresh available balance",
                      retirementEvidence.availableBalanceLabel,
                    ],
                    [
                      "Fresh owned balance",
                      retirementEvidence.ownedBalanceLabel,
                    ],
                    [
                      "Fresh incoming balance",
                      retirementEvidence.incomingBalanceLabel,
                    ],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="rounded-lg bg-[var(--surface-elevated)] p-3"
                    >
                      <dt className="text-xs text-[var(--text-muted)]">
                        {label}
                      </dt>
                      <dd className="mt-1 font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                  No routine wallet management is shown for this completed guest
                  purchase. If a future approved design saves a receipt, it must
                  remain shopper-owned.
                </p>
              </section>
            ) : showRecoveryProposal ? (
              <section
                aria-labelledby="recovery-receipt-heading"
                className="rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_7%,var(--surface))] p-4 sm:p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <ReceiptText
                    aria-hidden="true"
                    className="mt-0.5 h-5 w-5 shrink-0 text-[var(--warning)]"
                  />
                  <StatusPill variant="warning">Decision pending</StatusPill>
                </div>
                <h3
                  id="recovery-receipt-heading"
                  className="mt-4 font-semibold"
                >
                  Purchase recovery receipt
                </h3>
                <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                  Proposed before funding: save the purchase plan, attempt
                  identity, and portable recovery details without requiring a
                  Nostr account.
                </p>
                <Button
                  aria-describedby="recovery-proposal-note"
                  className="mt-5 w-full sm:w-auto"
                  disabled
                  type="button"
                  variant="outline"
                >
                  <Download aria-hidden="true" className="h-4 w-4" />
                  Save recovery receipt (proposed)
                </Button>
                <p
                  id="recovery-proposal-note"
                  className="mt-2 text-xs leading-5 text-[var(--text-muted)]"
                >
                  This action is intentionally inactive. Required saving and its
                  mobile friction still need product and security approval.
                </p>
              </section>
            ) : (
              <section
                aria-labelledby="prepared-recovery-heading"
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4 sm:p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <ReceiptText
                    aria-hidden="true"
                    className="mt-0.5 h-5 w-5 shrink-0 text-secondary-500"
                  />
                  <StatusPill variant="info">
                    Prepared before funding (fixture)
                  </StatusPill>
                </div>
                <h3
                  id="prepared-recovery-heading"
                  className="mt-4 font-semibold"
                >
                  Recovery state carried with this purchase
                </h3>
                <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
                  This illustrative state assumes the purchase plan, attempt
                  identity, and portable recovery details were prepared before
                  funding. No production recovery design is approved.
                </p>
                {state === "recovery_needed" && (
                  <div
                    role="alert"
                    className="mt-4 rounded-lg border border-[var(--warning)] bg-[var(--surface)] p-3 text-sm leading-6"
                  >
                    In this illustrative fixture, funds remain recoverable.
                    Automatic retry stays unavailable until this exact purchase
                    and its attempt history are restored.
                  </div>
                )}
                <p className="mt-4 text-xs leading-5 text-[var(--text-muted)]">
                  No recovery action is enabled in this prototype.
                </p>
              </section>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
