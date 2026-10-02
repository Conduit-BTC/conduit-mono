import {
  CheckoutSparkSettledRepositoryConflictError,
  DexieCheckoutSparkSettledRepository,
  assertCheckoutSparkSettledRecoveryProgression,
  assertCheckoutSparkSettledClosedReturnedProof,
  assertCheckoutSparkSettledReturnedProof,
  checkoutSparkSettledOutgoingStatusObservation,
  classifyCheckoutSparkSettledExactOutgoingHistory,
  collectCheckoutSparkNativeRetirementEvidence,
  ensureSparkPrivateModeReady,
  getCheckoutSparkSettledClosedGeneration,
  getCheckoutSparkSettledLegGeneration,
  inspectSparkCheckoutLightningReturnedAttempt,
  inspectSparkCheckoutLightningClosedReturnedAttempt,
  proveCheckoutSparkSettledClosedReturnedTransfer,
  proveCheckoutSparkSettledReturnedTransfer,
  proveSparkCheckoutReceiveCredit,
  readExactSparkLightningRecoveredTransfer,
  recordCheckoutSparkSettledCredit,
  requireCheckoutSparkSettledExactOutgoingRequest,
  restoreCheckoutSparkMerchantOrderWitness,
  runCheckoutSparkSettledOutgoingStep,
  runWithCheckoutSparkMerchantRecoveryLock,
  verifyExactSparkLightningRequestDebit,
  withMerchantCheckoutSparkRecovery,
  type CheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledRecoveryPayload,
  type CheckoutSparkMerchantOrderWitness,
  type CheckoutSparkMerchantRecoveryLockManager,
  type CheckoutSparkSettledOutgoingObservation,
  type CheckoutSparkSettledOutgoingTarget,
  type CheckoutSparkSettledReturnedProof,
  type CheckoutSparkSettledClosedReturnedProof,
  type CheckoutSparkSettledPlan,
  type MerchantCheckoutSparkRecoveryCandidate,
  type MerchantCheckoutSparkRecoveryHandoffResult,
  type SparkCheckoutReceiveCreditNativeReceive,
  type SparkCheckoutReceiveCreditNativeTransfer,
  type CheckoutSparkNativeRetirementReader,
  type SparkCheckoutLightningReturnedInspection,
  type SparkCheckoutLightningReturnedInspectionInput,
  type SparkCheckoutLightningClosedReturnedInspection,
  type SparkCheckoutLightningClosedReturnedInspectionInput,
} from "@conduit/core"

type RecoveryStore = Pick<
  DexieCheckoutSparkSettledRepository,
  "importRecoveryState"
> &
  Partial<
    Pick<
      DexieCheckoutSparkSettledRepository,
      "importMerchantOrderRecovery" | "loadMerchantOrderWitness"
    >
  >

interface RecoveryKeyVerificationDependencies {
  deriveIdentity?: (mnemonic: string, accountNumber: number) => Promise<string>
  now?: () => number
  repository?: Pick<
    DexieCheckoutSparkSettledRepository,
    "load" | "loadMerchantOrderWitness"
  >
}

/** Native renewal only; signed closure metadata cannot mint provider proof. */
export async function proveMerchantCheckoutSparkReturnedPayout(
  state: CheckoutSparkSettledReconciliation,
  legId: string,
  wallet: MerchantSparkRecoveryWallet,
  assertCurrent: () => void,
  now: () => number = Date.now
): Promise<CheckoutSparkSettledReturnedProof> {
  assertCurrent()
  const leg = state.legs.find((item) => item.legId === legId)
  const recipient = state.plan.recipients.find((item) => item.legId === legId)
  const closed = leg ? getCheckoutSparkSettledClosedGeneration(leg) : null
  const intent = closed?.intent ?? leg?.intent
  if (
    !leg ||
    !recipient ||
    !intent ||
    leg.allocationSats === null ||
    !wallet.inspectReturnedInvoiceAttempt
  ) {
    throw new Error("Checkout Spark returned payout proof is unavailable.")
  }
  let protectedSats = 0
  for (const item of state.legs) {
    if (item.status === "paid") continue
    if (
      item.allocationSats === null ||
      !Number.isSafeInteger(item.allocationSats) ||
      item.allocationSats < 0
    ) {
      throw new Error("Checkout Spark returned payout budget is unavailable.")
    }
    protectedSats += item.allocationSats
  }
  if (!Number.isSafeInteger(protectedSats)) {
    throw new Error("Checkout Spark returned payout budget is unavailable.")
  }
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: state.plan.walletId,
    network: state.plan.network,
    legId,
    recipientId: recipient.recipientId,
    allocationSats: leg.allocationSats,
    unpaidAllocationSats: protectedSats,
    generation: 0,
    intent,
  }
  const observed = await wallet.inspectReturnedInvoiceAttempt(
    {
      network: state.plan.network,
      transferId: intent.transferId,
      paymentRequest: intent.paymentRequest,
      paymentHash: intent.paymentHash,
      amountSats: intent.invoiceAmountSats,
      maxFeeSats: intent.maxFeeSats,
      receiverIdentityPublicKey: state.plan.funding.receiverIdentityPublicKey,
      minimumAvailableSats: protectedSats,
    },
    { now, assertCurrent }
  )
  assertCurrent()
  if (observed.status !== "returned") {
    throw new Error("Checkout Spark returned payout proof is unavailable.")
  }
  const proof = proveCheckoutSparkSettledReturnedTransfer({
    plan: state.plan,
    target,
    evidence: observed.evidence,
  })
  const closure = assertCheckoutSparkSettledReturnedProof(proof, {
    plan: state.plan,
    target,
    nowMs: now(),
  })
  if (
    closed &&
    (closure.requestId !== closed.closure.requestId ||
      closure.debitedSats !== closed.closure.debitedSats ||
      closure.returnedSats !== closed.closure.returnedSats)
  ) {
    throw new Error("Checkout Spark returned payout evidence changed.")
  }
  return proof
}

/** Terminal cleanup only; returned leaves may already fund the paid successor. */
export async function proveMerchantCheckoutSparkClosedReturnedPayout(
  state: CheckoutSparkSettledReconciliation,
  legId: string,
  wallet: MerchantSparkRecoveryWallet,
  assertCurrent: () => void,
  now: () => number = Date.now
): Promise<CheckoutSparkSettledClosedReturnedProof> {
  assertCurrent()
  const leg = state.legs.find((item) => item.legId === legId)
  const recipient = state.plan.recipients.find((item) => item.legId === legId)
  const closed = leg ? getCheckoutSparkSettledClosedGeneration(leg) : null
  if (
    !leg ||
    !recipient ||
    !closed ||
    leg.allocationSats === null ||
    !wallet.inspectReturnedInvoiceClosure
  ) {
    throw new Error("Checkout Spark closed payout proof is unavailable.")
  }
  const intent = closed.intent
  const target: CheckoutSparkSettledOutgoingTarget = {
    walletId: state.plan.walletId,
    network: state.plan.network,
    legId,
    recipientId: recipient.recipientId,
    allocationSats: leg.allocationSats,
    unpaidAllocationSats: leg.allocationSats,
    generation: 0,
    intent,
  }
  const observed = await wallet.inspectReturnedInvoiceClosure(
    {
      network: state.plan.network,
      transferId: intent.transferId,
      paymentRequest: intent.paymentRequest,
      paymentHash: intent.paymentHash,
      amountSats: intent.invoiceAmountSats,
      maxFeeSats: intent.maxFeeSats,
      receiverIdentityPublicKey: state.plan.funding.receiverIdentityPublicKey,
    },
    { now, assertCurrent }
  )
  assertCurrent()
  if (observed.status !== "closed_returned") {
    throw new Error("Checkout Spark closed payout proof is unavailable.")
  }
  const proof = proveCheckoutSparkSettledClosedReturnedTransfer({
    plan: state.plan,
    target,
    evidence: observed.evidence,
  })
  const closure = assertCheckoutSparkSettledClosedReturnedProof(proof, {
    walletId: state.plan.walletId,
    network: state.plan.network,
    nowMs: now(),
  })
  if (
    closure.requestId !== closed.closure.requestId ||
    closure.debitedSats !== closed.closure.debitedSats ||
    closure.returnedSats !== closed.closure.returnedSats ||
    closure.transferId !== closed.closure.transferId ||
    closure.paymentHash !== closed.closure.paymentHash ||
    closure.intentDigest !== closed.closure.intentDigest
  ) {
    throw new Error("Checkout Spark closed payout evidence changed.")
  }
  return proof
}

export interface MerchantSparkRecoveryWallet {
  ensurePrivateReady(): Promise<void>
  getIdentityPublicKey(): Promise<string>
  getLightningReceiveRequest(
    id: string
  ): Promise<SparkCheckoutReceiveCreditNativeReceive | null>
  getTransfer(
    id: string
  ): Promise<SparkCheckoutReceiveCreditNativeTransfer | undefined>
  getTransferFromSsp?(id: string): Promise<
    | {
        sparkId?: string
        totalAmount?: { originalValue: number; originalUnit: string }
        userRequest?: unknown
      }
    | undefined
  >
  getLightningSendRequest?(id: string): Promise<{
    id: string
    status: string
    fee: { originalValue: number; originalUnit: string }
    encodedInvoice: string
    idempotencyKey: string
    paymentPreimage?: string | null
    typename: string
  } | null>
  /** Quote-only capability; preparing an intent does not enable outgoing sends. */
  estimateLightningFee?(input: { paymentRequest: string }): Promise<number>
  /** Explicit native renewal only: fresh leaf inspection can recover keys. */
  inspectReturnedInvoiceAttempt?(
    input: SparkCheckoutLightningReturnedInspectionInput,
    options: { now: () => number; assertCurrent: () => void }
  ): Promise<SparkCheckoutLightningReturnedInspection>
  /** Terminal retirement only; never reads spendable leaves or permits sends. */
  inspectReturnedInvoiceClosure?(
    input: SparkCheckoutLightningClosedReturnedInspectionInput,
    options: { now: () => number; assertCurrent: () => void }
  ): Promise<SparkCheckoutLightningClosedReturnedInspection>
  /** Authenticated, live native history/funds reads; never a public reader. */
  openRetirementReader?(): Promise<{
    reader: CheckoutSparkNativeRetirementReader
    sparkAddress: string
  }>
  cleanup(): Promise<void>
  /** Absent from inspection-only wallet sessions. */
  outgoing?: {
    getAvailableSats(): Promise<bigint>
    estimateFee(input: { paymentRequest: string }): Promise<number>
    sendFrozen(input: {
      paymentRequest: string
      maxFeeSats: number
      transferId: string
    }): Promise<unknown>
  }
}

interface RecoveryCreditDependencies extends RecoveryKeyVerificationDependencies {
  /** Caller-owned visibility/account generation; never resumes after disposal. */
  assertActive?: () => void
  /** Previously authenticated buyer order; never inferred from a cached list. */
  expectedOrderWitness?: CheckoutSparkMerchantOrderWitness
  repository?: Pick<
    DexieCheckoutSparkSettledRepository,
    | "load"
    | "save"
    | "loadMerchantOrderWitness"
    | "recordMerchantCredit"
    | "recordMerchantPayout"
  >
  openWallet?: (input: {
    mnemonic: string
    accountNumber: number
    network: "mainnet" | "regtest"
    retirement?: true
  }) => Promise<MerchantSparkRecoveryWallet>
  lockManager?: CheckoutSparkMerchantRecoveryLockManager | null
  requireCrossTabLock?: boolean
}

type RecoveryHistoryDependencies = RecoveryCreditDependencies

export interface MerchantCheckoutSparkPayoutHistory {
  status: "credit_needed" | "no_intents" | "inspected"
  checkedLegs: number
  newlyConfirmedLegs: number
  unresolvedLegs: number
  withoutIntentLegs: number
  /** Imported paid claims re-attested against exact provider history. */
  alreadyPaidLegs: number
}

export interface MerchantCheckoutSparkPayoutHistoryResult extends MerchantCheckoutSparkRecoveryHandoffResult {
  payoutHistory: MerchantCheckoutSparkPayoutHistory | null
}

export interface MerchantCheckoutSparkCreditResult extends MerchantCheckoutSparkRecoveryHandoffResult {
  creditStatus: "recorded" | "pending" | null
}

/**
 * SDK initialize can fail after its background receive stream has started.
 * Capture the instance at construction, then clean it up even on rejection.
 * Keep this per invocation so concurrent initializations never share a slot.
 */
export async function initializeMerchantSparkWalletWithCleanup<
  T extends { cleanup(): Promise<void> },
>(initialize: (capture: (wallet: T) => void) => Promise<T>): Promise<T> {
  let captured: T | null = null
  try {
    return await initialize((wallet) => {
      captured = wallet
    })
  } catch (initializationError) {
    const capturedWallet = captured as T | null
    if (capturedWallet !== null) {
      try {
        await capturedWallet.cleanup()
      } catch (cleanupError) {
        throw new AggregateError(
          [initializationError, cleanupError],
          "Checkout Spark wallet initialization and cleanup both failed.",
          { cause: cleanupError }
        )
      }
    }
    throw initializationError
  }
}

/** Opening a wallet may claim inbound funds. Never call outside explicit takeover. */
export async function openMerchantCheckoutSparkRecoveryWallet(input: {
  mnemonic: string
  accountNumber: number
  network: "mainnet" | "regtest"
  outgoing?: true
  renewal?: true
  retirement?: true
}): Promise<MerchantSparkRecoveryWallet> {
  const { SparkReadonlyClient, SparkWallet, DefaultSparkSigner, UUID } =
    await import("@buildonspark/spark-sdk")
  const nativeNetwork = input.network === "mainnet" ? "MAINNET" : "REGTEST"
  const wallet = await initializeMerchantSparkWalletWithCleanup<
    InstanceType<typeof SparkWallet>
  >(async (capture) => {
    class CapturedSparkWallet extends SparkWallet {
      constructor(...args: ConstructorParameters<typeof SparkWallet>) {
        super(...args)
        capture(this)
      }
    }
    return (
      await CapturedSparkWallet.initialize({
        mnemonicOrSeed: input.mnemonic,
        accountNumber: input.accountNumber,
        options: { log: false, network: nativeNetwork },
      })
    ).wallet
  })
  class RetirementReadonlyClient extends SparkReadonlyClient {
    async cleanup() {
      try {
        await this.connectionManager.closeConnections()
      } finally {
        await this.logging.close()
      }
    }
  }
  let retirementReader: RetirementReadonlyClient | undefined
  return {
    ensurePrivateReady: () =>
      ensureSparkPrivateModeReady({
        wallet,
        createPublicReader: () =>
          SparkReadonlyClient.createPublic({
            log: false,
            network: nativeNetwork,
          }),
        convergenceTimeoutMs: 60_000,
        readTimeoutMs: 5_000,
        observationIntervalMs: 500,
        requiredConsecutiveObservations: 5,
        readWithTimeout,
        wait: (milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)),
        now: Date.now,
      }),
    getIdentityPublicKey: () => wallet.getIdentityPublicKey(),
    getTransferFromSsp: (id) => wallet.getTransferFromSsp(id),
    getLightningSendRequest: (id) => wallet.getLightningSendRequest(id),
    ...(input.renewal || input.outgoing
      ? {
          inspectReturnedInvoiceAttempt: (
            request: SparkCheckoutLightningReturnedInspectionInput,
            options: { now: () => number; assertCurrent: () => void }
          ) =>
            inspectSparkCheckoutLightningReturnedAttempt(
              wallet,
              request,
              options
            ),
        }
      : {}),
    ...(input.retirement
      ? {
          inspectReturnedInvoiceClosure: (
            request: SparkCheckoutLightningClosedReturnedInspectionInput,
            options: { now: () => number; assertCurrent: () => void }
          ) =>
            inspectSparkCheckoutLightningClosedReturnedAttempt(
              wallet,
              request,
              options
            ),
        }
      : {}),
    estimateLightningFee: ({ paymentRequest }) =>
      wallet.getLightningSendFeeEstimate({ encodedInvoice: paymentRequest }),
    getLightningReceiveRequest: (id) =>
      wallet.getLightningReceiveRequest(
        id
      ) as Promise<SparkCheckoutReceiveCreditNativeReceive | null>,
    async getTransfer(id) {
      const transfer = await wallet.getTransfer(id)
      if (!transfer) return undefined
      const request = transfer.userRequest as { id?: unknown } | undefined
      return {
        ...transfer,
        userRequest:
          typeof request?.id === "string" ? { id: request.id } : undefined,
      } as SparkCheckoutReceiveCreditNativeTransfer
    },
    async openRetirementReader() {
      if (!retirementReader) {
        const signer = new DefaultSparkSigner()
        const seed = await signer.mnemonicToSeed(input.mnemonic)
        try {
          await signer.createSparkWalletFromSeed(seed, input.accountNumber)
        } finally {
          seed.fill(0)
        }
        retirementReader = RetirementReadonlyClient.createWithSigner(
          { log: false, network: nativeNetwork },
          signer
        )
      }
      const reader = retirementReader
      return {
        sparkAddress: await wallet.getSparkAddress(),
        reader: {
          getTransfers: (params) =>
            readWithTimeout(
              reader.getTransfers(params),
              5_000,
              "Retirement history"
            ),
          getPendingTransfers: (address) =>
            readWithTimeout(
              reader.getPendingTransfers(address),
              5_000,
              "Retirement pending state"
            ),
          getAvailableBalance: (address) =>
            readWithTimeout(
              reader.getAvailableBalance(address),
              5_000,
              "Retirement available state"
            ),
          getOwnedBalance: (address) =>
            readWithTimeout(
              reader.getOwnedBalance(address),
              5_000,
              "Retirement owned state"
            ),
        },
      }
    },
    async cleanup() {
      try {
        await wallet.cleanup()
      } finally {
        await retirementReader?.cleanup()
        retirementReader = undefined
      }
    },
    ...(input.outgoing
      ? {
          outgoing: {
            getAvailableSats: async () =>
              (await wallet.getBalance()).satsBalance.available,
            estimateFee: ({ paymentRequest }: { paymentRequest: string }) =>
              wallet.getLightningSendFeeEstimate({
                encodedInvoice: paymentRequest,
              }),
            sendFrozen: (request: {
              paymentRequest: string
              maxFeeSats: number
              transferId: string
            }) =>
              wallet.payLightningInvoice({
                invoice: request.paymentRequest,
                maxFeeSats: request.maxFeeSats,
                preferSpark: false,
                transferId: UUID.parse(request.transferId),
              }),
          },
        }
      : {}),
  }
}

async function readWithTimeout<T>(
  read: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)),
          timeoutMs
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Derive identity locally without initializing a provider wallet. */
export async function deriveMerchantCheckoutSparkRecoveryIdentity(
  mnemonic: string,
  accountNumber: number
): Promise<string> {
  if (
    !Number.isSafeInteger(accountNumber) ||
    accountNumber < 0 ||
    accountNumber > 0x7fffffff
  ) {
    throw new Error("Checkout Spark recovery account is invalid.")
  }
  const normalizedMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, " ")
  const [{ DefaultSparkSigner }, { validateMnemonic }, { wordlist }] =
    await Promise.all([
      import("@buildonspark/spark-sdk"),
      import("@scure/bip39"),
      import("@scure/bip39/wordlists/english.js"),
    ])
  if (!validateMnemonic(normalizedMnemonic, wordlist)) {
    throw new Error("Checkout Spark recovery phrase is invalid.")
  }
  const signer = new DefaultSparkSigner()
  const seed = await signer.mnemonicToSeed(normalizedMnemonic)
  try {
    return (await signer.createSparkWalletFromSeed(seed, accountNumber))
      .trim()
      .toLowerCase()
  } finally {
    seed.fill(0)
  }
}

export function merchantCheckoutRecoveryPrincipalKey(
  principalPubkey: string
): string {
  return principalPubkey.trim().toLowerCase()
}

export function isLocalCheckoutSparkRecoveryRehearsal(input: {
  dev: boolean
  rehearsalFlag: string | undefined
  routerCanaryFlag: string | undefined
  hostname: string | undefined
}): boolean {
  return (
    input.dev === true &&
    input.rehearsalFlag === "true" &&
    input.routerCanaryFlag === "true" &&
    (input.hostname === "localhost" ||
      input.hostname === "127.0.0.1" ||
      input.hostname === "[::1]" ||
      input.hostname === "::1")
  )
}

function assertMerchantSnapshot(input: {
  principalPubkey: string
  initial: CheckoutSparkSettledRecoveryPayload
  state: CheckoutSparkSettledReconciliation
}): void {
  const { principalPubkey, initial, state } = input
  if (
    initial.merchantPubkey !== principalPubkey ||
    state.plan.merchantPubkey !== principalPubkey ||
    initial.plan.planDigest !== state.plan.planDigest ||
    initial.wallet.walletId !== state.plan.walletId ||
    initial.wallet.network !== state.plan.network
  ) {
    throw new Error("Checkout Spark merchant recovery binding is invalid.")
  }
}

function assertExpectedOrderWitness(
  expected: CheckoutSparkMerchantOrderWitness | undefined,
  initial: CheckoutSparkSettledRecoveryPayload
): void {
  if (!expected) return
  const exact = restoreCheckoutSparkMerchantOrderWitness(expected, initial.plan)
  if (initial.senderPubkey !== exact.buyerPubkey) {
    throw new Error("Checkout Spark order witness does not match recovery.")
  }
}

async function assertAuthenticatedMerchantProgressOrder(input: {
  repository: Pick<
    DexieCheckoutSparkSettledRepository,
    "loadMerchantOrderWitness"
  >
  principalPubkey: string
  initial: CheckoutSparkSettledRecoveryPayload
  assertCurrent: () => void
}): Promise<CheckoutSparkMerchantOrderWitness> {
  const { repository, principalPubkey, initial, assertCurrent } = input
  assertCurrent()
  const witness = await repository.loadMerchantOrderWitness(
    principalPubkey,
    initial.plan.checkoutId,
    initial.plan.planDigest
  )
  assertCurrent()
  const exact = witness
    ? restoreCheckoutSparkMerchantOrderWitness(witness, initial.plan)
    : null
  if (!exact || exact.buyerPubkey !== initial.senderPubkey) {
    throw new Error(
      "Checkout Spark Merchant progress requires its authenticated order."
    )
  }
  return exact
}

/**
 * Explicit Merchant-only foreground import. The encrypted wallet bundle is
 * read only inside the private callback and is never returned or persisted.
 * This saves state for later reconciliation; it does not restore a wallet or
 * authorize an outgoing payment.
 */
export async function importMerchantCheckoutSparkSettledRecovery(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  repository: RecoveryStore = new DexieCheckoutSparkSettledRepository()
): Promise<MerchantCheckoutSparkRecoveryHandoffResult> {
  const principal = principalPubkey.trim().toLowerCase()
  return withMerchantCheckoutSparkRecovery(principal, selected, {
    async consume(payload, assertCurrent) {
      assertCurrent()
      if (payload.schemaVersion !== 2) {
        throw new Error("This checkout recovery uses an older plan version.")
      }
      assertMerchantSnapshot({
        principalPubkey: principal,
        initial: payload,
        state: payload.state,
      })
      await repository.importRecoveryState(payload.state, assertCurrent)
      assertCurrent()
    },
    async consumeSettled(initial, latest, assertCurrent) {
      assertCurrent()
      assertMerchantSnapshot({
        principalPubkey: principal,
        initial,
        state: latest.state,
      })
      await repository.importRecoveryState(latest.state, assertCurrent)
      assertCurrent()
    },
    async consumeMerchantProgress(
      initial,
      _latestBuyer,
      progress,
      assertCurrent
    ) {
      assertCurrent()
      assertMerchantSnapshot({
        principalPubkey: principal,
        initial,
        state: progress.state,
      })
      if (
        !repository.loadMerchantOrderWitness ||
        !repository.importMerchantOrderRecovery
      ) {
        throw new Error(
          "Checkout Spark Merchant progress requires its authenticated order."
        )
      }
      const witness = await assertAuthenticatedMerchantProgressOrder({
        repository: repository as Pick<
          DexieCheckoutSparkSettledRepository,
          "loadMerchantOrderWitness"
        >,
        principalPubkey: principal,
        initial,
        assertCurrent,
      })
      assertCurrent()
      await repository.importMerchantOrderRecovery(
        progress.state,
        witness,
        assertCurrent
      )
      assertCurrent()
    },
  })
}

/**
 * Verify the recovered key against the exact signed funding identity. The
 * inbox is freshly re-read; derivation stays local and neither a provider
 * wallet nor an outgoing payment is opened.
 */
export async function verifyMerchantCheckoutSparkSettledRecoveryKey(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  dependencies: RecoveryKeyVerificationDependencies = {}
): Promise<MerchantCheckoutSparkRecoveryHandoffResult> {
  const principal = principalPubkey.trim().toLowerCase()
  const deriveIdentity =
    dependencies.deriveIdentity ?? deriveMerchantCheckoutSparkRecoveryIdentity
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const now = dependencies.now ?? Date.now
  const verify = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    state: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void
  ) => {
    const assertEligible = () => {
      assertCurrent()
      if (now() < initial.plan.takeoverAt) {
        throw new Error("Merchant checkout takeover is not yet available.")
      }
    }
    assertEligible()
    assertMerchantSnapshot({ principalPubkey: principal, initial, state })
    const derivedIdentity = await deriveIdentity(
      initial.wallet.mnemonic,
      initial.wallet.accountNumber
    )
    assertEligible()
    if (
      !/^(02|03)[0-9a-f]{64}$/.test(derivedIdentity) ||
      derivedIdentity !== initial.plan.funding.receiverIdentityPublicKey
    ) {
      throw new Error("Checkout Spark recovery key does not match funding.")
    }
  }
  return withMerchantCheckoutSparkRecovery(principal, selected, {
    async consume(payload, assertCurrent) {
      if (payload.schemaVersion !== 2) {
        throw new Error(
          "An older checkout recovery cannot verify a settled key."
        )
      }
      await verify(payload, payload.state, assertCurrent)
    },
    async consumeSettled(initial, latest, assertCurrent) {
      await verify(initial, latest.state, assertCurrent)
    },
    async consumeMerchantProgress(
      initial,
      _latestBuyer,
      progress,
      assertCurrent
    ) {
      await assertAuthenticatedMerchantProgressOrder({
        repository,
        principalPubkey: principal,
        initial,
        assertCurrent,
      })
      assertCurrent()
      const stored = await repository.load(
        initial.plan.checkoutId,
        initial.plan.planDigest
      )
      assertCurrent()
      if (stored.status !== "active") {
        throw new Error(
          "Checkout Spark Merchant progress has not been imported locally."
        )
      }
      assertMerchantSnapshot({
        principalPubkey: principal,
        initial,
        state: stored.state,
      })
      assertCheckoutSparkSettledRecoveryProgression(
        progress.state,
        stored.state
      )
      await verify(initial, progress.state, assertCurrent)
    },
  })
}

/**
 * Explicit post-takeover credit check. Re-read the exact signed handoff,
 * verify its local import and pinned key, then attest only its completed
 * Spark receive. This opens no payout invoice and never sends funds.
 */
export async function reconcileMerchantCheckoutSparkSettledCredit(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  dependencies: RecoveryCreditDependencies = {}
): Promise<MerchantCheckoutSparkCreditResult> {
  const principal = principalPubkey.trim().toLowerCase()
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const deriveIdentity =
    dependencies.deriveIdentity ?? deriveMerchantCheckoutSparkRecoveryIdentity
  const openWallet =
    dependencies.openWallet ?? openMerchantCheckoutSparkRecoveryWallet
  const now = dependencies.now ?? Date.now
  let creditStatus: MerchantCheckoutSparkCreditResult["creditStatus"] = null

  const reconcile = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    state: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void
  ): Promise<void> => {
    const assertEligible = () => {
      dependencies.assertActive?.()
      assertCurrent()
      if (now() < initial.plan.takeoverAt) {
        throw new Error("Merchant checkout takeover is not yet available.")
      }
    }
    assertEligible()
    assertMerchantSnapshot({ principalPubkey: principal, initial, state })
    assertExpectedOrderWitness(dependencies.expectedOrderWitness, initial)
    const plan = initial.plan
    const imported = await repository.load(plan.checkoutId, plan.planDigest)
    assertEligible()
    if (
      imported.status !== "active" ||
      imported.state.plan.merchantPubkey !== principal ||
      imported.state.plan.planDigest !== plan.planDigest ||
      imported.state.plan.walletId !== initial.wallet.walletId ||
      imported.state.plan.network !== initial.wallet.network
    ) {
      throw new Error("Save the exact checkout recovery state first.")
    }
    assertCheckoutSparkSettledRecoveryProgression(state, imported.state)

    const derivedIdentity = await deriveIdentity(
      initial.wallet.mnemonic,
      initial.wallet.accountNumber
    )
    assertEligible()
    if (
      !/^(02|03)[0-9a-f]{64}$/.test(derivedIdentity) ||
      derivedIdentity !== plan.funding.receiverIdentityPublicKey
    ) {
      throw new Error("Checkout Spark recovery key does not match funding.")
    }

    const wallet = await openWallet({
      mnemonic: initial.wallet.mnemonic,
      accountNumber: initial.wallet.accountNumber,
      network: initial.wallet.network,
    })
    try {
      assertEligible()
      await wallet.ensurePrivateReady()
      assertEligible()
      const walletIdentity = (await wallet.getIdentityPublicKey()).toLowerCase()
      assertEligible()
      if (walletIdentity !== derivedIdentity) {
        throw new Error("Checkout Spark wallet identity changed.")
      }
      const receive = await wallet.getLightningReceiveRequest(
        plan.funding.requestId
      )
      assertEligible()
      if (!receive || receive.status !== "TRANSFER_COMPLETED") {
        creditStatus = "pending"
        return
      }
      const transferId = receive.transfer?.sparkId
      if (!transferId) {
        creditStatus = "pending"
        return
      }
      const transfer = await wallet.getTransfer(transferId)
      assertEligible()
      if (!transfer) {
        creditStatus = "pending"
        return
      }
      const proof = proveSparkCheckoutReceiveCredit({
        expectedRequest: {
          id: plan.funding.requestId,
          network: plan.network,
          paymentRequest: plan.funding.paymentRequest,
          paymentHash: plan.funding.paymentHash,
          grossFundingSats: plan.funding.grossFundingSats,
        },
        expectedReceive: { mode: "ordinary_v3" },
        walletIdentityPublicKey: walletIdentity,
        receive,
        transfer,
      })
      const current = await repository.load(plan.checkoutId, plan.planDigest)
      assertEligible()
      if (
        current.status !== "active" ||
        current.state.plan.merchantPubkey !== principal ||
        current.state.plan.planDigest !== plan.planDigest ||
        current.state.plan.walletId !== initial.wallet.walletId ||
        current.state.plan.network !== initial.wallet.network
      ) {
        throw new CheckoutSparkSettledRepositoryConflictError()
      }
      assertCheckoutSparkSettledRecoveryProgression(state, current.state)
      const next = recordCheckoutSparkSettledCredit(current.state, {
        requestId: proof.requestId,
        paymentHash: plan.funding.paymentHash,
        transferId: proof.transferId,
        receiverIdentityPublicKey: proof.receiverIdentityPublicKey,
        grossSats: proof.grossSats,
        creditedSats: proof.creditedSats,
        observedAt: now(),
      })
      if (current.state.credit === null) {
        await repository.save(next, current.revision, assertEligible)
        assertEligible()
      }
      // Keep provider proof separate from imported, buyer-signed progress.
      // The minimal record survives retirement without retaining wallet keys.
      await repository.recordMerchantCredit(plan, proof, now(), assertEligible)
      assertEligible()
      creditStatus = "recorded"
    } finally {
      await wallet.cleanup()
    }
  }

  const operation = async () => {
    dependencies.assertActive?.()
    const result = await withMerchantCheckoutSparkRecovery(
      principal,
      selected,
      {
        async consume(payload, assertCurrent) {
          if (payload.schemaVersion !== 2) {
            throw new Error("An older checkout recovery cannot verify credit.")
          }
          await reconcile(payload, payload.state, assertCurrent)
        },
        async consumeSettled(initial, latest, assertCurrent) {
          await reconcile(initial, latest.state, assertCurrent)
        },
        async consumeMerchantProgress(
          initial,
          _latestBuyer,
          progress,
          assertCurrent
        ) {
          dependencies.assertActive?.()
          await assertAuthenticatedMerchantProgressOrder({
            repository,
            principalPubkey: principal,
            initial,
            assertCurrent,
          })
          dependencies.assertActive?.()
          await reconcile(initial, progress.state, assertCurrent)
        },
      }
    )
    return {
      ...result,
      creditStatus: result.status === "consumed" ? creditStatus : null,
    }
  }
  dependencies.assertActive?.()
  return runWithCheckoutSparkMerchantRecoveryLock(
    selected.planDigest,
    async () => {
      dependencies.assertActive?.()
      return operation()
    },
    dependencies.lockManager,
    dependencies.requireCrossTabLock
  )
}

interface RecoveryRetirementDependencies extends Omit<
  RecoveryCreditDependencies,
  "repository"
> {
  consumeRecovery?: typeof withMerchantCheckoutSparkRecovery
  repository?: NonNullable<RecoveryCreditDependencies["repository"]> &
    Pick<
      DexieCheckoutSparkSettledRepository,
      "retire" | "assertLocalInvoiceOrigin"
    > &
    Partial<Pick<DexieCheckoutSparkSettledRepository, "assertInvoiceRecipient">>
}

export interface MerchantCheckoutSparkRetirementResult extends MerchantCheckoutSparkRecoveryHandoffResult {
  retirementStatus: "retired" | "pending" | null
}

/**
 * Successful-settlement cleanup only. Fresh exact provider facts and complete
 * native terminal history precede zero-funds evidence and atomic retirement.
 * Failed/refunded/unfunded plans retain recovery until those paths are proven.
 */
export async function retireMerchantCheckoutSparkSettledRecovery(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  dependencies: RecoveryRetirementDependencies = {}
): Promise<MerchantCheckoutSparkRetirementResult> {
  const principal = principalPubkey.trim().toLowerCase()
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const deriveIdentity =
    dependencies.deriveIdentity ?? deriveMerchantCheckoutSparkRecoveryIdentity
  const openWallet =
    dependencies.openWallet ?? openMerchantCheckoutSparkRecoveryWallet
  const now = dependencies.now ?? Date.now
  let retirementStatus: MerchantCheckoutSparkRetirementResult["retirementStatus"] =
    null
  const consumeRecovery =
    dependencies.consumeRecovery ?? withMerchantCheckoutSparkRecovery
  const retire = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    signed: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void
  ) => {
    const assertEligible = () => {
      dependencies.assertActive?.()
      assertCurrent()
      if (now() < initial.plan.takeoverAt) {
        throw new Error("Merchant checkout takeover is not yet available.")
      }
    }
    assertEligible()
    assertMerchantSnapshot({
      principalPubkey: principal,
      initial,
      state: signed,
    })
    assertExpectedOrderWitness(dependencies.expectedOrderWitness, initial)
    await assertAuthenticatedMerchantProgressOrder({
      repository,
      principalPubkey: principal,
      initial,
      assertCurrent: assertEligible,
    })
    const plan = initial.plan
    const saved = await repository.load(plan.checkoutId, plan.planDigest)
    assertEligible()
    if (saved.status !== "active") {
      retirementStatus = saved.status === "retired" ? "retired" : "pending"
      return
    }
    const state = saved.state
    assertMerchantSnapshot({ principalPubkey: principal, initial, state })
    assertCheckoutSparkSettledRecoveryProgression(signed, state)
    retirementStatus = "pending"
    if (
      !state.credit ||
      state.legs.some((leg) => leg.status !== "paid" || !leg.intent)
    )
      return
    const derivedIdentity = await deriveIdentity(
      initial.wallet.mnemonic,
      initial.wallet.accountNumber
    )
    assertEligible()
    if (
      !/^(02|03)[0-9a-f]{64}$/.test(derivedIdentity) ||
      derivedIdentity !== plan.funding.receiverIdentityPublicKey
    ) {
      throw new Error("Checkout Spark recovery key does not match funding.")
    }
    const wallet = await openWallet({
      mnemonic: initial.wallet.mnemonic,
      accountNumber: initial.wallet.accountNumber,
      network: initial.wallet.network,
      retirement: true,
    })
    try {
      assertEligible()
      if (!wallet.openRetirementReader) return
      await wallet.ensurePrivateReady()
      assertEligible()
      const observedWallet: MerchantSparkRecoveryWallet = {
        ...wallet,
        getLightningReceiveRequest: (id) =>
          readWithTimeout(
            wallet.getLightningReceiveRequest(id),
            5_000,
            "Retirement funding request"
          ),
        getTransfer: (id) =>
          readWithTimeout(
            wallet.getTransfer(id),
            5_000,
            "Retirement funding transfer"
          ),
        ...(wallet.getTransferFromSsp
          ? {
              getTransferFromSsp: (id: string) =>
                readWithTimeout(
                  wallet.getTransferFromSsp!(id),
                  5_000,
                  "Retirement payout transfer"
                ),
            }
          : {}),
        ...(wallet.getLightningSendRequest
          ? {
              getLightningSendRequest: (id: string) =>
                readWithTimeout(
                  wallet.getLightningSendRequest!(id),
                  5_000,
                  "Retirement payout request"
                ),
            }
          : {}),
      }
      const identity = (await wallet.getIdentityPublicKey()).toLowerCase()
      assertEligible()
      if (identity !== derivedIdentity)
        throw new Error("Checkout Spark wallet identity changed.")
      const receive = await observedWallet.getLightningReceiveRequest(
        plan.funding.requestId
      )
      assertEligible()
      if (
        !receive ||
        receive.status !== "TRANSFER_COMPLETED" ||
        !receive.transfer?.sparkId
      )
        return
      const transfer = await observedWallet.getTransfer(
        receive.transfer.sparkId
      )
      assertEligible()
      if (!transfer) return
      const proof = proveSparkCheckoutReceiveCredit({
        expectedRequest: {
          id: plan.funding.requestId,
          network: plan.network,
          paymentRequest: plan.funding.paymentRequest,
          paymentHash: plan.funding.paymentHash,
          grossFundingSats: plan.funding.grossFundingSats,
        },
        expectedReceive: { mode: "ordinary_v3" },
        walletIdentityPublicKey: identity,
        receive,
        transfer,
      })
      if (
        proof.transferId !== state.credit.transferId ||
        proof.creditedSats !== state.credit.creditedSats
      )
        return
      await repository.recordMerchantCredit(plan, proof, now(), assertEligible)
      assertEligible()
      const expectedTransferIds = [proof.transferId]
      for (const leg of state.legs) {
        const recipient = plan.recipients.find(
          (entry) => entry.legId === leg.legId
        )
        if (!recipient || !leg.intent || leg.allocationSats === null) return
        const target: CheckoutSparkSettledOutgoingTarget = {
          walletId: plan.walletId,
          network: plan.network,
          legId: leg.legId,
          recipientId: recipient.recipientId,
          allocationSats: leg.allocationSats,
          unpaidAllocationSats: leg.allocationSats,
          ...(getCheckoutSparkSettledLegGeneration(leg) === 1
            ? { generation: 1 as const }
            : {}),
          intent: leg.intent,
        }
        await (
          repository.assertInvoiceRecipient ??
          repository.assertLocalInvoiceOrigin
        ).call(repository, plan, target, assertEligible)
        assertEligible()
        const observation = await inspectExactMerchantPayout(
          plan,
          target,
          observedWallet,
          assertEligible
        )
        assertEligible()
        if (
          observation.status !== "paid" ||
          observation.finalFeeSats !== leg.finalFeeSats ||
          observation.finalDebitSats !== leg.finalDebitSats
        )
          return
        await repository.recordMerchantPayout(
          plan,
          target,
          observation,
          now(),
          assertEligible
        )
        assertEligible()
        expectedTransferIds.push(leg.intent.transferId)
      }
      const closedReturnedProofs: CheckoutSparkSettledClosedReturnedProof[] = []
      for (const leg of state.legs) {
        if (!getCheckoutSparkSettledClosedGeneration(leg)) continue
        try {
          closedReturnedProofs.push(
            await proveMerchantCheckoutSparkClosedReturnedPayout(
              state,
              leg.legId,
              wallet,
              assertEligible,
              now
            )
          )
        } catch {
          assertEligible()
          return
        }
      }
      const session = await wallet.openRetirementReader()
      assertEligible()
      const evidence = await collectCheckoutSparkNativeRetirementEvidence({
        authenticatedReader: session.reader,
        sparkAddress: session.sparkAddress,
        walletId: plan.walletId,
        network: plan.network,
        stateUpdatedAt: state.updatedAt,
        expectedTransferIds,
        ...(closedReturnedProofs.length > 0 ? { closedReturnedProofs } : {}),
        now,
        assertCurrent: assertEligible,
      })
      assertEligible()
      if (!evidence) return
      await repository.retire({
        checkoutId: plan.checkoutId,
        planDigest: plan.planDigest,
        expectedRevision: saved.revision,
        evidence,
        assertCurrent: assertEligible,
      })
      assertEligible()
      retirementStatus = "retired"
    } finally {
      await wallet.cleanup()
    }
  }
  dependencies.assertActive?.()
  return runWithCheckoutSparkMerchantRecoveryLock(
    selected.planDigest,
    async () => {
      dependencies.assertActive?.()
      const result = await consumeRecovery(principal, selected, {
        async consume(initial, assertCurrent) {
          if (initial.schemaVersion !== 2)
            throw new Error(
              "An older checkout recovery cannot retire a settled wallet."
            )
          await retire(initial, initial.state, assertCurrent)
        },
        async consumeSettled(initial, latest, assertCurrent) {
          await retire(initial, latest.state, assertCurrent)
        },
        async consumeMerchantProgress(
          initial,
          _latestBuyer,
          progress,
          assertCurrent
        ) {
          await retire(initial, progress.state, assertCurrent)
        },
      })
      return {
        ...result,
        retirementStatus:
          result.status === "consumed" ? retirementStatus : null,
      }
    },
    dependencies.lockManager,
    dependencies.requireCrossTabLock
  )
}

const TERMINAL_LIGHTNING_SEND_FAILURES = new Set([
  "USER_TRANSFER_VALIDATION_FAILED",
  "LIGHTNING_PAYMENT_FAILED",
  "PREIMAGE_PROVIDING_FAILED",
  "TRANSFER_FAILED",
  "USER_SWAP_RETURNED",
  "USER_SWAP_RETURN_FAILED",
])

/** Read only one frozen transfer ID; absence never proves a different payout. */
export async function inspectExactMerchantPayout(
  plan: CheckoutSparkSettledPlan,
  target: CheckoutSparkSettledOutgoingTarget,
  wallet: MerchantSparkRecoveryWallet,
  assertEligible: () => void
): Promise<CheckoutSparkSettledOutgoingObservation> {
  const unavailable = () =>
    checkoutSparkSettledOutgoingStatusObservation(target, "lookup_unavailable")
  const conflicting = () =>
    checkoutSparkSettledOutgoingStatusObservation(
      target,
      "conflicting_evidence"
    )
  const request = requireCheckoutSparkSettledExactOutgoingRequest(plan, target)
  if (!wallet.getTransferFromSsp || !wallet.getLightningSendRequest) {
    return unavailable()
  }
  let transfer: Awaited<
    ReturnType<NonNullable<typeof wallet.getTransferFromSsp>>
  >
  try {
    transfer = await wallet.getTransferFromSsp(request.transferId)
  } catch {
    assertEligible()
    return unavailable()
  }
  assertEligible()
  if (!transfer) {
    return checkoutSparkSettledOutgoingStatusObservation(target, "not_found")
  }
  if (transfer.userRequest === undefined || transfer.userRequest === null) {
    return unavailable()
  }
  let recovered: ReturnType<typeof readExactSparkLightningRecoveredTransfer>
  try {
    recovered = readExactSparkLightningRecoveredTransfer({
      transferId: request.transferId,
      paymentRequest: request.paymentRequest,
      transfer,
    })
  } catch {
    return conflicting()
  }
  let native: Awaited<
    ReturnType<NonNullable<typeof wallet.getLightningSendRequest>>
  >
  try {
    native = await wallet.getLightningSendRequest(recovered.request.id)
  } catch {
    assertEligible()
    return unavailable()
  }
  assertEligible()
  if (!native) return unavailable()
  try {
    // The fresh request must match the exact transfer's frozen identity and
    // invoice, not merely report a plausible status for another payment.
    const fresh = readExactSparkLightningRecoveredTransfer({
      transferId: request.transferId,
      paymentRequest: request.paymentRequest,
      transfer: { ...transfer, userRequest: native },
    }).request
    const finalDebitSats = verifyExactSparkLightningRequestDebit({
      requestId: recovered.request.id,
      amountSats: request.amountSats,
      maxFeeSats: request.maxFeeSats,
      totalAmount: recovered.totalAmount,
      request: fresh,
    })
    const feeSats = finalDebitSats - request.amountSats
    const status = fresh.paymentPreimage
      ? "completed"
      : TERMINAL_LIGHTNING_SEND_FAILURES.has(fresh.status)
        ? "failed"
        : "pending"
    return classifyCheckoutSparkSettledExactOutgoingHistory(target, {
      status: "resolved",
      payment: {
        status,
        fees: BigInt(feeSats),
        details: {
          type: "lightning",
          ...(fresh.paymentPreimage
            ? {
                htlcDetails: {
                  paymentHash: target.intent.paymentHash,
                  preimage: fresh.paymentPreimage,
                },
              }
            : {}),
        },
      },
      verifiedTransferTotalSats: finalDebitSats,
    })
  } catch {
    return conflicting()
  }
}

/**
 * Post-takeover Merchant history inspection. Only existing frozen intents are
 * queried. No invoice is obtained and the wallet interface has no send method.
 */
export async function inspectMerchantCheckoutSparkSettledPayoutHistory(
  principalPubkey: string,
  selected: MerchantCheckoutSparkRecoveryCandidate,
  dependencies: RecoveryHistoryDependencies = {}
): Promise<MerchantCheckoutSparkPayoutHistoryResult> {
  const principal = principalPubkey.trim().toLowerCase()
  const repository =
    dependencies.repository ?? new DexieCheckoutSparkSettledRepository()
  const deriveIdentity =
    dependencies.deriveIdentity ?? deriveMerchantCheckoutSparkRecoveryIdentity
  const openWallet =
    dependencies.openWallet ?? openMerchantCheckoutSparkRecoveryWallet
  const now = dependencies.now ?? Date.now
  let payoutHistory: MerchantCheckoutSparkPayoutHistory | null = null

  const inspect = async (
    initial: CheckoutSparkSettledRecoveryPayload,
    state: CheckoutSparkSettledReconciliation,
    assertCurrent: () => void
  ) => {
    const assertEligible = () => {
      dependencies.assertActive?.()
      assertCurrent()
      if (now() < initial.plan.takeoverAt) {
        throw new Error("Merchant checkout takeover is not yet available.")
      }
    }
    assertEligible()
    assertMerchantSnapshot({ principalPubkey: principal, initial, state })
    assertExpectedOrderWitness(dependencies.expectedOrderWitness, initial)
    const plan = initial.plan
    const imported = await repository.load(plan.checkoutId, plan.planDigest)
    assertEligible()
    if (
      imported.status !== "active" ||
      imported.state.plan.merchantPubkey !== principal ||
      imported.state.plan.planDigest !== plan.planDigest ||
      imported.state.plan.walletId !== initial.wallet.walletId ||
      imported.state.plan.network !== initial.wallet.network
    ) {
      throw new Error("Save the exact checkout recovery state first.")
    }
    assertCheckoutSparkSettledRecoveryProgression(state, imported.state)
    const withoutIntentLegs = imported.state.legs.filter(
      (leg) => leg.intent === null
    ).length
    const frozenLegs = imported.state.legs.filter((leg) => leg.intent !== null)
    const base = {
      checkedLegs: 0,
      newlyConfirmedLegs: 0,
      unresolvedLegs: 0,
      withoutIntentLegs,
      alreadyPaidLegs: 0,
    }
    if (!imported.state.credit) {
      payoutHistory = { ...base, status: "credit_needed" }
      return
    }
    if (frozenLegs.length === 0) {
      payoutHistory = { ...base, status: "no_intents" }
      return
    }

    const derivedIdentity = await deriveIdentity(
      initial.wallet.mnemonic,
      initial.wallet.accountNumber
    )
    assertEligible()
    if (
      !/^(02|03)[0-9a-f]{64}$/.test(derivedIdentity) ||
      derivedIdentity !== plan.funding.receiverIdentityPublicKey
    ) {
      throw new Error("Checkout Spark recovery key does not match funding.")
    }
    const wallet = await openWallet({
      mnemonic: initial.wallet.mnemonic,
      accountNumber: initial.wallet.accountNumber,
      network: initial.wallet.network,
    })
    try {
      assertEligible()
      await wallet.ensurePrivateReady()
      assertEligible()
      const walletIdentity = (await wallet.getIdentityPublicKey()).toLowerCase()
      assertEligible()
      if (walletIdentity !== derivedIdentity) {
        throw new Error("Checkout Spark wallet identity changed.")
      }
      const summary = { ...base }
      for (const leg of frozenLegs) {
        assertEligible()
        if (leg.status === "paid") {
          const recipient = plan.recipients.find(
            (candidate) => candidate.legId === leg.legId
          )
          if (leg.allocationSats === null || !leg.intent || !recipient) {
            throw new Error("Checkout Spark paid leg is incomplete.")
          }
          const target: CheckoutSparkSettledOutgoingTarget = {
            walletId: plan.walletId,
            network: plan.network,
            legId: leg.legId,
            recipientId: recipient.recipientId,
            allocationSats: leg.allocationSats,
            // History-only validation needs the allocation that would have
            // been reserved before a send, not today's remaining wallet funds.
            unpaidAllocationSats: leg.allocationSats,
            ...(getCheckoutSparkSettledLegGeneration(leg) === 1
              ? { generation: 1 as const }
              : {}),
            intent: leg.intent,
          }
          const observation = await inspectExactMerchantPayout(
            plan,
            target,
            wallet,
            assertEligible
          )
          assertEligible()
          summary.checkedLegs += 1
          if (
            observation.status === "paid" &&
            observation.finalFeeSats === leg.finalFeeSats &&
            observation.finalDebitSats === leg.finalDebitSats
          ) {
            await repository.recordMerchantPayout(
              plan,
              target,
              observation,
              now(),
              assertEligible
            )
            assertEligible()
            summary.alreadyPaidLegs += 1
          } else {
            summary.unresolvedLegs += 1
          }
          continue
        }
        const step = await runCheckoutSparkSettledOutgoingStep({
          checkoutId: plan.checkoutId,
          planDigest: plan.planDigest,
          legId: leg.legId,
          actor: "merchant",
          inspectionOnly: true,
          now,
          store: {
            async load(checkoutId, planDigest) {
              assertEligible()
              const current = await repository.load(checkoutId, planDigest)
              assertEligible()
              if (
                current.status !== "active" ||
                current.state.plan.merchantPubkey !== principal ||
                current.state.plan.planDigest !== plan.planDigest ||
                current.state.plan.walletId !== initial.wallet.walletId ||
                current.state.plan.network !== initial.wallet.network
              ) {
                throw new CheckoutSparkSettledRepositoryConflictError()
              }
              assertCheckoutSparkSettledRecoveryProgression(
                state,
                current.state
              )
              return current
            },
            async save(next, revision) {
              assertEligible()
              const saved = await repository.save(
                next,
                revision,
                assertEligible
              )
              assertEligible()
              return saved
            },
          },
          provider: {
            async reconcile(target) {
              assertEligible()
              const observed = await inspectExactMerchantPayout(
                plan,
                target,
                wallet,
                assertEligible
              )
              assertEligible()
              if (observed.status === "paid") {
                await repository.recordMerchantPayout(
                  plan,
                  target,
                  observed,
                  now(),
                  assertEligible
                )
                assertEligible()
              }
              summary.checkedLegs += 1
              return observed
            },
            async preflight() {
              throw new Error("Merchant inspection cannot preflight a payout.")
            },
            async send() {
              throw new Error("Merchant inspection cannot send a payout.")
            },
          },
          async acknowledgeRecoverySnapshot() {
            throw new Error("Merchant inspection cannot publish recovery.")
          },
        })
        assertEligible()
        if (step.outcome === "paid") {
          summary.newlyConfirmedLegs += 1
        } else {
          summary.unresolvedLegs += 1
        }
      }
      payoutHistory = { ...summary, status: "inspected" }
    } finally {
      await wallet.cleanup()
    }
  }

  const operation = async () => {
    dependencies.assertActive?.()
    const result = await withMerchantCheckoutSparkRecovery(
      principal,
      selected,
      {
        async consume(payload, assertCurrent) {
          if (payload.schemaVersion !== 2) {
            throw new Error("An older checkout recovery has no payout history.")
          }
          await inspect(payload, payload.state, assertCurrent)
        },
        async consumeSettled(initial, latest, assertCurrent) {
          await inspect(initial, latest.state, assertCurrent)
        },
        async consumeMerchantProgress(
          initial,
          _latestBuyer,
          progress,
          assertCurrent
        ) {
          dependencies.assertActive?.()
          await assertAuthenticatedMerchantProgressOrder({
            repository,
            principalPubkey: principal,
            initial,
            assertCurrent,
          })
          dependencies.assertActive?.()
          await inspect(initial, progress.state, assertCurrent)
        },
      }
    )
    return {
      ...result,
      payoutHistory: result.status === "consumed" ? payoutHistory : null,
    }
  }
  dependencies.assertActive?.()
  return runWithCheckoutSparkMerchantRecoveryLock(
    selected.planDigest,
    async () => {
      dependencies.assertActive?.()
      return operation()
    },
    dependencies.lockManager,
    dependencies.requireCrossTabLock
  )
}
