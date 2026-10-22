import {
  DexieCheckoutSparkSettledRepository,
  getAccountSigner,
  getOrderLifecycle,
  publishWithPlanner,
  type AccountSigner,
  type CheckoutSparkSettledRepositorySnapshot,
  type OrderLifecycle,
} from "@conduit/core"
import {
  getCheckoutSparkSettledPreparation,
  getCheckoutSparkSettledPreparationBrowserStorage,
  type CheckoutSparkSettledPreparationStorage,
} from "@conduit/core/wallets/checkout-spark-settled-preparation-storage"
import {
  getCheckoutSparkRecoveryDelivery,
  retryStoredCheckoutSparkRecoveryHandoff,
} from "./checkout-spark-recovery-handoff"
import { normalizePublicRelayHints } from "@conduit/core/protocol/relay-settings"

/** Existing initial ciphertext only: this boundary cannot sign, decrypt or pay. */
export interface CheckoutSparkOrderRecoveryReplayRequest {
  orderId: string
  buyerPubkey: string
  merchantPubkey: string
  checkoutId: string
  planDigest: string
  walletId: string
  shouldContinue: () => boolean
  storage?: CheckoutSparkSettledPreparationStorage | null
}

type Principal = Pick<AccountSigner, "pubkey" | "revision" | "authMethod">
type Lifecycle = Pick<
  OrderLifecycle,
  | "orderId"
  | "buyerPubkey"
  | "merchantPubkey"
  | "buyerIdentityKind"
  | "checkoutSparkRouterBinding"
>
export interface CheckoutSparkOrderRecoveryReplayDependencies {
  readPrincipal?: () => Principal | undefined
  readLifecycle?: (orderId: string) => Promise<Lifecycle | undefined>
  loadSnapshot?: (
    checkoutId: string,
    planDigest: string
  ) => Promise<CheckoutSparkSettledRepositorySnapshot>
  publishFn?: typeof publishWithPlanner
  resolveInboxRelays?: (pubkey: string) => Promise<string[]>
  now?: () => number
}

export interface CheckoutSparkRecoveryReplayDeliveryEvidence {
  recipient: "seller" | "organizer"
  attemptedSources: string[]
  acceptedSources: string[]
  outerEnvelopeSize:
    "under 16 KiB" | "16–32 KiB" | "32–48 KiB" | "48–64 KiB" | "64 KiB or more"
}

function envelopeSizeBucket(
  event: unknown
): CheckoutSparkRecoveryReplayDeliveryEvidence["outerEnvelopeSize"] {
  const kib = new TextEncoder().encode(JSON.stringify(event)).byteLength / 1024
  return kib < 16
    ? "under 16 KiB"
    : kib < 32
      ? "16–32 KiB"
      : kib < 48
        ? "32–48 KiB"
        : kib < 64
          ? "48–64 KiB"
          : "64 KiB or more"
}

/** Local evidence labels only; never return whole URLs or provider diagnostics. */
function freshSourceLabels(
  requested: readonly string[],
  attempted: readonly string[],
  accepted: readonly string[]
) {
  const allowed = new Set(normalizePublicRelayHints(requested))
  const attemptedUrls = normalizePublicRelayHints(attempted).filter((url) =>
    allowed.has(url)
  )
  const attemptedSet = new Set(attemptedUrls)
  const acceptedUrls = normalizePublicRelayHints(accepted).filter((url) =>
    attemptedSet.has(url)
  )
  const hosts = (urls: string[]) =>
    [...new Set(urls.map((url) => new URL(url).hostname))].sort()
  return {
    attemptedSources: hosts(attemptedUrls),
    acceptedSources: hosts(acceptedUrls),
  }
}

function replayContext(
  input: CheckoutSparkOrderRecoveryReplayRequest,
  dependencies: CheckoutSparkOrderRecoveryReplayDependencies
) {
  // Never retain caller-mutable identity or selection fields across awaits.
  const request = { ...input }
  const storage =
    request.storage === undefined
      ? getCheckoutSparkSettledPreparationBrowserStorage()
      : request.storage
  const readPrincipal = dependencies.readPrincipal ?? getAccountSigner
  const initialPrincipal = readPrincipal()
  const principal = initialPrincipal && {
    pubkey: initialPrincipal.pubkey,
    revision: initialPrincipal.revision,
    authMethod: initialPrincipal.authMethod,
  }
  const assertCurrent = () => {
    const current = readPrincipal()
    if (
      !request.shouldContinue() ||
      !principal ||
      principal.pubkey !== request.buyerPubkey ||
      !current ||
      current.pubkey !== principal.pubkey ||
      current.revision !== principal.revision ||
      current.authMethod !== principal.authMethod
    )
      throw new Error(
        "Reconnect this order's buyer before resending recovery copies."
      )
  }
  const read = async () => {
    assertCurrent()
    const lifecycle = await (dependencies.readLifecycle ?? getOrderLifecycle)(
      request.orderId
    )
    assertCurrent()
    const binding = lifecycle?.checkoutSparkRouterBinding
    if (
      !lifecycle ||
      lifecycle.buyerIdentityKind !== "signed_in" ||
      lifecycle.orderId !== request.orderId ||
      lifecycle.buyerPubkey !== request.buyerPubkey ||
      lifecycle.merchantPubkey !== request.merchantPubkey ||
      binding?.checkoutId !== request.checkoutId ||
      binding.planDigest !== request.planDigest ||
      binding.walletId !== request.walletId
    )
      throw new Error(
        "The selected order no longer matches its saved recovery copies."
      )
    const snapshot = await (
      dependencies.loadSnapshot ??
      ((checkoutId, planDigest) =>
        new DexieCheckoutSparkSettledRepository().load(checkoutId, planDigest))
    )(request.checkoutId, request.planDigest)
    assertCurrent()
    if (snapshot.status !== "active" || !snapshot.state.credit)
      throw new Error(
        "Only an existing funded checkout can resend recovery copies."
      )
    const plan = snapshot.state.plan
    const eventMarket = "eventMarket" in plan ? plan.eventMarket : null
    if (
      plan.orderId !== request.orderId ||
      plan.checkoutId !== request.checkoutId ||
      plan.planDigest !== request.planDigest ||
      plan.walletId !== request.walletId ||
      plan.merchantPubkey !== request.merchantPubkey ||
      !eventMarket ||
      eventMarket.mode !== "organizer_handoff"
    )
      throw new Error("The funded checkout no longer matches this Event order.")
    const preparation = getCheckoutSparkSettledPreparation(
      request.checkoutId,
      storage
    )
    if (
      preparation?.planDigest !== request.planDigest ||
      !preparation.recoveryHandoffId
    )
      throw new Error("This order's initial recovery delivery is unavailable.")
    const saved = await getCheckoutSparkRecoveryDelivery(
      preparation.recoveryHandoffId,
      storage
    )
    assertCurrent()
    const record = saved?.record
    const organizer = saved?.organizerDelivery
    if (
      !record ||
      !organizer ||
      saved.snapshotKey !== undefined ||
      record.handoffId !== preparation.recoveryHandoffId ||
      record.orderId !== request.orderId ||
      record.checkoutId !== request.checkoutId ||
      record.planDigest !== request.planDigest ||
      record.walletId !== request.walletId ||
      record.network !== plan.network ||
      record.merchantPubkey !== request.merchantPubkey ||
      record.senderPubkey !== request.buyerPubkey ||
      organizer.organizerPubkey !== eventMarket.organizerPubkey ||
      organizer.merchantHandoffId !== record.handoffId ||
      organizer.orderId !== record.orderId ||
      organizer.checkoutId !== record.checkoutId ||
      organizer.planDigest !== record.planDigest ||
      organizer.senderPubkey !== record.senderPubkey ||
      organizer.merchantPubkey !== record.merchantPubkey ||
      organizer.preparedAt !== record.createdAt
    )
      throw new Error(
        "The initial seller and organizer recovery copies do not match this order."
      )
    assertCurrent()
    return { saved }
  }
  return { request, storage, assertCurrent, read }
}

export async function canReplayCheckoutSparkOrderRecovery(
  input: CheckoutSparkOrderRecoveryReplayRequest,
  dependencies: CheckoutSparkOrderRecoveryReplayDependencies = {}
): Promise<boolean> {
  try {
    await replayContext(input, dependencies).read()
    return true
  } catch {
    return false
  }
}

/** Explicit user action; relay acceptance never establishes recipient receipt. */
export async function replayCheckoutSparkOrderRecovery(
  input: CheckoutSparkOrderRecoveryReplayRequest,
  dependencies: CheckoutSparkOrderRecoveryReplayDependencies = {}
): Promise<{
  status: "relay_accepted" | "waiting"
  deliveries: CheckoutSparkRecoveryReplayDeliveryEvidence[]
}> {
  const context = replayContext(input, dependencies)
  const original = await context.read()
  const allowedWraps = [
    original.saved.record.signedRecipientWrap,
    original.saved.organizerDelivery!.signedRecipientWrap,
  ]
  const deliveries: CheckoutSparkRecoveryReplayDeliveryEvidence[] = []
  const publish: typeof publishWithPlanner = async (event, options) => {
    const current = await context.read()
    // ACK bookkeeping can change, but exact initial encrypted payloads cannot.
    const { acknowledgedRelayRefs: previousAcks, ...originalOrganizer } =
      original.saved.organizerDelivery!
    const { acknowledgedRelayRefs: currentAcks, ...currentOrganizer } =
      current.saved.organizerDelivery!
    void previousAcks
    void currentAcks
    if (
      JSON.stringify(current.saved.record) !==
        JSON.stringify(original.saved.record) ||
      JSON.stringify(currentOrganizer) !== JSON.stringify(originalOrganizer) ||
      !allowedWraps.some(
        (wrap) => JSON.stringify(wrap) === JSON.stringify(event)
      ) ||
      JSON.stringify(current.saved.record.signedRecipientWrap) !==
        JSON.stringify(allowedWraps[0]) ||
      JSON.stringify(current.saved.organizerDelivery!.signedRecipientWrap) !==
        JSON.stringify(allowedWraps[1])
    )
      throw new Error(
        "Saved recovery copies changed; reload this order before retrying."
      )
    context.assertCurrent()
    const requested = [...(options.exclusiveRelayUrls ?? [])]
    const delivery = await (dependencies.publishFn ?? publishWithPlanner)(
      event,
      options
    )
    context.assertCurrent()
    deliveries.push({
      recipient: event.id === allowedWraps[0]!.id ? "seller" : "organizer",
      ...freshSourceLabels(
        requested,
        delivery.attemptedRelayUrls,
        delivery.successfulRelayUrls
      ),
      outerEnvelopeSize: envelopeSizeBucket(event),
    })
    return delivery
  }
  const result = await retryStoredCheckoutSparkRecoveryHandoff({
    handoffId: original.saved.record.handoffId,
    storage: context.storage,
    replayAcknowledged: true,
    shouldContinue: () => {
      try {
        context.assertCurrent()
        return true
      } catch {
        return false
      }
    },
    publishFn: publish,
    resolveInboxRelays: dependencies.resolveInboxRelays,
    organizerTransport: { resolveInboxRelays: dependencies.resolveInboxRelays },
    now: dependencies.now,
  })
  context.assertCurrent()
  return {
    status: result.canExposeFundingInvoice ? "relay_accepted" : "waiting",
    deliveries,
  }
}
