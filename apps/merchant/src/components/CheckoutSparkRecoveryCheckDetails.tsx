import { Fragment } from "react"
import type {
  CheckoutSparkRetirementObservation,
  MerchantCheckoutSparkReconciliationStatus,
} from "@conduit/core"

const retirementPhaseLabels: Record<
  CheckoutSparkRetirementObservation["phase"],
  string
> = {
  recovery_access: "Saved recovery access",
  prerequisites: "Saved payment prerequisites",
  wallet_open: "Provider wallet access",
  wallet_cleanup: "Provider session cleanup",
  settlement: "Exact payment proofs",
  scope: "Exact transfer scope",
  reader: "Provider reader access",
  native_evidence: "Terminal provider evidence",
  commit: "Saving cleanup confirmation",
  complete: "Cleanup confirmation",
}
const nativePhaseLabels: Record<
  NonNullable<CheckoutSparkRetirementObservation["native"]>["phase"],
  string
> = {
  input_validation: "Retirement prerequisites",
  history_first_read: "Initial transfer history",
  funds_read: "Terminal funds and pending transfers",
  history_second_read: "Stable transfer history",
  freshness: "Freshness of provider evidence",
  complete: "Complete provider evidence",
}
const retirementStatusLabels = {
  checking: "Checking",
  not_verified: "Not confirmed",
  unavailable: "Unavailable",
  verified: "Confirmed",
} as const
function recoveryOutcomeLabel(
  outcome: MerchantCheckoutSparkReconciliationStatus | undefined
) {
  if (outcome === "progress_pending") return "Saving final payment progress"
  if (outcome === "retirement_pending") return "Cleanup evidence pending"
  if (outcome === "unavailable") return "Check unavailable"
  if (outcome === "retired") return "Cleanup confirmed"
  if (outcome === undefined) return "No completed check in this session"
  return "Recovery evidence pending"
}

interface CheckoutSparkRecoveryCheckDetailsProps {
  outcome?: MerchantCheckoutSparkReconciliationStatus
  retirementObservation?: CheckoutSparkRetirementObservation
  lastCheckedAt?: number
  nowMs: number
  checking: boolean
  paused: boolean
  automaticProcessing: boolean
}

/** Read-only, session-local diagnostics; never payment or retirement authority. */
export function CheckoutSparkRecoveryCheckDetails({
  outcome,
  retirementObservation,
  lastCheckedAt,
  nowMs,
  checking,
  paused,
  automaticProcessing,
}: CheckoutSparkRecoveryCheckDetailsProps) {
  return (
    <details className="mt-3 text-sm text-[var(--text-secondary)]">
      <summary className="cursor-pointer rounded-sm py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
        Recovery check details
      </summary>
      <p className="mt-2 text-pretty">
        Payments are verified. Recovery stays saved until cleanup is
        independently confirmed. Do not pay again.
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt>Automatic cleanup</dt>
        <dd>{paused ? "Paused" : automaticProcessing ? "Enabled" : "Idle"}</dd>
        <dt>Current check</dt>
        <dd>{checking ? "Checking…" : recoveryOutcomeLabel(outcome)}</dd>
        <dt>Last completed check</dt>
        <dd>
          {lastCheckedAt === undefined
            ? "Not observed in this session"
            : nowMs - lastCheckedAt < 60_000
              ? "Within the last minute"
              : "More than a minute ago"}
        </dd>
        {retirementObservation && (
          <>
            <dt>Cleanup step</dt>
            <dd>
              {retirementPhaseLabels[retirementObservation.phase]} ·{" "}
              {retirementStatusLabels[retirementObservation.status]}
            </dd>
            {retirementObservation.native && (
              <>
                <dt>Provider check</dt>
                <dd>
                  {nativePhaseLabels[retirementObservation.native.phase]} ·{" "}
                  {retirementStatusLabels[retirementObservation.native.status]}
                </dd>
                {(
                  [
                    ["availableZero", "Zero available funds"],
                    ["ownedZero", "Zero owned funds"],
                    ["pendingEmpty", "No pending transfers"],
                  ] as const
                ).map(([field, label]) => {
                  const value = retirementObservation.native?.[field]
                  return value === undefined ? null : (
                    <Fragment key={field}>
                      <dt>{label}</dt>
                      <dd data-retirement-check={field}>
                        {value ? "Confirmed" : "Not confirmed"}
                      </dd>
                    </Fragment>
                  )
                })}
              </>
            )}
          </>
        )}
      </dl>
    </details>
  )
}
