/**
 * Offline characterization of the Merchant "Check payment again" evidence gate
 * (`withMerchantCheckoutSparkRecovery`) and its discovery companion.
 *
 * What this file is: a deterministic harness that drives the REAL seam with a
 * real signed/encrypted NIP-59 recovery wrap, a real `CommerceInbox` on
 * in-memory IndexedDB, and a scripted relay reader. Each case perturbs ONE
 * factor from a consumed control and records the status the strict guards
 * return today.
 *
 * What this file is NOT: a reproduction of any production checkout incident.
 * It shows which inputs make the guards refuse, not which one fired in the
 * field. No relay, wallet, provider, funding or browser is touched; the
 * network guard below fails any test that attempts external I/O. All values
 * are synthetic.
 */
import {
  calculateCheckoutSparkInboundNetworkAllowanceSats,
  calculateConduitCheckoutFeeSats,
  checkoutSparkConduitFeeRecipient,
  DexieCheckoutSparkSettledRepository,
  fetchLnurlPayMetadata,
} from "@conduit/core"
import { bytesToHex } from "@noble/hashes/utils.js"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test"
import { IDBKeyRange, indexedDB } from "fake-indexeddb"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import {
  listCheckoutSparkRecoveryDeliveries,
  publishCheckoutSparkSettledRecoveryHandoff,
} from "../../../apps/market/src/lib/checkout-spark-recovery-handoff"
import {
  prepareCheckoutSparkSettledFunding,
  type PrepareCheckoutSparkSettledFundingInput,
} from "../../../apps/market/src/lib/checkout-spark-settled-preparation"
import { createInboxDeclarationFixtureEvidence } from "../../../tests/helpers/inbox-declaration"
import { plainTestSigner } from "../../../tests/helpers/plain-signer"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "../../../tests/support/bolt11-fixture"
import { qualifiedReceiverMetadataFixture } from "../../../tests/support/checkout-spark-qualified-receiver-fixture"
import { checkoutSparkQuoteFixture } from "../../../tests/support/checkout-spark-quote-fixture"
import { createRuntimeMnemonic } from "../../../tests/support/runtime-wallet-fixtures"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "../../../tests/support/signed-bolt11-fixture"
import { createInMemoryAccountNetworkLocalStateRepository } from "../src/protocol/account-network-local-state"
import { createInMemoryOwnerRelayListEvidenceRepository } from "../src/protocol/owner-relay-list-evidence"
import { ConduitDB } from "../src/db"
import {
  __resetCommerceTestOverrides,
  __setCommerceTestOverrides,
  getMerchantCheckoutSparkRecoveryList,
  withMerchantCheckoutSparkRecovery,
  type MerchantCheckoutSparkRecoveryCandidate,
  type MerchantCheckoutSparkRecoveryHandoffResult,
  type MerchantCheckoutSparkRecoveryPrivateAdapter,
} from "../src/protocol/commerce"
import { unwrapPrivateMessageEnvelope } from "../src/protocol/messaging"
import { CommerceInbox } from "../src/protocol/commerce-inbox"
import { CommerceInboxStore } from "../src/protocol/commerce-inbox-store"
import type { SignedNostrEvent } from "../src/protocol/nostr-event-signer"
import { __resetInboxDeclarationCache } from "../src/protocol/private-message-routing"
import type {
  ProtectedInboxReadResult,
  ReadProtectedInboxOptions,
} from "../src/protocol/protected-inbox-read"
import {
  __resetProtectedReadSigner,
  getProtectedReadAuthorization,
  installProtectedReadSigner,
} from "../src/protocol/protected-read-authorization"

const NOW = 1_800_000_000_000
const MERCHANT_SECRET = generateSecretKey()
const MERCHANT = getPublicKey(MERCHANT_SECRET)
const RELAY_A = "wss://merchant-a.inbox.relay.dev"
const RELAY_B = "wss://merchant-b.inbox.relay.dev"
const PROFILE = finalizeEvent(
  {
    kind: 0,
    created_at: NOW / 1_000,
    tags: [],
    content: JSON.stringify({ lud16: "merchant@wallet.conduit.market" }),
  },
  MERCHANT_SECRET
)
const CLAIM = "12".repeat(32)
const GROSS =
  1_000 +
  calculateConduitCheckoutFeeSats(1_000) +
  calculateCheckoutSparkInboundNetworkAllowanceSats(1_000)
const fundingInvoice = (grossSats: number) =>
  makeSignedBolt11Fixture({
    hrp: `lnbc${grossSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(new Uint8Array(32).fill(0x44)),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField(),
      { tag: "x", words: [28, 4] },
    ],
  })
const INVOICE = fundingInvoice(GROSS)

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Buyer side: produce a real signed, encrypted settled-recovery handoff wrap
// using the production preparation path with simulated wallet/provider.
// ---------------------------------------------------------------------------

function buyerFixture(storage: MemoryStorage, checkoutId: string) {
  const signer = plainTestSigner(NDKPrivateKeySigner.generate())
  const quoteAuthority = checkoutSparkQuoteFixture(MERCHANT_SECRET)
  const conduit = checkoutSparkConduitFeeRecipient("production")
  const input: PrepareCheckoutSparkSettledFundingInput = {
    checkoutId,
    orderId: `${checkoutId}-order`,
    purchaseClaimDigest: CLAIM,
    merchantPubkey: MERCHANT,
    network: "mainnet",
    takeoverAt: NOW + 120_000,
    grossFundingSats: GROSS,
    fundingExpirySecs: 900,
    identity: { kind: "signed_in", pubkey: signer.pubkey, signer },
    quoteAuthority,
    sourceEvents: [
      quoteAuthority.products[0]!.supplierAllocation!.revisionEvent!,
      PROFILE,
    ],
    recipients: [
      {
        kind: "merchant",
        recipientId: MERCHANT,
        destination: {
          type: "lightning_address",
          value: "merchant@wallet.conduit.market",
          source: {
            type: "signed_profile",
            profileEventId: PROFILE.id,
            profileEventCreatedAt: PROFILE.created_at,
          },
        },
        weightSats: 1_000,
      },
      {
        kind: "conduit",
        recipientId: conduit,
        destination: {
          type: "lightning_address",
          value: conduit,
          source: { type: "conduit_allowlist", policy: "production" },
        },
        weightSats: calculateConduitCheckoutFeeSats(1_000),
      },
    ],
    storage,
    recoveryStorage: storage,
  }
  const inboxEvidence = createInboxDeclarationFixtureEvidence(
    finalizeEvent(
      {
        kind: 10_050,
        created_at: NOW / 1_000,
        tags: [["relay", RELAY_A]],
        content: "",
      },
      MERCHANT_SECRET
    )
  )
  return {
    input,
    options: {
      now: () => NOW,
      receiverContracts: qualifiedReceiverMetadataFixture(
        "merchant@wallet.conduit.market"
      ).contracts,
      fetchPayoutMetadata: (address: string) =>
        fetchLnurlPayMetadata(address, {
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                tag: "payRequest",
                callback: "https://wallet.conduit.market/callback",
                minSendable: 1_000,
                maxSendable: 10_000_000,
                allowsNostr: false,
                metadata:
                  qualifiedReceiverMetadataFixture(address).metadata.metadata,
              }),
              { status: 200 }
            ),
        }),
      createWalletMaterial: () => ({
        walletId: `${checkoutId}-wallet`,
        network: "mainnet" as const,
        mnemonic: createRuntimeMnemonic(),
        accountNumber: 1,
      }),
      openWallet: async () => {},
      closeWallet: async () => {},
      createFundingReceive: async (
        _wallet?: unknown,
        request?: { grossFundingSats: number }
      ) => {
        const grossFundingSats = request?.grossFundingSats ?? GROSS
        return {
          walletId: `${checkoutId}-wallet`,
          network: "mainnet" as const,
          id: `${checkoutId}-receive`,
          paymentRequest:
            grossFundingSats === GROSS
              ? INVOICE
              : fundingInvoice(grossFundingSats),
          paymentHash: "44".repeat(32),
          providerStatus: "INVOICE_CREATED",
          requiredNetSats: grossFundingSats,
          grossFundingSats,
          expirySecs: 900,
          createdAt: NOW,
          expiresAt: NOW + 900_000,
          receiveSettledPolicy: "ordinary-exact-credit-v3" as const,
          receiverIdentityPublicKey: `02${"a".repeat(64)}`,
        }
      },
      publishRecoveryHandoff: async (
        request: Parameters<
          typeof publishCheckoutSparkSettledRecoveryHandoff
        >[0]
      ) =>
        publishCheckoutSparkSettledRecoveryHandoff({
          ...request,
          now: () => NOW,
          transport: {
            ...request.transport,
            recipientInboxRelays: [RELAY_A],
            inboxDeclarationEvidenceRepository: await inboxEvidence,
            publishFn: async (_event, plan) => ({
              attemptedRelayUrls: [...(plan.exclusiveRelayUrls ?? [])],
              successfulRelayUrls: [...(plan.exclusiveRelayUrls ?? [])],
              failedRelayUrls: [],
              relayFailureMessages: {},
            }),
          },
        }),
    },
  }
}

/** One real handoff wrap, addressed to MERCHANT, for the given checkout. */
async function buildHandoffWrap(checkoutId: string): Promise<SignedNostrEvent> {
  const database = new ConduitDB(`recovery-buyer-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  try {
    const storage = new MemoryStorage()
    const { input, options } = buyerFixture(storage, checkoutId)
    await prepareCheckoutSparkSettledFunding(input, {
      ...options,
      repository: new DexieCheckoutSparkSettledRepository(database),
    })
    const deliveries = await listCheckoutSparkRecoveryDeliveries(storage)
    expect(deliveries).toHaveLength(1)
    return structuredClone(
      deliveries[0]!.record.signedRecipientWrap
    ) as SignedNostrEvent
  } finally {
    database.close()
    await database.delete()
  }
}

// ---------------------------------------------------------------------------
// Merchant side: scripted relays + real inbox + real seam.
// ---------------------------------------------------------------------------

type ReadResult = ProtectedInboxReadResult
type ExactPerturbation = (base: ReadResult) => ReadResult

/** Every requested relay failed: no source completed and nothing was observed. */
function unavailableRead(relayCount: number): ReadResult {
  return {
    events: [],
    coverage: "unavailable",
    auth: {
      state: "unavailable",
      challengedCount: 0,
      succeededCount: 0,
      failedCount: relayCount,
    },
    relayResult: {
      status: "unavailable",
      observations: [],
      relays: Array.from({ length: relayCount }, (_, relayIndex) => ({
        relayIndex,
        status: "failed" as const,
        auth: "not_challenged" as const,
        eventCount: 0,
        duplicateCount: 0,
        malformedCount: 0,
        unusableCount: 0,
      })),
      attemptedCount: relayCount,
      completedCount: 0,
      failedCount: relayCount,
      authoritativeEmpty: false,
    },
  }
}

/**
 * Scripted stand-in for `readProtectedInbox`. It answers history pages and
 * exact-ID reads from per-relay event lists with the same result shape the
 * production reader returns for a clean EOSE. `perturbExact` mutates only the
 * exact-ID read result, so a case changes one factor.
 */
class ScriptedRelays {
  readonly events = new Map<string, SignedNostrEvent[]>()
  perturbExact: ExactPerturbation | undefined
  /** History pages for these relay URLs fail as an unreachable source. */
  failHistoryFor = new Set<string>()
  exactReads = 0
  historyReads = 0

  constructor(urls: readonly string[]) {
    for (const url of urls) this.events.set(url, [])
  }

  /** A relay stores one copy per event id, like a real relay. */
  publish(url: string, event: SignedNostrEvent) {
    const held = this.events.get(url)!
    if (!held.some((row) => row.id === event.id))
      held.push(structuredClone(event))
  }

  read = async (options: ReadProtectedInboxOptions): Promise<ReadResult> => {
    const exact = options.eventId !== undefined
    if (exact) this.exactReads += 1
    else this.historyReads += 1
    if (
      !exact &&
      options.relayUrls.some((url) =>
        this.failHistoryFor.has(url.replace(/\/$/, ""))
      )
    )
      return unavailableRead(options.relayUrls.length)
    const perRelay = options.relayUrls.map((url) =>
      (this.events.get(url.replace(/\/$/, "")) ?? [])
        .filter(
          (event) =>
            (options.eventId === undefined || event.id === options.eventId) &&
            (options.since === undefined ||
              event.created_at >= options.since) &&
            (options.until === undefined || event.created_at <= options.until)
        )
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, options.limit)
    )
    const merged = new Map<string, SignedNostrEvent>()
    for (const list of perRelay)
      for (const event of list) merged.set(event.id, event)
    const events = [...merged.values()]
    const base: ReadResult = {
      events,
      coverage: "complete",
      auth: {
        state: "not_challenged",
        challengedCount: 0,
        succeededCount: 0,
        failedCount: 0,
      },
      relayResult: {
        status: "success",
        observations: options.relayUrls.map((_, relayIndex) => ({
          type: "eose" as const,
          relayIndex,
        })),
        relays: perRelay.map((list, relayIndex) => ({
          relayIndex,
          status: "success" as const,
          auth: "not_challenged" as const,
          eventCount: list.length,
          duplicateCount: 0,
          malformedCount: 0,
          unusableCount: 0,
        })),
        attemptedCount: options.relayUrls.length,
        completedCount: options.relayUrls.length,
        failedCount: 0,
        authoritativeEmpty: events.length === 0,
      },
    }
    return exact && this.perturbExact ? this.perturbExact(base) : base
  }
}

interface Harness {
  relays: ScriptedRelays
  consumed: { count: number }
  adapter: MerchantCheckoutSparkRecoveryPrivateAdapter
  inbox: CommerceInbox
  discover(): ReturnType<typeof getMerchantCheckoutSparkRecoveryList>
  check(
    candidate: MerchantCheckoutSparkRecoveryCandidate
  ): Promise<MerchantCheckoutSparkRecoveryHandoffResult>
  close(): Promise<void>
}

async function createHarness(): Promise<Harness> {
  const database = new ConduitDB(`recovery-merchant-${crypto.randomUUID()}`, {
    indexedDB,
    IDBKeyRange,
  })
  const signer = Object.assign(
    plainTestSigner(new NDKPrivateKeySigner(bytesToHex(MERCHANT_SECRET))),
    { authMethod: "local" as const }
  )
  installProtectedReadSigner(signer, MERCHANT, () => true)
  const authorization = getProtectedReadAuthorization(MERCHANT)!
  const inbox = new CommerceInbox(
    authorization,
    signer,
    new CommerceInboxStore(authorization, database)
  )
  // The Merchant's own signed inbox declaration admits its relays for reading.
  await createInboxDeclarationFixtureEvidence(
    finalizeEvent(
      {
        kind: 10_050,
        created_at: NOW / 1_000,
        tags: [
          ["relay", RELAY_A],
          ["relay", RELAY_B],
        ],
        content: "",
      },
      MERCHANT_SECRET
    ),
    { prime: true }
  )
  const relays = new ScriptedRelays([RELAY_A, RELAY_B])
  __setCommerceTestOverrides({
    now: () => NOW,
    getAccountSigner: () => signer,
    getCommerceInbox: () => inbox,
    resolveInboxRelayUrls: async () => [RELAY_A, RELAY_B],
    readProtectedInbox: relays.read,
    accountNetworkLocalStateRepository:
      createInMemoryAccountNetworkLocalStateRepository([], () => NOW),
    ownerRelayListEvidenceRepository:
      createInMemoryOwnerRelayListEvidenceRepository(),
    checkoutSparkSettledRepository: new DexieCheckoutSparkSettledRepository(
      database
    ),
  })
  const consumed = { count: 0 }
  const adapter: MerchantCheckoutSparkRecoveryPrivateAdapter = {
    // Counts the call only. The decrypted payload is never retained or logged.
    consume: async (_payload, assertCurrent) => {
      assertCurrent()
      consumed.count += 1
    },
  }
  return {
    relays,
    consumed,
    adapter,
    inbox,
    discover: () => getMerchantCheckoutSparkRecoveryList(MERCHANT),
    check: (candidate) =>
      withMerchantCheckoutSparkRecovery(MERCHANT, candidate, adapter),
    close: async () => {
      inbox.stop()
      __resetCommerceTestOverrides()
      __resetProtectedReadSigner()
      __resetInboxDeclarationCache()
      database.close()
      await database.delete()
    },
  }
}

// ---------------------------------------------------------------------------
// Network guard and shared fixtures.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch
const realWebSocket = globalThis.WebSocket
let networkAttempts = 0
let wrapA: SignedNostrEvent

function forbidExternalNetwork() {
  globalThis.fetch = (async () => {
    networkAttempts += 1
    throw new Error("external fetch blocked")
  }) as unknown as typeof fetch
  globalThis.WebSocket = class {
    constructor() {
      networkAttempts += 1
      throw new Error("external websocket blocked")
    }
  } as unknown as typeof WebSocket
}

beforeAll(async () => {
  forbidExternalNetwork()
  try {
    wrapA = await buildHandoffWrap("recovery-evidence-checkout")
    expect(networkAttempts).toBe(0)
  } finally {
    globalThis.fetch = realFetch
    globalThis.WebSocket = realWebSocket
  }
})

beforeEach(() => {
  networkAttempts = 0
  forbidExternalNetwork()
})

afterEach(() => {
  const attempts = networkAttempts
  globalThis.fetch = realFetch
  globalThis.WebSocket = realWebSocket
  expect(attempts).toBe(0)
})

afterAll(() => {
  globalThis.fetch = realFetch
  globalThis.WebSocket = realWebSocket
})

/** A validly signed gift-wrap-kind event the Merchant cannot decrypt. */
function undecryptableWrap(): SignedNostrEvent {
  return finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(NOW / 1_000) - 60,
      tags: [["p", MERCHANT]],
      content: "not-a-nip44-payload",
    },
    generateSecretKey()
  ) as SignedNostrEvent
}

type RelayEntry = ReadResult["relayResult"]["relays"][number]

function mapRelays(
  base: ReadResult,
  edit: (relay: RelayEntry, index: number) => RelayEntry
): ReadResult {
  return {
    ...base,
    relayResult: {
      ...base.relayResult,
      relays: base.relayResult.relays.map(edit),
    },
  }
}

/** Index 2 is a read-plan relay that does not hold the wrap in the control. */
const SIBLING = 2

async function withHarness<T>(run: (h: Harness) => Promise<T>): Promise<T> {
  const h = await createHarness()
  try {
    return await run(h)
  } finally {
    await h.close()
  }
}

/** Both declared relays hold the one wrap; discovery selects its candidate. */
async function seedControl(h: Harness) {
  h.relays.publish(RELAY_A, wrapA)
  h.relays.publish(RELAY_B, wrapA)
  const list = await h.discover()
  expect(list.candidates).toHaveLength(1)
  return { list, candidate: list.candidates[0]! }
}

const summary = (result: MerchantCheckoutSparkRecoveryHandoffResult) => ({
  status: result.status,
  coverage: result.coverage,
  candidate: result.candidate !== null,
})

// ---------------------------------------------------------------------------

describe("merchant recovery evidence gate: control", () => {
  it("one intact wrap on both declared relays is discovered and consumed once", async () => {
    await withHarness(async (h) => {
      const { list, candidate } = await seedControl(h)
      expect(list.coverage).toBe("complete")
      expect(list.declarationState).toBe("declared")
      expect(list.conflictCount).toBe(0)
      expect(list.malformedCount + list.decryptFailureCount).toBe(0)
      const result = await h.check(candidate)
      expect(summary(result)).toEqual({
        status: "consumed",
        coverage: "complete",
        candidate: true,
      })
      expect(result.discoveryCoverage).toBe("complete")
      expect(h.consumed.count).toBe(1)
    })
  })
})

describe("exact-ID read guards: one factor changed from the consumed control", () => {
  // Each perturbation edits only the exact-ID read result for the selected
  // wrap. The wrap bytes, the signer and the discovery result are unchanged.
  const refused: Array<{ name: string; perturb: ExactPerturbation }> = [
    {
      name: "a sibling relay reports a duplicate (eventCount 2)",
      perturb: (base) =>
        mapRelays(base, (r, i) =>
          i === SIBLING ? { ...r, eventCount: 2 } : r
        ),
    },
    {
      name: "a sibling relay reports a malformed event",
      perturb: (base) =>
        mapRelays(base, (r, i) =>
          i === SIBLING ? { ...r, malformedCount: 1 } : r
        ),
    },
    {
      name: "a sibling relay reports an unusable event",
      perturb: (base) =>
        mapRelays(base, (r, i) =>
          i === SIBLING ? { ...r, unusableCount: 1 } : r
        ),
    },
    {
      name: "attemptedCount is lower than the number of planned relays",
      perturb: (base) => ({
        ...base,
        relayResult: {
          ...base.relayResult,
          attemptedCount: base.relayResult.attemptedCount - 1,
        },
      }),
    },
    {
      name: "a planned relay is missing from the per-relay results",
      perturb: (base) => ({
        ...base,
        relayResult: {
          ...base.relayResult,
          relays: base.relayResult.relays.slice(0, -1),
        },
      }),
    },
    {
      name: "the read returns a different valid event",
      perturb: (base) => ({ ...base, events: [undecryptableWrap()] }),
    },
    {
      name: "the read returns the selected wrap plus a second event",
      perturb: (base) => ({
        ...base,
        events: [...base.events, undecryptableWrap()],
      }),
    },
    {
      name: "the returned wrap carries a tampered signature",
      perturb: (base) => ({
        ...base,
        events: base.events.map((event) => ({
          ...event,
          sig: `${event.sig.slice(0, -1)}${event.sig.endsWith("0") ? "1" : "0"}`,
        })),
      }),
    },
    {
      name: "the read is empty but one sibling relay failed",
      perturb: (base) => ({
        ...mapRelays(base, (r, i) => ({
          ...r,
          eventCount: 0,
          ...(i === SIBLING ? { status: "failed" as const } : {}),
        })),
        events: [],
        coverage: "partial",
        relayResult: {
          ...base.relayResult,
          status: "partial",
          failedCount: 1,
          completedCount: base.relayResult.attemptedCount - 1,
          authoritativeEmpty: false,
          relays: base.relayResult.relays.map((r, i) => ({
            ...r,
            eventCount: 0,
            ...(i === SIBLING ? { status: "failed" as const } : {}),
          })),
        },
      }),
    },
  ]

  for (const { name, perturb } of refused) {
    it(`refuses (incomplete/partial, no consume): ${name}`, async () => {
      await withHarness(async (h) => {
        const { candidate } = await seedControl(h)
        h.relays.perturbExact = perturb
        const result = await h.check(candidate)
        expect(summary(result)).toEqual({
          status: "incomplete",
          coverage: "partial",
          candidate: false,
        })
        expect(h.consumed.count).toBe(0)
      })
    })
  }

  it("refuses (incomplete/unavailable, no consume): every relay failed the exact read", async () => {
    await withHarness(async (h) => {
      const { candidate } = await seedControl(h)
      h.relays.perturbExact = (base) =>
        unavailableRead(base.relayResult.attemptedCount)
      const result = await h.check(candidate)
      expect(summary(result)).toEqual({
        status: "incomplete",
        coverage: "unavailable",
        candidate: false,
      })
      expect(h.consumed.count).toBe(0)
    })
  })

  it("reports missing (complete, no consume) when every relay answers an empty exact read", async () => {
    await withHarness(async (h) => {
      const { candidate } = await seedControl(h)
      h.relays.perturbExact = (base) => ({
        ...mapRelays(base, (r) => ({ ...r, eventCount: 0 })),
        events: [],
        relayResult: {
          ...base.relayResult,
          authoritativeEmpty: true,
          relays: base.relayResult.relays.map((r) => ({ ...r, eventCount: 0 })),
        },
      })
      const result = await h.check(candidate)
      expect(summary(result)).toEqual({
        status: "missing",
        coverage: "complete",
        candidate: false,
      })
      expect(h.consumed.count).toBe(0)
    })
  })

  it("still consumes (coverage partial) when a sibling relay merely failed while the wrap was returned", async () => {
    await withHarness(async (h) => {
      const { candidate } = await seedControl(h)
      h.relays.perturbExact = (base) => ({
        ...base,
        coverage: "partial",
        relayResult: {
          ...base.relayResult,
          status: "partial",
          failedCount: 1,
          completedCount: base.relayResult.attemptedCount - 1,
          relays: base.relayResult.relays.map((r, i) =>
            i === SIBLING ? { ...r, status: "failed" as const } : r
          ),
        },
      })
      const result = await h.check(candidate)
      expect(summary(result)).toEqual({
        status: "consumed",
        coverage: "partial",
        candidate: true,
      })
      expect(h.consumed.count).toBe(1)
    })
  })
})

describe("conflict guard", () => {
  it("a second handoff for the same checkout with different wallet authority removes the candidate and refuses the selected one", async () => {
    const wrapB = await buildHandoffWrap("recovery-evidence-checkout")
    expect(wrapB.id === wrapA.id).toBe(false)
    await withHarness(async (h) => {
      const { candidate } = await seedControl(h)
      // The only change from the control: a second wrap for the same checkout.
      h.relays.publish(RELAY_A, wrapB)
      h.relays.publish(RELAY_B, wrapB)
      const after = await h.discover()
      expect(after.candidates).toHaveLength(0)
      expect(after.conflictCount).toBe(1)
      expect(after.coverage).toBe("partial")
      const result = await h.check(candidate)
      expect(summary(result)).toEqual({
        status: "incomplete",
        coverage: "partial",
        candidate: false,
      })
      expect(h.consumed.count).toBe(0)
    })
  })
})

describe("unwrap failure", () => {
  it("a decrypt failure (null) for the selected wrap refuses it and hides it from discovery", async () => {
    await withHarness(async (h) => {
      const { candidate } = await seedControl(h)
      __setCommerceTestOverrides({ giftUnwrap: async () => null })
      const result = await h.check(candidate)
      expect(summary(result)).toEqual({
        status: "incomplete",
        coverage: "partial",
        candidate: false,
      })
      expect(h.consumed.count).toBe(0)
      const after = await h.discover()
      expect(after.candidates).toHaveLength(0)
      expect(after.decryptFailureCount).toBeGreaterThanOrEqual(1)
      expect(after.coverage).toBe("partial")
    })
  })

  it("a signer error during unwrap refuses the selected wrap without consuming", async () => {
    await withHarness(async (h) => {
      const { candidate } = await seedControl(h)
      __setCommerceTestOverrides({
        giftUnwrap: async () => {
          throw new Error("synthetic signer failure")
        },
      })
      const result = await h.check(candidate)
      expect(summary(result)).toEqual({
        status: "incomplete",
        coverage: "partial",
        candidate: false,
      })
      expect(h.consumed.count).toBe(0)
    })
  })

  // Let discovery decrypt normally so only the exact-open phase can supply
  // this deadline signal. A premature exact-open timeout must fail this case.
  it("an exact unwrap that never answers waits for its unmodified 4 s deadline", async () => {
    await withHarness(async (h) => {
      const { candidate } = await seedControl(h)
      let exactStarted: number | undefined
      let exactOpenAttempts = 0
      __setCommerceTestOverrides({
        giftUnwrap: (event, signer) => {
          if (h.relays.exactReads === 0)
            return unwrapPrivateMessageEnvelope(event, signer)
          exactOpenAttempts += 1
          exactStarted = performance.now()
          return new Promise(() => {})
        },
      })
      const result = await h.check(candidate)
      expect(summary(result)).toEqual({
        status: "incomplete",
        coverage: "partial",
        candidate: false,
      })
      expect(exactOpenAttempts).toBe(1)
      expect(exactStarted).toBeDefined()
      expect(performance.now() - exactStarted!).toBeGreaterThanOrEqual(3_900)
      expect(h.consumed.count).toBe(0)
    })
  }, 15_000)
})

describe("partial discovery coverage does not itself veto an intact wrap", () => {
  it("one declared relay failing its history page leaves discovery partial; the candidate is still consumed", async () => {
    await withHarness(async (h) => {
      h.relays.failHistoryFor.add(RELAY_B)
      const { list, candidate } = await seedControl(h)
      expect(list.coverage).toBe("partial")
      const result = await h.check(candidate)
      expect(summary(result)).toEqual({
        status: "consumed",
        coverage: "complete",
        candidate: true,
      })
      expect(result.discoveryCoverage).toBe("partial")
      expect(h.consumed.count).toBe(1)
    })
  })

  it("an undecryptable sibling wrap keeps discovery partial and countable; the intact wrap is still consumed", async () => {
    await withHarness(async (h) => {
      h.relays.publish(RELAY_A, undecryptableWrap())
      const { list, candidate } = await seedControl(h)
      expect(list.coverage).toBe("partial")
      expect(list.malformedCount + list.decryptFailureCount).toBeGreaterThan(0)
      const result = await h.check(candidate)
      expect(result.status).toBe("consumed")
      expect(result.discoveryCoverage).toBe("partial")
      expect(h.consumed.count).toBe(1)
    })
  })
})
