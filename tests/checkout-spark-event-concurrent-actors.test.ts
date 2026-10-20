import { expect, it } from "bun:test"
import { ConduitDB } from "@conduit/core/db"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { getEventHash } from "nostr-tools"
import {
  CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG,
  buildEventMarketOrderRumorTags,
  createCheckoutSparkMerchantOrderWitness,
  createCheckoutSparkMerchantProgress,
  createInMemoryInboxDeclarationEvidenceRepository,
  DexieCheckoutSparkSettledRepository,
  DexieMerchantCheckoutSparkProgressRepository,
  publishMerchantCheckoutSparkProgress,
  readCheckoutSparkMerchantOrderEvidence,
  recordCheckoutSparkSettledCredit,
} from "@conduit/core"
import {
  assertCheckoutSparkSettledRecoveryProgression,
  CheckoutSparkSettledRepositoryConflictError,
} from "@conduit/core/protocol/checkout-spark-settled-router-repository"
import {
  runCheckoutSparkFinancialWorkflow,
  type CheckoutSparkFinancialWorkflowPorts,
} from "@conduit/core/protocol/checkout-spark-financial-workflow"
import { createCheckoutSparkSettledNativeOutgoingProvider } from "@conduit/core/protocol/checkout-spark-settled-native-outgoing"
import { classifyCheckoutSparkSettledExactOutgoingHistory } from "@conduit/core/protocol/checkout-spark-settled-outgoing-history"
import { assertCheckoutSparkSettledMerchantPreparationWindow } from "@conduit/core/protocol/checkout-spark-settled-leg-preparation"
import type { CheckoutSparkSettledReconciliation } from "@conduit/core/protocol/checkout-spark-settled-router"
import type { CheckoutSparkSettledOutgoingTarget } from "@conduit/core/protocol/checkout-spark-settled-outgoing"
import {
  createCheckoutSparkOrganizerExecutionProgress,
  DexieCheckoutSparkOrganizerProgressRepository,
  publishCheckoutSparkOrganizerExecutionProgress,
} from "@conduit/core/protocol/checkout-spark-organizer-progress"
import {
  assertCheckoutSparkOrganizerRecoveryWriterCurrent,
  openCheckoutSparkOrganizerRecoveryAuthority,
} from "@conduit/core/protocol/checkout-spark-organizer-execution"
import {
  createCheckoutSparkOrganizerRecoveryPayload,
  buildCheckoutSparkOrganizerRecoveryRumor,
} from "@conduit/core/protocol/checkout-spark-organizer-recovery"
import { orderSchema } from "@conduit/core/schemas"
import { acceptCheckoutSparkOrganizerStockOrder } from "@conduit/core/protocol/event-market-stock-handout"
import {
  wrapPrivateMessage,
  unwrapPrivateMessageEnvelope,
} from "@conduit/core/protocol/private-message-primitives"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"
import { resolveCheckoutSparkFixtureInvoice } from "./support/checkout-spark-invoice-origin"
import { admitFixture } from "./helpers/public-event"

/**
 * Two real independent repositories and the actual Core preparation/execution
 * modules. External receiver issuance, relay ACKs and Spark's same-ID economic
 * deduplication are controlled adapters, not evidence of a deployed provider's
 * enforcement. Both actors may prepare different invoices before seeing the
 * other's progress; a provider winner must never make the loser replay/mint.
 */
for (const winnerRole of ["merchant", "organizer"] as const) {
  it(`keeps independent concurrent actor payouts on one provider ID when ${winnerRole} wins and pauses the divergent loser without replay`, async () => {
    let stage = "setup"
    let fixture:
      Awaited<ReturnType<typeof checkoutSparkOrganizerFixture>> | undefined
    let merchantDb: ConduitDB | undefined
    let releaseSends: (() => void) | undefined
    let releaseWinner: (() => void) | undefined
    let sendTimer: ReturnType<typeof setTimeout> | undefined
    try {
      fixture = await checkoutSparkOrganizerFixture({
        commerceTotalSats: 1_000,
        receiverDomain: "wallet.conduit.market",
      })
      const f = fixture
      const { plan } = f
      const order = orderSchema.parse({
        ...f.order,
        buyerIdentityKind: "signed_in",
        shippingCostStatus: "included",
      })
      const initial = createCheckoutSparkOrganizerRecoveryPayload({
        merchantRecovery: f.merchantRecovery,
        order,
      })
      const initialWrap = await wrapPrivateMessage(
        buildCheckoutSparkOrganizerRecoveryRumor(initial),
        { pubkey: f.organizerPubkey },
        f.buyerSigner
      )
      const organizerAuthority =
        await openCheckoutSparkOrganizerRecoveryAuthority({
          ...f.authorityInput,
          initialWrap,
        })
      const relays = ["wss://relay.conduit.market"]
      const declarations = createInMemoryInboxDeclarationEvidenceRepository()
      for (const [pubkey, sign] of [
        [f.merchantPubkey, f.signMerchant],
        [f.organizerPubkey, f.signOrganizer],
      ] as const) {
        await declarations.merge({
          pubkey,
          observedAt: Date.now(),
          signedEvent: await admitFixture(
            sign({
              kind: 10050,
              tags: [["relay", relays[0]!]],
              content: "",
              created_at: Math.floor(Date.now() / 1_000),
            })
          ),
        })
      }
      const transport = {
        recipientInboxRelays: relays,
        resolveInboxRelays: async () => relays,
        inboxDeclarationEvidenceRepository: declarations,
        accountNetworkLocalStateRepository: { get: async () => undefined },
        publishFn: async () => ({
          attemptedRelayUrls: relays,
          successfulRelayUrls: relays,
          failedRelayUrls: [],
          relayFailureMessages: {},
        }),
      }
      stage = "authenticated Organizer stock reservation"
      await acceptCheckoutSparkOrganizerStockOrder({
        db: f.database,
        authority: organizerAuthority,
        signer: f.organizerSigner,
        authenticatedPubkey: f.organizerPubkey,
        shouldContinue: () => f.clock.active,
        delivery: transport,
        nowMs: f.clock.now,
      })
      stage = "authenticated original Merchant order"
      const draft = {
        kind: 16,
        pubkey: f.buyerSigner.pubkey,
        created_at: Math.floor(order.createdAt / 1_000),
        tags: [
          ["p", f.merchantPubkey],
          ["type", "order"],
          ["order", order.id],
          ["amount", String(order.subtotal)],
          ["currency", "SATS"],
          ["item", order.items[0]!.productId, "1"],
          [...CHECKOUT_SPARK_EVENT_ROUTER_ORDER_TAG],
          ...buildEventMarketOrderRumorTags(order),
        ],
        content: JSON.stringify(order),
      }
      const envelope = await wrapPrivateMessage(
        { ...draft, id: getEventHash(draft) },
        { pubkey: f.merchantPubkey },
        f.buyerSigner
      )
      const evidence = readCheckoutSparkMerchantOrderEvidence(
        await unwrapPrivateMessageEnvelope(envelope, f.merchantSigner)
      )
      if (!evidence) throw new Error("Original Order evidence unavailable")
      const witness = createCheckoutSparkMerchantOrderWitness(
        plan,
        evidence,
        f.buyerSigner.pubkey,
        f.sourceEvents
      )
      if (!witness) throw new Error("Original Order witness unavailable")
      const funded = recordCheckoutSparkSettledCredit(
        f.merchantRecovery.state,
        {
          requestId: plan.funding.requestId,
          paymentHash: plan.funding.paymentHash,
          transferId: crypto.randomUUID(),
          receiverIdentityPublicKey: plan.funding.receiverIdentityPublicKey,
          grossSats: plan.funding.grossFundingSats,
          creditedSats: plan.funding.grossFundingSats,
          observedAt: plan.createdAt + 1_000,
        }
      )
      merchantDb = new ConduitDB(
        `event-concurrent-merchant-${crypto.randomUUID()}`,
        {
          indexedDB,
          IDBKeyRange,
        }
      )
      const organizerRepository = new DexieCheckoutSparkSettledRepository(
        f.database
      )
      const merchantRepository = new DexieCheckoutSparkSettledRepository(
        merchantDb
      )
      await organizerRepository.importRecoveryState(funded, () => {})
      await merchantRepository.importMerchantOrderRecovery(
        funded,
        witness,
        () => {}
      )
      await Promise.all([
        organizerRepository.recordMerchantPlanSources(
          plan,
          f.sourceEvents,
          () => {}
        ),
        merchantRepository.recordMerchantPlanSources(
          plan,
          f.sourceEvents,
          () => {}
        ),
      ])
      expect(
        organizerRepository.outgoingAdmissionScope ===
          merchantRepository.outgoingAdmissionScope
      ).toBe(false)
      const organizerProgress =
        new DexieCheckoutSparkOrganizerProgressRepository(f.database)
      const merchantProgress = new DexieMerchantCheckoutSparkProgressRepository(
        merchantDb
      )
      const issued = new Map<
        string,
        ReturnType<typeof qualifiedReceiverFixture>
      >()
      const invoiceAmounts = new Map<string, number>()
      let invoiceCount = 0
      const sendRequests: Array<{
        paymentRequest: string
        maxFeeSats: number
        transferId: string
      }> = []
      // This map simulates the external provider's identity/method/transfer-ID
      // deduplication. It is intentionally NOT a shared client repository/lock.
      const economicPayments = new Map<string, (typeof sendRequests)[number]>()
      const bothSending = new Promise<void>((resolve, reject) => {
        releaseSends = resolve
        sendTimer = setTimeout(
          () => reject(new Error("Both actor sends did not arrive")),
          15_000
        )
      })
      const winnerCommitted = new Promise<void>((resolve) => {
        releaseWinner = resolve
      })
      const checked = async (role: "merchant" | "organizer") => {
        if (
          !f.clock.active ||
          (await (
            role === "organizer" ? f.organizerSigner : f.merchantSigner
          ).getPublicKey()) !==
            (role === "organizer" ? f.organizerPubkey : f.merchantPubkey)
        )
          throw new Error("Financial actor session changed")
        if (role === "organizer")
          await assertCheckoutSparkOrganizerRecoveryWriterCurrent(
            organizerAuthority
          )
        else if (
          !(await merchantRepository.loadMerchantOrderWitness(
            f.merchantPubkey,
            plan.checkoutId,
            plan.planDigest
          ))
        )
          throw new Error("Original Merchant witness unavailable")
      }
      const ack = async (
        role: "merchant" | "organizer",
        state: CheckoutSparkSettledReconciliation
      ) => {
        await checked(role)
        if (role === "organizer") {
          const result = await publishCheckoutSparkOrganizerExecutionProgress({
            payload: createCheckoutSparkOrganizerExecutionProgress({
              initialHandoffId: initial.handoffId,
              initialMerchantHandoffId: f.merchantRecovery.handoffId,
              organizerPubkey: f.organizerPubkey,
              orderBinding: initial.orderBinding,
              writerBindings: [
                { poolId: f.stockGrant!.id, writerId: f.writerId, quantity: 1 },
              ],
              state,
            }),
            signer: f.organizerSigner,
            store: organizerProgress,
            transport,
            shouldContinue: () => f.clock.active,
          })
          if (!result.merchantAccepted || !result.selfAccepted)
            throw new Error("Organizer checkpoint not acknowledged")
        } else {
          const result = await publishMerchantCheckoutSparkProgress({
            payload: createCheckoutSparkMerchantProgress({
              initialHandoffId: f.merchantRecovery.handoffId,
              state,
            }),
            signer: f.merchantSigner,
            store: merchantProgress,
            transport,
            shouldContinue: () => f.clock.active,
          })
          if (!result.relayAccepted)
            throw new Error("Merchant checkpoint not acknowledged")
        }
      }
      const actors = (["organizer", "merchant"] as const).map((role) => {
        const repository =
          role === "organizer" ? organizerRepository : merchantRepository
        const inspect = async (target: CheckoutSparkSettledOutgoingTarget) => {
          const paid = economicPayments.get(target.intent.transferId)
          if (!paid)
            return classifyCheckoutSparkSettledExactOutgoingHistory(target, {
              status: "not_found",
            })
          const receiver = issued.get(paid.paymentRequest)
          if (!receiver)
            throw new Error("Controlled provider invoice unavailable")
          return classifyCheckoutSparkSettledExactOutgoingHistory(target, {
            status: "resolved",
            payment: {
              status: "completed",
              fees: 1n,
              details: {
                type: "lightning",
                htlcDetails: {
                  paymentHash: receiver.paymentHash,
                  preimage: receiver.preimage,
                },
              },
            },
            verifiedTransferTotalSats:
              invoiceAmounts.get(paid.paymentRequest)! + 1,
          })
        }
        let sending: CheckoutSparkSettledOutgoingTarget | undefined
        const provider = createCheckoutSparkSettledNativeOutgoingProvider({
          plan,
          now: () => f.clock.now,
          reconcile: inspect,
          assertBeforeSend: async () => {
            await checked(role)
            if (!sending) throw new Error("Exact payout target unavailable")
            await repository.assertInvoiceRecipient(plan, sending, () => {})
          },
          wallet: {
            getAvailableSats: async () => BigInt(plan.funding.grossFundingSats),
            estimateFee: async () => 1,
            sendFrozen: async (request) => {
              sendRequests.push(structuredClone(request))
              if (sendRequests.length === 2) {
                clearTimeout(sendTimer)
                releaseSends!()
              }
              await bothSending
              // Exercise either external provider ordering without changing the
              // client executor or feeding either actor a synthesized result.
              if (role !== winnerRole) await winnerCommitted
              if (!economicPayments.has(request.transferId))
                economicPayments.set(
                  request.transferId,
                  structuredClone(request)
                )
              if (role === winnerRole) releaseWinner!()
            },
          },
        })
        const ports: CheckoutSparkFinancialWorkflowPorts = {
          store: repository,
          assertCurrent: () => checked(role),
          now: () => ++f.clock.now,
          acknowledgeRecoverySnapshot: (state) => ack(role, state),
          preparation: {
            repository,
            nowMs: () => f.clock.now,
            assertAuthority: (state, time) =>
              assertCheckoutSparkSettledMerchantPreparationWindow(state, time),
            acknowledgeRecoverySnapshot: (state) => ack(role, state),
            estimateFee: async () => 1,
            resolveInvoice: async (request) => {
              const receiver = qualifiedReceiverFixture({
                lud16: request.lud16,
                amountSats: request.amountSats,
                nowSeconds: request.nowSeconds,
                preimageByte: ++invoiceCount,
              })
              issued.set(receiver.paymentRequest, receiver)
              invoiceAmounts.set(receiver.paymentRequest, request.amountSats)
              return resolveCheckoutSparkFixtureInvoice(
                request,
                receiver.paymentRequest
              )
            },
          },
          outgoing: {
            reconcile: provider.reconcile,
            preflight: (target) => {
              sending = target
              return provider.preflight(target)
            },
            send: (target) => {
              sending = target
              return provider.send(target)
            },
          },
        }
        const run = (mode: "prepare" | "advance") =>
          runCheckoutSparkFinancialWorkflow(
            {
              checkoutId: plan.checkoutId,
              planDigest: plan.planDigest,
              legId: plan.recipients[0]!.legId,
              actor: "merchant",
              mode,
            },
            ports
          )
        return { role, repository, run }
      })
      stage = "independent simultaneous payout preparation"
      const preparations = await Promise.all(
        actors.map((actor) => actor.run("prepare"))
      )
      expect(
        preparations.every((result) => result.status === "payout_prepared")
      ).toBe(true)
      const before = await Promise.all(
        actors.map((actor) =>
          actor.repository.load(plan.checkoutId, plan.planDigest)
        )
      )
      if (before[0]!.status !== "active" || before[1]!.status !== "active")
        throw new Error("Prepared actor state unavailable")
      const intents = before.map((snapshot) =>
        snapshot.status === "active" ? snapshot.state.legs[0]!.intent! : null
      )
      expect(intents[0]!.paymentRequest !== intents[1]!.paymentRequest).toBe(
        true
      )
      expect(intents[0]!.paymentHash !== intents[1]!.paymentHash).toBe(true)
      expect(intents[0]!.transferId === intents[1]!.transferId).toBe(true)
      const invoicesBeforeSend = invoiceCount
      stage = "concurrent provider submission"
      await Promise.all(actors.map((actor) => actor.run("advance")))
      expect(sendRequests.length).toBe(2)
      expect(sendRequests[0]!.transferId === sendRequests[1]!.transferId).toBe(
        true
      )
      expect(
        sendRequests[0]!.paymentRequest !== sendRequests[1]!.paymentRequest
      ).toBe(true)
      expect(economicPayments.size).toBe(1)
      const after = await Promise.all(
        actors.map((actor) =>
          actor.repository.load(plan.checkoutId, plan.planDigest)
        )
      )
      const paidIndex = after.findIndex(
        (snapshot) =>
          snapshot.status === "active" &&
          snapshot.state.legs[0]!.status === "paid"
      )
      expect(paidIndex >= 0).toBe(true)
      expect(actors[paidIndex]!.role === winnerRole).toBe(true)
      const loserIndex = paidIndex === 0 ? 1 : 0
      const winner = after[paidIndex]!
      const loser = after[loserIndex]!
      if (winner.status !== "active" || loser.status !== "active")
        throw new Error("Resulting actor state unavailable")
      // Provider entry happened, so the losing invoice keeps its durable possible-
      // send marker. A conflicting observation must not erase that evidence.
      expect(loser.state.legs[0]!.status === "submitted").toBe(true)
      expect(
        loser.state.legs[0]!.intent!.paymentRequest ===
          intents[loserIndex]!.paymentRequest
      ).toBe(true)
      stage = "divergent history replay protection"
      expect(() =>
        assertCheckoutSparkSettledRecoveryProgression(loser.state, winner.state)
      ).toThrow(CheckoutSparkSettledRepositoryConflictError)
      for (let retry = 0; retry < 2; retry++) {
        const result = await actors[loserIndex]!.run("advance")
        expect(
          result.status === "outgoing_step" &&
            result.step.outcome === "wait" &&
            result.step.reason === "provider_evidence_conflicting" &&
            !result.step.sendAttempted
        ).toBe(true)
      }
      expect(sendRequests.length).toBe(2)
      expect(economicPayments.size).toBe(1)
      expect(invoiceCount).toBe(invoicesBeforeSend)
      expect(actors[0]!.role !== actors[1]!.role).toBe(true)
    } catch {
      // Never expose invoice, journal, identity, wrapper or recovery material.
      throw new Error(
        `Event concurrent-actor regression failed during ${stage}.`
      )
    } finally {
      clearTimeout(sendTimer)
      releaseSends?.()
      releaseWinner?.()
      if (merchantDb) await merchantDb.delete()
      if (fixture) await fixture.database.delete()
    }
  }, 90_000)
}
