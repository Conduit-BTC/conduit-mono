import { afterEach, expect, it } from "bun:test"
import { getEventHash } from "nostr-tools"
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk"
import type { ConduitDB } from "@conduit/core/db"
import { CommerceInbox } from "@conduit/core/protocol/commerce-inbox"
import {
  CommerceInboxStore,
  INBOX_DECODE_RULES_VERSION,
} from "@conduit/core/protocol/commerce-inbox-store"
import {
  installProtectedReadSigner,
  getProtectedReadAuthorization,
  __resetProtectedReadSigner,
} from "@conduit/core/protocol/protected-read-authorization"
import { readRetainedCheckoutSparkOrganizerRecoveries } from "@conduit/core/protocol/checkout-spark-organizer-discovery"
import {
  buildCheckoutSparkOrganizerRecoveryRumor,
  createCheckoutSparkOrganizerRecoveryProgressPayload,
  parseCheckoutSparkOrganizerRecoveryRumor,
} from "@conduit/core/protocol/checkout-spark-organizer-recovery"
import { createCheckoutSparkSettledRecoveryProgressPayload } from "@conduit/core/protocol/checkout-spark-recovery"
import {
  buildCheckoutSparkOrganizerExecutionRumor,
  createCheckoutSparkOrganizerExecutionProgress,
  parseCheckoutSparkOrganizerExecutionRumor,
} from "@conduit/core/protocol/checkout-spark-organizer-progress"
import {
  buildCheckoutSparkMerchantEventProgressRumor,
  createCheckoutSparkMerchantEventProgress,
  parseCheckoutSparkMerchantEventProgressRumor,
} from "@conduit/core/protocol/checkout-spark-merchant-event-progress"
import { createCheckoutSparkMerchantProgress } from "@conduit/core/protocol/checkout-spark-merchant-progress"
import { assertCheckoutSparkOrganizerRecoveryAuthority } from "@conduit/core/protocol/checkout-spark-organizer-execution"
import {
  recordCheckoutSparkSettledCredit,
  prepareCheckoutSparkSettledLeg,
  deriveCheckoutSparkSettledTransferId,
} from "@conduit/core/protocol/checkout-spark-settled-router"
import {
  buildEventMarketFreePurchaseRumor,
  parseEventMarketFreePurchaseRumor,
} from "@conduit/core/protocol/event-market-free-purchase"
import { getConduitNip89AppDefinition } from "@conduit/core/protocol/nip89"
import {
  wrapPrivateMessage,
  type PrivateMessageRumor,
} from "@conduit/core/protocol/private-message-primitives"
import { checkoutSparkOrganizerFixture } from "./support/checkout-spark-organizer-fixture"
import { eventMarketFreePurchaseFixture } from "./support/event-market-free-purchase-fixture"
import { qualifiedReceiverFixture } from "./support/checkout-spark-qualified-receiver-fixture"

const owners: CommerceInbox[] = []
const databases: ConduitDB[] = []
afterEach(async () => {
  for (const inbox of owners.splice(0)) inbox.stop()
  __resetProtectedReadSigner()
  for (const database of databases.splice(0)) await database.delete()
})

function inboxFor(
  f: Awaited<ReturnType<typeof checkoutSparkOrganizerFixture>>
) {
  installProtectedReadSigner(
    f.organizerSigner,
    f.organizerPubkey,
    () => f.clock.active
  )
  const authorization = getProtectedReadAuthorization(f.organizerPubkey)!
  const inbox = new CommerceInbox(
    authorization,
    authorization.signer,
    new CommerceInboxStore(authorization, f.database)
  )
  owners.push(inbox)
  return inbox
}

async function withMarketClient<T>(
  pubkey: string | null,
  operation: () => Promise<T>
): Promise<T> {
  const definition = getConduitNip89AppDefinition("market")
  const previous = definition.pubkey
  try {
    definition.pubkey = pubkey
    return await operation()
  } finally {
    definition.pubkey = previous
  }
}

function withTags(rumor: PrivateMessageRumor, tags: string[][]) {
  const next = { ...rumor, tags }
  return {
    ...next,
    id: getEventHash({
      ...next,
      kind: next.kind!,
      created_at: next.created_at!,
    }),
  }
}

it.each(["different", "absent"] as const)(
  "discovers authenticated initial and Buyer progress with %s sender client metadata",
  async (metadata) => {
    const f = await checkoutSparkOrganizerFixture()
    databases.push(f.database)
    const progress = createCheckoutSparkOrganizerRecoveryProgressPayload({
      merchantProgress: createCheckoutSparkSettledRecoveryProgressPayload({
        initialHandoffId: f.merchantRecovery.handoffId,
        state: f.initial.state,
        senderPubkey: f.buyerSigner.pubkey,
        preparedAt: f.initial.preparedAt + 1,
      }),
      initialOrganizerHandoffId: f.initial.handoffId,
    })
    const wraps = await withMarketClient(
      metadata === "absent" ? null : f.buyerSigner.pubkey,
      () =>
        Promise.all(
          [f.initial, progress].map((payload) =>
            wrapPrivateMessage(
              buildCheckoutSparkOrganizerRecoveryRumor(payload),
              { pubkey: f.organizerPubkey },
              f.buyerSigner,
              { rumorKind: 16 }
            )
          )
        )
    )
    await withMarketClient(f.merchantPubkey, async () => {
      const inbox = inboxFor(f)
      for (const wrap of wraps)
        await inbox.ingest(wrap, ["wss://relay.conduit.market"])
      const read = await readRetainedCheckoutSparkOrganizerRecoveries({
        inbox,
        marketCoordinate: f.plan.eventMarket!.marketCoordinate,
        shouldContinue: () => f.clock.active,
      })
      expect(read.selections.length).toBe(1)
      expect(read.selections[0]!.buyerProgressWraps.length).toBe(1)
      expect(inbox.getSnapshot().diagnostics.states.machine).toBe(2)
      expect(inbox.getSnapshot().diagnostics.states.malformed ?? 0).toBe(0)
      expect((await inbox.search("checkout_spark")).length).toBe(0)
    })
  }
)

it("reopens retained old-rule malformed recovery after an ordinary owner restart without republishing", async () => {
  const f = await checkoutSparkOrganizerFixture()
  databases.push(f.database)
  const wrap = await withMarketClient(f.buyerSigner.pubkey, () =>
    wrapPrivateMessage(
      buildCheckoutSparkOrganizerRecoveryRumor(f.initial),
      { pubkey: f.organizerPubkey },
      f.buyerSigner,
      { rumorKind: 16 }
    )
  )
  const previousOwner = inboxFor(f)
  await previousOwner.store.receive(wrap, ["wss://relay.conduit.market"])
  const [retained] = await previousOwner.store.wrappers()
  await f.database.commerceInboxWrappers.update(retained!.id, {
    state: "malformed",
    rulesVersion: 4,
    attempts: 3,
  })
  previousOwner.stop()
  const inbox = inboxFor(f)
  const read = await readRetainedCheckoutSparkOrganizerRecoveries({
    inbox,
    marketCoordinate: f.plan.eventMarket!.marketCoordinate,
    shouldContinue: () => f.clock.active,
  })
  expect(read.selections.length).toBe(1)
  const rows = await inbox.store.wrappers()
  expect(rows.length).toBe(1)
  expect(rows[0]!.event.id === wrap.id).toBe(true)
  expect(rows[0]!.state).toBe("machine")
  expect(rows[0]!.rulesVersion).toBe(INBOX_DECODE_RULES_VERSION)
  expect(INBOX_DECODE_RULES_VERSION).toBeGreaterThan(4)
})

it("discovers a genuine free-purchase packet across sender/receiver client configuration", async () => {
  const f = await withMarketClient(
    NDKPrivateKeySigner.generate().pubkey,
    eventMarketFreePurchaseFixture
  )
  databases.push(f.database)
  await withMarketClient(f.merchantPubkey, async () => {
    const inbox = inboxFor(f)
    await inbox.ingest(f.wrap, ["wss://relay.conduit.market"])
    const read = await readRetainedCheckoutSparkOrganizerRecoveries({
      inbox,
      marketCoordinate: f.payload.eventMarket.marketCoordinate,
      shouldContinue: () => f.clock.active,
    })
    expect(read.freeSelections.length).toBe(1)
    expect(read.selections.length).toBe(0)
    expect(inbox.getSnapshot().diagnostics.states.machine).toBe(1)
  })
})

it("keeps exact authority tags, original rumor hash and canonical financial contents mandatory", async () => {
  const f = await checkoutSparkOrganizerFixture()
  databases.push(f.database)
  const rumor = buildCheckoutSparkOrganizerRecoveryRumor(f.initial)
  const required = rumor.tags.filter((tag) => tag[0] !== "client")
  const client = ["client", "Another client"]
  expect(() =>
    parseCheckoutSparkOrganizerRecoveryRumor(
      withTags(rumor, [...required, client])
    )
  ).not.toThrow()
  for (const name of ["p", "type", "order", "checkout", "handoff"]) {
    for (const tags of [
      required.filter((tag) => tag[0] !== name),
      [...required, required.find((tag) => tag[0] === name)!],
      required.map((tag) => (tag[0] === name ? [name, "different"] : tag)),
    ])
      expect(() =>
        parseCheckoutSparkOrganizerRecoveryRumor(withTags(rumor, tags))
      ).toThrow()
  }
  for (const tags of [
    [...required, ["unknown", "not-advisory"]],
    [...required, client, client],
    [...required, ["client"]],
    [...required, ["client", "name", "handler", "relay", "extra"]],
    [...required, ["client", "x".repeat(513)]],
  ])
    expect(() =>
      parseCheckoutSparkOrganizerRecoveryRumor(withTags(rumor, tags))
    ).toThrow()
  expect(() =>
    parseCheckoutSparkOrganizerRecoveryRumor({
      ...rumor,
      tags: [...required, client],
    })
  ).toThrow()
  expect(() =>
    parseCheckoutSparkOrganizerRecoveryRumor({ ...rumor, sig: "unexpected" })
  ).toThrow()
  for (const changed of [
    { ...rumor, pubkey: f.merchantPubkey },
    { ...rumor, kind: 14 },
    { ...rumor, created_at: rumor.created_at! + 1 },
    {
      ...rumor,
      content: JSON.stringify({
        ...f.initial,
        plan: {
          ...f.initial.plan,
          funding: {
            ...f.initial.plan.funding,
            grossFundingSats: f.initial.plan.funding.grossFundingSats + 1,
          },
        },
      }),
    },
  ])
    expect(() =>
      parseCheckoutSparkOrganizerRecoveryRumor(withTags(changed, required))
    ).toThrow()
  const noncanonical = {
    ...rumor,
    content: `${rumor.content} `,
  }
  expect(() =>
    parseCheckoutSparkOrganizerRecoveryRumor(withTags(noncanonical, required))
  ).toThrow()
})

it("admits only advisory client metadata on organizer and Merchant execution packets", async () => {
  const f = await checkoutSparkOrganizerFixture({
    receiverDomain: "wallet.conduit.market",
  })
  databases.push(f.database)
  const credited = recordCheckoutSparkSettledCredit(f.initial.state, {
    requestId: f.plan.funding.requestId,
    paymentHash: f.plan.funding.paymentHash,
    transferId: crypto.randomUUID(),
    receiverIdentityPublicKey: f.plan.funding.receiverIdentityPublicKey,
    grossSats: f.plan.funding.grossFundingSats,
    creditedSats: f.plan.funding.grossFundingSats,
    observedAt: ++f.clock.now,
  })
  const first = f.plan.recipients[0]!
  const receiver = qualifiedReceiverFixture({
    lud16: first.destination.value,
    amountSats: credited.legs[0]!.allocationSats! - 1,
    nowSeconds: Math.floor(f.clock.now / 1000),
  })
  const state = prepareCheckoutSparkSettledLeg(credited, {
    legId: first.legId,
    transferId: deriveCheckoutSparkSettledTransferId(f.plan, first.legId),
    paymentRequest: receiver.paymentRequest,
    paymentHash: receiver.paymentHash,
    invoiceAmountSats: credited.legs[0]!.allocationSats! - 1,
    maxFeeSats: 1,
    receiverBinding: receiver.receiverBinding,
    preparedAt: ++f.clock.now,
  })
  const execution = createCheckoutSparkOrganizerExecutionProgress({
    initialHandoffId: f.initial.handoffId,
    initialMerchantHandoffId: f.initial.merchantHandoffId,
    organizerPubkey: f.organizerPubkey,
    orderBinding: f.initial.orderBinding,
    writerBindings: assertCheckoutSparkOrganizerRecoveryAuthority(f.authority)
      .writerBindings,
    state,
  })
  const merchant = createCheckoutSparkMerchantEventProgress({
    merchantProgress: createCheckoutSparkMerchantProgress({
      initialHandoffId: f.initial.merchantHandoffId,
      state,
    }),
    orderBinding: f.initial.orderBinding,
  })
  const executionRumor = withTags(
    buildCheckoutSparkOrganizerExecutionRumor(execution),
    [
      ...buildCheckoutSparkOrganizerExecutionRumor(execution).tags,
      ["client", "Another client"],
    ]
  )
  const merchantRumor = withTags(
    buildCheckoutSparkMerchantEventProgressRumor(merchant),
    [
      ...buildCheckoutSparkMerchantEventProgressRumor(merchant).tags,
      ["client", "Another client"],
    ]
  )
  const inbox = inboxFor(f)
  await inbox.ingest(f.initialWrap, ["wss://relay.conduit.market"])
  for (const [rumor, signer] of [
    [executionRumor, f.organizerSigner],
    [merchantRumor, f.merchantSigner],
  ] as const)
    await inbox.ingest(
      await wrapPrivateMessage(rumor, { pubkey: f.organizerPubkey }, signer, {
        rumorKind: 16,
      }),
      ["wss://relay.conduit.market"]
    )
  const read = await readRetainedCheckoutSparkOrganizerRecoveries({
    inbox,
    marketCoordinate: f.plan.eventMarket!.marketCoordinate,
    shouldContinue: () => f.clock.active,
  })
  expect(read.selections.length).toBe(1)
  expect(read.selections[0]!.organizerProgressWraps.length).toBe(1)
  expect(read.selections[0]!.merchantProgressWraps.length).toBe(1)
  expect(inbox.getSnapshot().diagnostics.states.machine).toBe(3)
  expect(inbox.getSnapshot().diagnostics.states.malformed ?? 0).toBe(0)
  for (const [rumor, parse] of [
    [
      buildCheckoutSparkOrganizerExecutionRumor(execution),
      parseCheckoutSparkOrganizerExecutionRumor,
    ],
    [
      buildCheckoutSparkMerchantEventProgressRumor(merchant),
      parseCheckoutSparkMerchantEventProgressRumor,
    ],
  ] as const) {
    expect(() =>
      parse(withTags(rumor, [...rumor.tags, ["client", "Another client"]]))
    ).not.toThrow()
    expect(() =>
      parse(withTags(rumor, [...rumor.tags, ["order", "different"]]))
    ).toThrow()
    expect(() =>
      parse(withTags(rumor, [...rumor.tags, ["unknown", "extra"]]))
    ).toThrow()
  }
  const free = await eventMarketFreePurchaseFixture()
  databases.push(free.database)
  const rumor = buildEventMarketFreePurchaseRumor(free.payload)
  const tags = rumor.tags.filter((tag) => tag[0] !== "client")
  expect(() =>
    parseEventMarketFreePurchaseRumor(
      withTags(rumor, [...tags, ["client", "Another client"]])
    )
  ).not.toThrow()
  expect(() =>
    parseEventMarketFreePurchaseRumor(
      withTags(rumor, [...tags, ["handoff", "different"]])
    )
  ).toThrow()
})
