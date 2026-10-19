import { describe, expect, it } from "bun:test"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { readFileSync } from "node:fs"
import {
  createCheckoutSparkSettledReconciliation,
  recordCheckoutSparkSettledCredit,
  type CheckoutSparkSettledRepositorySnapshot,
  type SignedPublicNostrEvent,
} from "@conduit/core"
import {
  getCheckoutSparkRecoveryDelivery,
  publishCheckoutSparkEventRecoveryHandoff,
  retryStoredCheckoutSparkRecoveryHandoff,
} from "../apps/market/src/lib/checkout-spark-recovery-handoff"
import { plainTestSigner } from "./helpers/plain-signer"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./support/checkout-spark-event-market-fixture"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import {
  CHECKOUT_SPARK_SETTLED_PREPARATION_STORAGE_KEY,
  writeStoredCheckoutSparkSettledPreparations,
} from "@conduit/core/wallets/checkout-spark-settled-preparation-storage"
import {
  canReplayCheckoutSparkOrderRecovery,
  replayCheckoutSparkOrderRecovery,
  type CheckoutSparkOrderRecoveryReplayDependencies,
} from "../apps/market/src/lib/checkout-spark-order-recovery-replay"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

async function fixture() {
  const graph = checkoutSparkEventMarketFixture({
    commerceTotalSats: 1_000,
    mode: "organizer_handoff",
    stockGrant: { writerId: crypto.randomUUID(), quantity: 2 },
  })
  const signer = plainTestSigner(NDKPrivateKeySigner.generate())
  const order = createCheckoutSparkEventMarketFixtureOrder(
    graph,
    signer.pubkey,
    AT
  )
  const state = createCheckoutSparkSettledReconciliation(graph.plan)
  const storage = new MemoryStorage()
  const published: SignedPublicNostrEvent[] = []
  const merchantRelays = ["wss://relay.damus.io"]
  const organizerRelays = ["wss://relay.primal.net"]
  const publish = (async (event, options) => {
    published.push(structuredClone(event))
    const relays = options.exclusiveRelayUrls ?? []
    return {
      attemptedRelayUrls: relays,
      successfulRelayUrls: relays,
      failedRelayUrls: [],
      relayFailureMessages: {},
    }
  }) as NonNullable<
    Parameters<typeof retryStoredCheckoutSparkRecoveryHandoff>[0]["publishFn"]
  >
  const handoff = await publishCheckoutSparkEventRecoveryHandoff({
    state,
    sourceEvents: graph.sourceEvents,
    order,
    recovery: {
      mnemonic: createRuntimeMnemonic(),
      accountNumber: 0,
      network: "mainnet",
    },
    identity: { kind: "signed_in", pubkey: signer.pubkey, signer },
    preparedAt: AT + 1_000,
    now: () => AT + 2_000,
    storage,
    transport: {
      recipientInboxRelays: merchantRelays,
      resolveInboxRelays: async () => merchantRelays,
      publishFn: publish,
    },
    organizerTransport: {
      recipientInboxRelays: organizerRelays,
      resolveInboxRelays: async () => organizerRelays,
      publishFn: publish,
    },
  })
  const saved = getCheckoutSparkRecoveryDelivery(handoff.handoffId, storage)!
  expect(saved.deliveryProgress.acknowledgedRelayRefs.length > 0).toBe(true)
  expect(saved.organizerDelivery!.acknowledgedRelayRefs.length > 0).toBe(true)
  published.length = 0
  const retry = (replayAcknowledged = false) =>
    retryStoredCheckoutSparkRecoveryHandoff({
      handoffId: handoff.handoffId,
      storage,
      recipientInboxRelays: merchantRelays,
      resolveInboxRelays: async () => merchantRelays,
      organizerTransport: {
        recipientInboxRelays: organizerRelays,
        resolveInboxRelays: async () => organizerRelays,
      },
      publishFn: publish,
      now: () => AT + 300_000,
      replayAcknowledged,
    })
  writeStoredCheckoutSparkSettledPreparations(
    [
      {
        schemaVersion: 3,
        checkoutId: graph.plan.checkoutId,
        planDigest: graph.plan.planDigest,
        recoveryHandoffId: handoff.handoffId,
        fundingInvoiceExposedAt: AT + 2_000,
        fundingSubmissionState: "provisional",
        savedAt: AT + 3_000,
      },
    ],
    storage
  )
  const principal = {
    pubkey: signer.pubkey,
    revision: "test-session",
    authMethod: "nip07" as const,
  }
  let currentPrincipal: typeof principal | undefined = principal
  let current = true
  let snapshot: CheckoutSparkSettledRepositorySnapshot = {
    status: "active",
    revision: 1,
    state: recordCheckoutSparkSettledCredit(state, {
      requestId: graph.plan.funding.requestId,
      paymentHash: graph.plan.funding.paymentHash,
      transferId: crypto.randomUUID(),
      receiverIdentityPublicKey: graph.plan.funding.receiverIdentityPublicKey,
      grossSats: graph.plan.funding.grossFundingSats,
      creditedSats: graph.plan.funding.grossFundingSats,
      observedAt: AT + 3_000,
    }),
  }
  let lifecycle = {
    orderId: graph.plan.orderId,
    buyerPubkey: signer.pubkey,
    merchantPubkey: graph.plan.merchantPubkey,
    buyerIdentityKind: "signed_in" as const,
    checkoutSparkRouterBinding: {
      checkoutId: graph.plan.checkoutId,
      planDigest: graph.plan.planDigest,
      walletId: graph.plan.walletId,
    },
  }
  const request = {
    ...lifecycle,
    ...lifecycle.checkoutSparkRouterBinding,
    storage,
    shouldContinue: () => current,
  }
  const dependencies: CheckoutSparkOrderRecoveryReplayDependencies = {
    readPrincipal: () => currentPrincipal,
    readLifecycle: async () => structuredClone(lifecycle),
    loadSnapshot: async () => snapshot,
    publishFn: publish,
    resolveInboxRelays: async (pubkey) =>
      pubkey === graph.merchantPubkey ? merchantRelays : organizerRelays,
    now: () => AT + 300_000,
  }
  return {
    graph,
    signer,
    state,
    order,
    storage,
    published,
    saved,
    handoff,
    retry,
    publish,
    merchantRelays,
    organizerRelays,
    request,
    dependencies,
    stop: () => {
      current = false
    },
    replaceSession: () => {
      currentPrincipal = { ...principal, revision: "replacement" }
    },
    signOut: () => {
      currentPrincipal = undefined
    },
    setSnapshot: (value: CheckoutSparkSettledRepositorySnapshot) => {
      snapshot = value
    },
    replaceLifecycle: () => {
      lifecycle = { ...lifecycle, orderId: crypto.randomUUID() }
    },
  }
}

describe("selected-order initial recovery delivery replay", () => {
  it("keeps acknowledged automatic retries silent but explicitly replays the identical two recipient wraps", async () => {
    const f = await fixture()
    await f.retry()
    expect(f.published.length).toBe(0)
    await f.retry(true)
    expect(f.published.length).toBe(2)
    expect(f.published[0]!.id === f.saved.record.signedRecipientWrap.id).toBe(
      true
    )
    expect(
      f.published[1]!.id === f.saved.organizerDelivery!.signedRecipientWrap.id
    ).toBe(true)
    expect(
      JSON.stringify(f.published[0]) ===
        JSON.stringify(f.saved.record.signedRecipientWrap)
    ).toBe(true)
    expect(
      JSON.stringify(f.published[1]) ===
        JSON.stringify(f.saved.organizerDelivery!.signedRecipientWrap)
    ).toBe(true)
  })
  it("replays only the selected funded Event order after buyer authority ends, without changing preparation or invoices", async () => {
    const f = await fixture()
    const preparation = f.storage.getItem(
      CHECKOUT_SPARK_SETTLED_PREPARATION_STORAGE_KEY
    )
    expect(
      await canReplayCheckoutSparkOrderRecovery(f.request, f.dependencies)
    ).toBe(true)
    expect(
      await replayCheckoutSparkOrderRecovery(f.request, f.dependencies)
    ).toEqual({ status: "relay_accepted" })
    expect(f.published.length).toBe(2)
    expect(f.published.map((event) => event.id)).toEqual([
      f.saved.record.signedRecipientWrap.id,
      f.saved.organizerDelivery!.signedRecipientWrap.id,
    ])
    expect(
      f.storage.getItem(CHECKOUT_SPARK_SETTLED_PREPARATION_STORAGE_KEY)
    ).toBe(preparation)
  })
  for (const mismatch of [
    "orderId",
    "checkoutId",
    "planDigest",
    "walletId",
    "buyerPubkey",
    "merchantPubkey",
  ] as const)
    it(`does not publish for a selected ${mismatch} mismatch`, async () => {
      const f = await fixture()
      const request = { ...f.request, [mismatch]: crypto.randomUUID() }
      expect(
        await canReplayCheckoutSparkOrderRecovery(request, f.dependencies)
      ).toBe(false)
      await expect(
        replayCheckoutSparkOrderRecovery(request, f.dependencies)
      ).rejects.toThrow()
      expect(f.published.length).toBe(0)
    })
  for (const state of ["unfunded", "absent", "retired"] as const)
    it(`does not publish for an ${state} checkout`, async () => {
      const f = await fixture()
      f.setSnapshot(
        state === "unfunded"
          ? { status: "active", revision: 1, state: f.state }
          : state === "absent"
            ? { status: "absent" }
            : {
                status: "retired",
                planDigest: f.graph.plan.planDigest,
                retiredAt: AT + 4_000,
              }
      )
      await expect(
        replayCheckoutSparkOrderRecovery(f.request, f.dependencies)
      ).rejects.toThrow()
      expect(f.published.length).toBe(0)
    })
  for (const change of [
    "stop",
    "replaceSession",
    "signOut",
    "replaceLifecycle",
  ] as const)
    it(`rechecks ${change} after asynchronous reads before any publication`, async () => {
      const f = await fixture()
      const readLifecycle = f.dependencies.readLifecycle!
      f.dependencies.readLifecycle = async (orderId) => {
        const lifecycle = await readLifecycle(orderId)
        f[change]()
        return lifecycle
      }
      await expect(
        replayCheckoutSparkOrderRecovery(f.request, f.dependencies)
      ).rejects.toThrow()
      expect(f.published.length).toBe(0)
    })
  it("checks the same session again between the two deliveries", async () => {
    const f = await fixture()
    f.dependencies.publishFn = async (event, options) => {
      const result = await f.publish(event, options)
      f.replaceSession()
      return result
    }
    await expect(
      replayCheckoutSparkOrderRecovery(f.request, f.dependencies)
    ).rejects.toThrow()
    expect(f.published.length).toBe(1)
  })
  it("does not report fresh relay acceptance using the earlier ACKs", async () => {
    const f = await fixture()
    f.dependencies.publishFn = async (_event, options) => ({
      attemptedRelayUrls: options.exclusiveRelayUrls ?? [],
      successfulRelayUrls: [],
      failedRelayUrls: options.exclusiveRelayUrls ?? [],
      relayFailureMessages: {},
    })
    await expect(
      replayCheckoutSparkOrderRecovery(f.request, f.dependencies)
    ).rejects.toThrow("Recipient delivery completed without a relay ACK")
  })
  it("does not widen the action to a guest lifecycle", async () => {
    const f = await fixture()
    const readLifecycle = f.dependencies.readLifecycle!
    f.dependencies.readLifecycle = async (orderId) => ({
      ...(await readLifecycle(orderId))!,
      buyerIdentityKind: "guest_ephemeral",
    })
    expect(
      await canReplayCheckoutSparkOrderRecovery(f.request, f.dependencies)
    ).toBe(false)
    await expect(
      replayCheckoutSparkOrderRecovery(f.request, f.dependencies)
    ).rejects.toThrow()
    expect(f.published.length).toBe(0)
  })
  for (const change of [
    "missingOrganizer",
    "progressOnly",
    "differentSender",
  ] as const)
    it(`does not send a saved bundle with ${change}`, async () => {
      const f = await fixture()
      for (const [key, value] of f.storage.values) {
        const parsed = JSON.parse(value)
        if (!Array.isArray(parsed)) continue
        const entry = parsed.find(
          (item) => item.record?.handoffId === f.handoff.handoffId
        )
        if (!entry) continue
        if (change === "missingOrganizer") delete entry.organizerDelivery
        if (change === "progressOnly")
          entry.snapshotKey = f.graph.plan.planDigest
        if (change === "differentSender")
          entry.record.senderPubkey = f.graph.organizerPubkey
        f.storage.setItem(key, JSON.stringify(parsed))
      }
      expect(
        await canReplayCheckoutSparkOrderRecovery(f.request, f.dependencies)
      ).toBe(false)
      await expect(
        replayCheckoutSparkOrderRecovery(f.request, f.dependencies)
      ).rejects.toThrow()
      expect(f.published.length).toBe(0)
    })
  it("pins selected fields instead of following request mutations during a read", async () => {
    const f = await fixture()
    const readLifecycle = f.dependencies.readLifecycle!
    f.dependencies.readLifecycle = async (orderId) => {
      f.request.orderId = crypto.randomUUID()
      f.request.merchantPubkey = f.graph.organizerPubkey
      return readLifecycle(orderId)
    }
    expect(
      (await replayCheckoutSparkOrderRecovery(f.request, f.dependencies)).status
    ).toBe("relay_accepted")
    expect(f.published.length).toBe(2)
  })
  it("wires the actual Orders repair action outside routing and funding execution", () => {
    const source = readFileSync(
      new URL("../apps/market/src/routes/orders.tsx", import.meta.url),
      "utf8"
    )
    expect(
      source.includes(
        "recoveryReplayEligible && recoveryReplayQuery.data === true"
      )
    ).toBe(true)
    expect(source.includes("Resend saved recovery copies")).toBe(true)
    expect(
      source.includes(
        '<summary className="cursor-pointer">Recovery delivery</summary>'
      )
    ).toBe(true)
    const eligibility = source.slice(
      source.indexOf("const recoveryReplayEligible"),
      source.indexOf("const settledControlRefreshAt")
    )
    expect(eligibility.includes("!guestIdentity")).toBe(true)
    expect(eligibility.includes("!routerProgress")).toBe(true)
    expect(
      eligibility.includes('settledRouterControl.status !== "complete"')
    ).toBe(true)
    expect(
      eligibility.includes('settledRouterControl.status !== "retired"')
    ).toBe(true)
    expect(eligibility.includes("canReplayCheckoutSparkOrderRecovery(")).toBe(
      true
    )
    expect(eligibility.includes("isRouterSavedStateCurrent()")).toBe(true)
    expect(
      source.includes("onClick={() => void resendSelectedOrderRecovery()}")
    ).toBe(true)
    const action = source.slice(
      source.indexOf("async function resendSelectedOrderRecovery"),
      source.indexOf("async function verifyRetryFreshness")
    )
    expect(action.includes("routerActionInFlightRef.current = true")).toBe(true)
    expect(action.includes("routerActionInFlightRef.current = false")).toBe(
      true
    )
    expect(
      action
        .replace(/\s+/g, "")
        .includes(
          "replayCheckoutSparkOrderRecovery(recoveryReplayRequest(shouldContinue))"
        )
    ).toBe(true)
    expect(action.includes("runSettledRouterAction")).toBe(false)
    expect(action.includes("No payment was sent")).toBe(true)
    expect(
      action.indexOf("setRecoveryReplayNotice(null)") <
        action.indexOf("await replayCheckoutSparkOrderRecovery")
    ).toBe(true)
    const helper = readFileSync(
      new URL(
        "../apps/market/src/lib/checkout-spark-order-recovery-replay.ts",
        import.meta.url
      ),
      "utf8"
    )
    for (const paymentMethod of [
      "preparePayout",
      "payInvoice",
      "sendPayment",
      "deriveRecovery",
      "openCheckoutSpark",
      "encryptNip44",
      "signEvent(",
    ])
      expect(helper.includes(paymentMethod)).toBe(false)
  })
})
