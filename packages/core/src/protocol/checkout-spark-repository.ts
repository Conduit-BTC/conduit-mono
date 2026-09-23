import {
  ConduitDB,
  db,
  type StoredCheckoutSparkPlanBinding,
  type StoredCheckoutSparkReconciliation,
  type StoredCheckoutSparkRetirement,
} from "../db"
import {
  createCheckoutSparkReconciliation,
  restoreCheckoutSparkReconciliation,
  retireCheckoutSparkReconciliation,
  type CheckoutSparkPlan,
  type CheckoutSparkReconciliation,
  type CheckoutSparkRetirementEvidence,
  type CheckoutSparkRetirementTombstone,
} from "./checkout-spark-reconciliation"

const HEX_64 = /^[0-9a-f]{64}$/

export type CheckoutSparkRepositorySnapshot =
  | { status: "absent" }
  | {
      status: "active"
      revision: number
      state: CheckoutSparkReconciliation
    }
  | {
      status: "retired"
      tombstone: CheckoutSparkRetirementTombstone
    }

export class CheckoutSparkRepositoryConflictError extends Error {
  constructor() {
    super("Checkout Spark state changed; reload before continuing.")
    this.name = "CheckoutSparkRepositoryConflictError"
  }
}

export class CheckoutSparkRepositoryIntegrityError extends Error {
  constructor() {
    super("Checkout Spark local recovery state is inconsistent.")
    this.name = "CheckoutSparkRepositoryIntegrityError"
  }
}

function assertCheckoutId(checkoutId: string): void {
  if (
    typeof checkoutId !== "string" ||
    checkoutId.trim() !== checkoutId ||
    !checkoutId ||
    checkoutId.length > 256
  ) {
    throw new Error("Checkout Spark checkout id is invalid.")
  }
}

function assertPlanDigest(planDigest: string): void {
  if (!HEX_64.test(planDigest)) {
    throw new Error("Checkout Spark plan digest is invalid.")
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Checkout Spark revision is invalid.")
  }
}

/** Persist only the validated, explicit non-credential fields. */
function projectState(
  state: CheckoutSparkReconciliation
): CheckoutSparkReconciliation {
  const validated = restoreCheckoutSparkReconciliation(state)
  return {
    schemaVersion: 1,
    plan: validated.plan,
    funding: {
      state: validated.funding.state,
      observedAt: validated.funding.observedAt,
    },
    obligations: validated.obligations.map((progress) => ({
      obligationId: progress.obligationId,
      state: progress.state,
      observedAt: progress.observedAt,
    })),
    updatedAt: validated.updatedAt,
  }
}

function assertProgression(
  previous: CheckoutSparkReconciliation,
  next: CheckoutSparkReconciliation
): void {
  if (next.updatedAt < previous.updatedAt) {
    throw new CheckoutSparkRepositoryConflictError()
  }
  if (
    previous.funding.observedAt !== null &&
    (next.funding.observedAt === null ||
      next.funding.observedAt < previous.funding.observedAt ||
      (next.funding.observedAt === previous.funding.observedAt &&
        next.funding.state !== previous.funding.state))
  ) {
    throw new CheckoutSparkRepositoryConflictError()
  }
  for (let index = 0; index < previous.obligations.length; index += 1) {
    const oldProgress = previous.obligations[index]!
    const newProgress = next.obligations[index]!
    if (
      (oldProgress.observedAt !== null &&
        (newProgress.observedAt === null ||
          newProgress.observedAt < oldProgress.observedAt ||
          (newProgress.observedAt === oldProgress.observedAt &&
            newProgress.state !== oldProgress.state))) ||
      (oldProgress.state === "paid" && newProgress.state !== "paid") ||
      (oldProgress.state === "terminal_failure" &&
        newProgress.state !== "terminal_failure" &&
        newProgress.state !== "paid")
    ) {
      throw new CheckoutSparkRepositoryConflictError()
    }
  }
}

function snapshotFromRows(
  checkoutId: string,
  binding: StoredCheckoutSparkPlanBinding | undefined,
  active: StoredCheckoutSparkReconciliation | undefined,
  retired: StoredCheckoutSparkRetirement | undefined
): CheckoutSparkRepositorySnapshot {
  if (!binding) {
    if (active || retired) throw new CheckoutSparkRepositoryIntegrityError()
    return { status: "absent" }
  }
  if (
    binding.checkoutId !== checkoutId ||
    !HEX_64.test(binding.planDigest) ||
    Boolean(active) === Boolean(retired)
  ) {
    throw new CheckoutSparkRepositoryIntegrityError()
  }
  if (active) {
    assertRevision(active.revision)
    const state = projectState(active.state)
    if (
      active.checkoutId !== checkoutId ||
      state.plan.checkoutId !== checkoutId ||
      state.plan.planDigest !== binding.planDigest
    ) {
      throw new CheckoutSparkRepositoryIntegrityError()
    }
    return { status: "active", revision: active.revision, state }
  }
  if (
    !retired ||
    retired.checkoutId !== checkoutId ||
    retired.schemaVersion !== 1 ||
    retired.planDigest !== binding.planDigest ||
    !Number.isSafeInteger(retired.retiredAt) ||
    retired.retiredAt < 0
  ) {
    throw new CheckoutSparkRepositoryIntegrityError()
  }
  return {
    status: "retired",
    tombstone: {
      schemaVersion: 1,
      planDigest: retired.planDigest,
      retiredAt: retired.retiredAt,
    },
  }
}

/**
 * One origin's durable checkout state. This is not shared between Market and
 * Merchant origins; the signed recovery package and provider history remain
 * the cross-actor authority. Every mutation is a local IndexedDB transaction.
 */
export class DexieCheckoutSparkRepository {
  constructor(private readonly database: ConduitDB = db) {}

  private async readInTransaction(
    checkoutId: string
  ): Promise<CheckoutSparkRepositorySnapshot> {
    const binding =
      await this.database.checkoutSparkPlanBindings.get(checkoutId)
    const active =
      await this.database.checkoutSparkReconciliations.get(checkoutId)
    const retired = await this.database.checkoutSparkRetirements.get(checkoutId)
    return snapshotFromRows(checkoutId, binding, active, retired)
  }

  async load(
    checkoutId: string,
    planDigest: string
  ): Promise<CheckoutSparkRepositorySnapshot> {
    assertCheckoutId(checkoutId)
    assertPlanDigest(planDigest)
    return this.database.transaction(
      "r",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(checkoutId)
        if (
          snapshot.status !== "absent" &&
          (snapshot.status === "active"
            ? snapshot.state.plan.planDigest
            : snapshot.tombstone.planDigest) !== planDigest
        ) {
          throw new CheckoutSparkRepositoryConflictError()
        }
        return snapshot
      }
    )
  }

  async create(
    plan: CheckoutSparkPlan
  ): Promise<CheckoutSparkRepositorySnapshot> {
    const state = projectState(createCheckoutSparkReconciliation(plan))
    const { checkoutId, planDigest } = state.plan
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const snapshot = await this.readInTransaction(checkoutId)
        if (snapshot.status !== "absent") {
          const existingDigest =
            snapshot.status === "active"
              ? snapshot.state.plan.planDigest
              : snapshot.tombstone.planDigest
          if (existingDigest !== planDigest || snapshot.status === "retired") {
            throw new CheckoutSparkRepositoryConflictError()
          }
          return snapshot
        }
        await this.database.checkoutSparkPlanBindings.add({
          checkoutId,
          planDigest,
        })
        await this.database.checkoutSparkReconciliations.add({
          checkoutId,
          revision: 1,
          state,
        })
        return { status: "active" as const, revision: 1, state }
      }
    )
  }

  async save(
    state: CheckoutSparkReconciliation,
    expectedRevision: number
  ): Promise<CheckoutSparkRepositorySnapshot> {
    assertRevision(expectedRevision)
    const next = projectState(state)
    const { checkoutId, planDigest } = next.plan
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const current = await this.readInTransaction(checkoutId)
        if (
          current.status !== "active" ||
          current.revision !== expectedRevision ||
          current.state.plan.planDigest !== planDigest ||
          !Number.isSafeInteger(current.revision + 1)
        ) {
          throw new CheckoutSparkRepositoryConflictError()
        }
        assertProgression(current.state, next)
        const revision = current.revision + 1
        await this.database.checkoutSparkReconciliations.put({
          checkoutId,
          revision,
          state: next,
        })
        return { status: "active" as const, revision, state: next }
      }
    )
  }

  async retire(input: {
    checkoutId: string
    planDigest: string
    expectedRevision: number
    evidence: CheckoutSparkRetirementEvidence
  }): Promise<CheckoutSparkRetirementTombstone> {
    assertCheckoutId(input.checkoutId)
    assertPlanDigest(input.planDigest)
    assertRevision(input.expectedRevision)
    return this.database.transaction(
      "rw",
      this.database.checkoutSparkPlanBindings,
      this.database.checkoutSparkReconciliations,
      this.database.checkoutSparkRetirements,
      async () => {
        const current = await this.readInTransaction(input.checkoutId)
        if (
          current.status !== "active" ||
          current.revision !== input.expectedRevision ||
          current.state.plan.planDigest !== input.planDigest
        ) {
          throw new CheckoutSparkRepositoryConflictError()
        }
        const tombstone = retireCheckoutSparkReconciliation(
          current.state,
          input.evidence
        )
        await this.database.checkoutSparkRetirements.add({
          checkoutId: input.checkoutId,
          ...tombstone,
        })
        await this.database.checkoutSparkReconciliations.delete(
          input.checkoutId
        )
        return tombstone
      }
    )
  }
}
