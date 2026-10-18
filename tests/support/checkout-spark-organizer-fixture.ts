import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import { ConduitDB } from "@conduit/core/db"
import { SessionSigner } from "@conduit/core/protocol/session-signer"
import { wrapPrivateMessage } from "@conduit/core/protocol/private-message-primitives"
import { receiveOrganizerStockGrant } from "@conduit/core/protocol/event-market-stock-workflow"
import { createCheckoutSparkSettledRecoveryPayload } from "@conduit/core/protocol/checkout-spark-recovery"
import {
  createCheckoutSparkOrganizerRecoveryPayload,
  buildCheckoutSparkOrganizerRecoveryRumor,
} from "@conduit/core/protocol/checkout-spark-organizer-recovery"
import {
  createCheckoutSparkSettledReconciliation,
  type CheckoutSparkSettledPlan,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import { openCheckoutSparkOrganizerRecoveryAuthority } from "@conduit/core/protocol/checkout-spark-organizer-execution"
import {
  checkoutSparkEventMarketFixture,
  createCheckoutSparkEventMarketFixtureOrder,
  EVENT_MARKET_FIXTURE_AT as AT,
} from "./checkout-spark-event-market-fixture"
import { plainTestSigner } from "../helpers/plain-signer"
import { createRuntimeMnemonic } from "./runtime-wallet-fixtures"

/** Real account/session and NIP-59 cryptography, fake IndexedDB, no live funds. */
export async function checkoutSparkOrganizerFixture(
  options: {
    commerceTotalSats?: number
    supplier?: boolean
    receiverDomain?: string
    stockQuantity?: number
    wallet?: { mnemonic: string; accountNumber: number }
    preparePlan?: (
      graph: ReturnType<typeof checkoutSparkEventMarketFixture>
    ) => Promise<CheckoutSparkSettledPlan>
  } = {}
) {
  const writerId = crypto.randomUUID()
  const sourceGraph = checkoutSparkEventMarketFixture({
    ...options,
    mode: "organizer_handoff",
    stockGrant: { writerId, quantity: options.stockQuantity ?? 5 },
  })
  const graph = {
    ...sourceGraph,
    plan: options.preparePlan
      ? await options.preparePlan(sourceGraph)
      : sourceGraph.plan,
  }
  const database = new ConduitDB(`organizer-checkout-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const clock = { now: AT + 120_001, active: true }
  const organizerSigner = new SessionSigner(graph.organizerSigner, {
    expectedPubkey: graph.organizerPubkey,
    revision: crypto.randomUUID(),
    authMethod: "nip07",
    getCapabilities: () => ({
      signEvent: true,
      nip44: true,
      nip04Decrypt: true,
    }),
    hasAuthority: () => clock.active,
  })
  const buyerSigner = plainTestSigner(NDKPrivateKeySigner.generate())
  const order = createCheckoutSparkEventMarketFixtureOrder(
    graph,
    buyerSigner.pubkey,
    AT
  )
  const merchantRecovery = createCheckoutSparkSettledRecoveryPayload({
    state: createCheckoutSparkSettledReconciliation(graph.plan),
    senderPubkey: buyerSigner.pubkey,
    mnemonic: options.wallet?.mnemonic ?? createRuntimeMnemonic(),
    accountNumber: options.wallet?.accountNumber ?? 1,
    preparedAt: AT + 1_000,
    sourceEvents: graph.sourceEvents,
  })
  const initial = createCheckoutSparkOrganizerRecoveryPayload({
    merchantRecovery,
    order,
  })
  const initialWrap = await wrapPrivateMessage(
    buildCheckoutSparkOrganizerRecoveryRumor(initial),
    { pubkey: graph.organizerPubkey },
    buyerSigner,
    { rumorKind: 16 }
  )
  const stockEnvelope = await wrapPrivateMessage(
    graph.stockGrant!,
    { pubkey: graph.organizerPubkey },
    graph.merchantSigner,
    { rumorKind: 14 }
  )
  await receiveOrganizerStockGrant({
    db: database,
    signer: organizerSigner,
    authenticatedPubkey: graph.organizerPubkey,
    expectedWriterId: writerId,
    grantEnvelope: stockEnvelope,
    committedAssignmentEvent: graph.events.assignment,
    shouldContinue: () => clock.active,
    nowMs: clock.now,
  })
  const authorityInput = {
    db: database,
    signer: organizerSigner,
    authenticatedPubkey: graph.organizerPubkey,
    writerId,
    initialWrap,
    shouldContinue: () => clock.active,
    now: () => clock.now,
  }
  const authority =
    await openCheckoutSparkOrganizerRecoveryAuthority(authorityInput)
  return {
    ...graph,
    database,
    clock,
    organizerSigner,
    buyerSigner,
    order,
    initial,
    initialWrap,
    merchantRecovery,
    stockEnvelope,
    writerId,
    authorityInput,
    authority,
  }
}
