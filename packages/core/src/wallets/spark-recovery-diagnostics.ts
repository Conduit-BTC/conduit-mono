import {
  accountRegistryReadiness,
  hasFreshReadback,
  recoveryReadiness,
  type SparkRecoveryRecord,
  type SparkRecoveryWriteStatus,
} from "./spark-recovery-service"

export type RecoveryDeliveryIssue =
  | "missing_local_record"
  | "awaiting_publish"
  | "auth_required"
  | "rejected"
  | "timed_out"
  | "policy_blocked"
  | "cancelled"
  | "publish_error"
  | "read_not_queried"
  | "read_absent"
  | "read_unavailable"
  | "readback_stale"
  | "insufficient_copies"

/** Content-free, local-only explanation of the existing delivery policy. */
export interface RecoveryDeliveryDiagnosis {
  ready: boolean
  confirmedTargets: number
  targetCount: number
  independentCopies: number
  issues: RecoveryDeliveryIssue[]
}

const publishIssue: Partial<
  Record<SparkRecoveryWriteStatus | "pending", RecoveryDeliveryIssue>
> = {
  pending: "awaiting_publish",
  auth_required: "auth_required",
  rejected: "rejected",
  timed_out: "timed_out",
  policy_blocked: "policy_blocked",
  cancelled: "cancelled",
  error: "publish_error",
}

export function diagnoseRecoveryDelivery(
  record: SparkRecoveryRecord | undefined,
  policy: "independent" | "all_targets" = "independent"
): RecoveryDeliveryDiagnosis {
  if (!record)
    return {
      ready: false,
      confirmedTargets: 0,
      targetCount: 0,
      independentCopies: 0,
      issues: ["missing_local_record"],
    }

  const readiness =
    policy === "all_targets"
      ? accountRegistryReadiness(record)
      : recoveryReadiness(record)
  const issues = new Set<RecoveryDeliveryIssue>()
  let confirmedTargets = 0
  for (const target of record.targets) {
    const evidence = record.delivery.find((item) => item.url === target.url)
    if (hasFreshReadback(evidence)) {
      confirmedTargets++
      continue
    }
    if (!evidence?.accepted) {
      issues.add(
        publishIssue[evidence?.status ?? "pending"] ?? "awaiting_publish"
      )
      continue
    }
    if (evidence.lastRead === "not_queried") issues.add("read_not_queried")
    else if (evidence.lastRead === "absent") issues.add("read_absent")
    else if (evidence.lastRead === "unavailable") issues.add("read_unavailable")
    else issues.add(evidence.readBack ? "readback_stale" : "read_not_queried")
  }
  if (!readiness.ready) issues.add("insufficient_copies")
  return {
    ready: readiness.ready,
    confirmedTargets,
    targetCount: record.targets.length,
    independentCopies: readiness.independentCopies,
    issues: readiness.ready ? [] : [...issues],
  }
}
