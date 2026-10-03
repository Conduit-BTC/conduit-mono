import { expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { createHash } from "node:crypto"
import { FirstPartySparkSdkFactory } from "../apps/market/src/lib/spark-sdk"
import { SparkWalletManager } from "../apps/market/src/lib/spark-wallet"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { deriveMerchantCheckoutSparkRecoveryIdentity } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const MNEMONIC = createRuntimeMnemonic()
const OTHER_MNEMONIC = createRuntimeMnemonic()

function signedInvoice(
  amountSats: number,
  preimage: Uint8Array,
  network: "mainnet" | "regtest" = "regtest"
): string {
  return makeSignedBolt11Fixture({
    hrp: `${network === "mainnet" ? "lnbc" : "lnbcrt"}${amountSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(createHash("sha256").update(preimage).digest()),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField("Synthetic offline router fixture"),
      { tag: "x", words: [28, 4] },
    ],
  })
}

it("shares native state across concurrent sessions without reopening a closed handle", async () => {
  const fixture = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      signedInvoice(amountSats, new Uint8Array(32).fill(45)),
  })
  const credentials = {
    mnemonicOrSeed: MNEMONIC,
    accountNumber: 0,
    options: { network: "REGTEST" as const, log: false as const },
  }
  const [first, second] = await Promise.all([
    fixture.module.initialize(credentials),
    fixture.module.initialize(credentials),
  ])
  expect(first.wallet === second.wallet).toBe(false)
  const receive = await first.wallet.createLightningInvoice({ amountSats: 100 })
  const identity = await first.wallet.getIdentityPublicKey()
  fixture.control.forIdentity(identity).completeFunding()
  await first.wallet.cleanup()
  await expect(first.wallet.getBalance()).rejects.toThrow("closed")
  expect((await second.wallet.getBalance()).balance).toBe(100n)
  expect(
    await second.wallet.getLightningReceiveRequest(receive.id)
  ).toMatchObject({
    id: receive.id,
    status: "TRANSFER_COMPLETED",
  })
  await second.wallet.cleanup()
  const reopened = await fixture.module.initialize(credentials)
  try {
    expect((await reopened.wallet.getBalance()).balance).toBe(100n)
    expect(
      await reopened.wallet.getLightningReceiveRequest(receive.id)
    ).toMatchObject({ id: receive.id })
    fixture.control.forIdentity(identity).completeFunding()
    expect((await reopened.wallet.getBalance()).balance).toBe(100n)
  } finally {
    await reopened.wallet.cleanup()
  }
})

it("derives independent native identities from the exact mnemonic and account", async () => {
  const fixture = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      signedInvoice(amountSats, new Uint8Array(32).fill(44)),
  })
  const identities: string[] = []
  for (const [mnemonic, accountNumber] of [
    [MNEMONIC, 0],
    [OTHER_MNEMONIC, 0],
    [MNEMONIC, 1],
  ] as const) {
    const { wallet } = await fixture.module.initialize({
      mnemonicOrSeed: mnemonic,
      accountNumber,
      options: { network: "REGTEST", log: false },
    })
    try {
      const identity = await wallet.getIdentityPublicKey()
      expect(
        identity ===
          (await deriveMerchantCheckoutSparkRecoveryIdentity(
            mnemonic,
            accountNumber
          ))
      ).toBe(true)
      identities.push(identity)
    } finally {
      await wallet.cleanup()
    }
  }
  expect(new Set(identities).size).toBe(3)
})

it("keeps funded accounts' native receive IDs, transfer IDs and addresses isolated", async () => {
  let invoiceNumber = 50
  const fixture = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      signedInvoice(amountSats, new Uint8Array(32).fill(invoiceNumber++)),
  })
  const sessions = await Promise.all(
    [
      [MNEMONIC, 0],
      [OTHER_MNEMONIC, 0],
      [MNEMONIC, 1],
    ].map(async ([mnemonicOrSeed, accountNumber]) =>
      fixture.module.initialize({
        mnemonicOrSeed: String(mnemonicOrSeed),
        accountNumber: Number(accountNumber),
        options: { network: "REGTEST", log: false },
      })
    )
  )
  try {
    const receives = []
    const transferIds = []
    const addresses = []
    for (const { wallet } of sessions) {
      const receive = await wallet.createLightningInvoice({ amountSats: 100 })
      fixture.control
        .forIdentity(await wallet.getIdentityPublicKey())
        .completeFunding()
      receives.push(receive)
      transferIds.push(
        (await wallet.getLightningReceiveRequest(receive.id))!.transfer!
          .sparkId!
      )
      addresses.push(await wallet.getSparkAddress())
    }
    expect(new Set(receives.map((receive) => receive.id)).size).toBe(3)
    expect(new Set(transferIds).size).toBe(3)
    expect(new Set(addresses).size).toBe(3)
    for (const { wallet } of sessions.slice(1)) {
      expect(
        await wallet.getLightningReceiveRequest(receives[0]!.id)
      ).toBeNull()
      expect(await wallet.getTransfer(transferIds[0]!)).toBeUndefined()
      expect((await wallet.getBalance()).balance).toBe(100n)
    }
  } finally {
    await Promise.all(sessions.map(({ wallet }) => wallet.cleanup()))
  }
})

it("reserves funding once across concurrent native clients", async () => {
  let invoicesIssued = 0
  const fixture = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) => {
      invoicesIssued += 1
      await Promise.resolve()
      return signedInvoice(amountSats, new Uint8Array(32).fill(46))
    },
  })
  const sessions = await Promise.all(
    [0, 1].map(() =>
      fixture.module.initialize({
        mnemonicOrSeed: MNEMONIC,
        accountNumber: 0,
        options: { network: "REGTEST", log: false },
      })
    )
  )
  try {
    const outcomes = await Promise.allSettled(
      sessions.map(({ wallet }) =>
        wallet.createLightningInvoice({ amountSats: 100 })
      )
    )
    expect(
      outcomes.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(invoicesIssued).toBe(1)
    const control = fixture.control.forIdentity(
      await sessions[0]!.wallet.getIdentityPublicKey()
    )
    control.completeFunding()
    control.completeFunding()
    expect((await sessions[1]!.wallet.getBalance()).balance).toBe(100n)
    expect(control.snapshot().fundingInvoiceCount).toBe(1)
  } finally {
    await Promise.all(sessions.map(({ wallet }) => wallet.cleanup()))
  }
})

it("authenticates independent retirement readers and reads fresh native funds and pending records", async () => {
  const fixture = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      signedInvoice(amountSats, new Uint8Array(32).fill(47)),
  })
  const credentials = {
    mnemonic: MNEMONIC,
    accountNumber: 0,
    network: "regtest" as const,
  }
  const first = await fixture.openAuthenticatedRetirementReader(credentials)
  const second = await fixture.openAuthenticatedRetirementReader(credentials)
  const wrong = await fixture.openAuthenticatedRetirementReader({
    ...credentials,
    accountNumber: 1,
  })
  const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
    MNEMONIC,
    0
  )
  const control = fixture.control.forIdentity(identity)
  const { wallet } = await fixture.module.initialize({
    mnemonicOrSeed: MNEMONIC,
    accountNumber: 0,
    options: { network: "REGTEST", log: false },
  })
  try {
    expect(await first.reader.getAvailableBalance(first.sparkAddress)).toBe(0n)
    const receive = await wallet.createLightningInvoice({ amountSats: 100 })
    control.completeFunding()
    const fundingId = (await wallet.getLightningReceiveRequest(receive.id))!
      .transfer!.sparkId!
    expect(await first.reader.getAvailableBalance(first.sparkAddress)).toBe(
      100n
    )
    expect(await second.reader.getOwnedBalance(second.sparkAddress)).toBe(100n)
    expect(
      await first.reader.getTransfers({
        sparkAddress: first.sparkAddress,
        types: [0, 1, 2, 3, 4, 5, 30, 40],
        limit: 10,
        offset: 0,
      })
    ).toMatchObject({
      transfers: [{ id: fundingId, status: 5, network: 2, totalValue: 100 }],
      offset: -1,
    })
    const pending = [
      {
        id: "synthetic-pending",
        type: 0,
        status: 1,
        network: 2,
        totalValue: 5,
      },
    ]
    control.setPendingTransfers(pending)
    control.setAdditionalOwnedSats(7)
    expect(
      await second.reader.getPendingTransfers(second.sparkAddress)
    ).toEqual(pending)
    expect(await second.reader.getOwnedBalance(second.sparkAddress)).toBe(107n)
    expect(await second.reader.getAvailableBalance(second.sparkAddress)).toBe(
      100n
    )
    pending[0]!.totalValue = 999
    expect(
      (await first.reader.getPendingTransfers(first.sparkAddress))[0]!
        .totalValue
    ).toBe(5)
    control.setPendingTransfers([])
    control.setAdditionalOwnedSats(0)
    expect(await first.reader.getPendingTransfers(first.sparkAddress)).toEqual(
      []
    )
    expect(await first.reader.getOwnedBalance(first.sparkAddress)).toBe(100n)
    await expect(
      wrong.reader.getOwnedBalance(first.sparkAddress)
    ).rejects.toThrow()
    expect(await wrong.reader.getAvailableBalance(wrong.sparkAddress)).toBe(0n)
    await first.cleanup()
    await expect(
      first.reader.getOwnedBalance(first.sparkAddress)
    ).rejects.toThrow("closed")
    expect(await second.reader.getOwnedBalance(second.sparkAddress)).toBe(100n)
  } finally {
    await Promise.all([
      first.cleanup(),
      second.cleanup(),
      wrong.cleanup(),
      wallet.cleanup(),
    ])
  }
})

it("rejects non-regtest clients and readers before credential derivation or invoice issuance", async () => {
  let deriveCalls = 0
  let invoiceCalls = 0
  const fixture = createHermeticSparkNative({
    deriveIdentity: async (mnemonic, accountNumber) => {
      deriveCalls += 1
      return deriveMerchantCheckoutSparkRecoveryIdentity(
        mnemonic,
        accountNumber
      )
    },
    issueFundingInvoice: async () => {
      invoiceCalls += 1
      throw new Error("Must not issue")
    },
  })
  await expect(
    fixture.module.initialize({
      mnemonicOrSeed: MNEMONIC,
      accountNumber: 0,
      options: { network: "MAINNET", log: false },
    })
  ).rejects.toThrow()
  await expect(
    fixture.openAuthenticatedRetirementReader({
      mnemonic: MNEMONIC,
      accountNumber: 0,
      network: "mainnet",
    })
  ).rejects.toThrow()
  expect(() =>
    fixture.module.createPublicReadonlyClient({
      network: "MAINNET",
      log: false,
    })
  ).toThrow()
  expect(deriveCalls).toBe(0)
  expect(invoiceCalls).toBe(0)
})

it("keeps an explicitly configured mainnet fixture closed to other networks", async () => {
  let deriveCalls = 0
  const fixture = createHermeticSparkNative({
    network: "mainnet",
    deriveIdentity: async () => {
      deriveCalls += 1
      throw new Error("Must not derive")
    },
    issueFundingInvoice: async () => {
      throw new Error("Must not issue")
    },
  })
  for (const [network, nativeNetwork] of [
    ["regtest", "REGTEST"],
    ["testnet", "TESTNET"],
    ["signet", "SIGNET"],
  ] as const) {
    await expect(
      fixture.module.initialize({
        mnemonicOrSeed: MNEMONIC,
        accountNumber: 0,
        options: { network: nativeNetwork, log: false },
      })
    ).rejects.toThrow()
    await expect(
      fixture.openAuthenticatedRetirementReader({
        mnemonic: MNEMONIC,
        accountNumber: 0,
        network,
      })
    ).rejects.toThrow()
    expect(() =>
      fixture.module.createPublicReadonlyClient({
        network: nativeNetwork,
        log: false,
      })
    ).toThrow()
  }
  expect(deriveCalls).toBe(0)
})

it("routes synthetic mainnet funding and one exact outgoing payment through the real manager", async () => {
  const fixture = createHermeticSparkNative({
    network: "mainnet",
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      signedInvoice(amountSats, new Uint8Array(32).fill(51), "mainnet"),
  })
  const manager = new SparkWalletManager(
    new FirstPartySparkSdkFactory({
      network: "mainnet",
      loadModule: async () => fixture.module,
      now: () => NOW,
      wait: async () => {},
    }),
    async () => ({ release: async () => {} }),
    undefined,
    () => NOW
  )
  const walletId = `hermetic-mainnet-${crypto.randomUUID()}`
  await manager.openWithMnemonic({
    walletId,
    mnemonic: MNEMONIC,
    accountNumber: 0,
  })
  const reader = await fixture.openAuthenticatedRetirementReader({
    mnemonic: MNEMONIC,
    accountNumber: 0,
    network: "mainnet",
  })
  try {
    const receive = await manager.createCheckoutReceive(walletId, {
      receiveMode: "ordinary_settled_v3",
      description: "Offline funding",
      requiredNetSats: 100,
      grossFundingSats: 100,
      expirySecs: 900,
    })
    expect(receive.network).toBe("mainnet")
    expect(receive.id.startsWith("hermetic-funding-receive:mainnet:")).toBe(
      true
    )
    expect(
      await manager.attestCheckoutReceiveCredit(walletId, receive)
    ).toBeNull()
    const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
      MNEMONIC,
      0
    )
    const control = fixture.control.forIdentity(identity)
    control.completeFunding()
    expect(
      await manager.attestCheckoutReceiveCredit(walletId, receive)
    ).toMatchObject({
      creditedSats: 100,
    })
    const preimage = new Uint8Array(32).fill(52)
    const payout = {
      paymentRequest: signedInvoice(99, preimage, "mainnet"),
      preimage: Buffer.from(preimage).toString("hex"),
      feeSats: 1,
    }
    expect(() =>
      control.registerPayout({
        ...payout,
        paymentRequest: signedInvoice(99, preimage),
      })
    ).toThrow()
    control.registerPayout(payout)
    expect(() =>
      control.setPendingTransfers([
        {
          id: "synthetic-wrong-network",
          type: 0,
          status: 1,
          network: 2,
          totalValue: 1,
        },
      ])
    ).toThrow()
    const target = {
      transferId: "a5b78e44-a4f0-4c5d-a2da-1e04dbf7d813",
      network: "mainnet" as const,
      paymentRequest: payout.paymentRequest,
      amountSats: 99,
      maxFeeSats: 1,
      completionTimeoutSecs: 0,
    }
    expect(
      await manager.preflightCheckoutLightningObligation(walletId, target)
    ).toBe("ready")
    expect(
      await manager.sendCheckoutLightningObligation(walletId, target)
    ).toMatchObject({
      status: "paid",
    })
    expect((await manager.getFundsState(walletId)).availableSats).toBe(0)
    const history = await reader.reader.getTransfers({
      sparkAddress: reader.sparkAddress,
      types: [0],
      limit: 10,
      offset: 0,
    })
    expect(history.transfers).toHaveLength(2)
    expect(
      history.transfers.every(
        (transfer) => transfer.network === 1 && transfer.status === 5
      )
    ).toBe(true)
    expect(control.snapshot()).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 1,
      outgoingPaymentCount: 1,
      debitedSats: 100,
    })
  } finally {
    await reader.cleanup()
    await manager.close(walletId)
  }
})

it("credits one funding invoice only after its completed native receive and transfer agree", async () => {
  const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
    MNEMONIC,
    0
  )
  const fixture = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      signedInvoice(amountSats, new Uint8Array(32).fill(41)),
  })
  const factory = new FirstPartySparkSdkFactory({
    network: "regtest",
    loadModule: async () => fixture.module,
    now: () => NOW,
    wait: async () => {},
  })
  const client = await factory.open({
    walletId: "hermetic-checkout",
    mnemonic: MNEMONIC,
    accountNumber: 0,
  })
  try {
    const receive = await client.createCheckoutReceive!({
      receiveMode: "ordinary_settled_v3",
      description: "Offline funding",
      requiredNetSats: 1_003,
      grossFundingSats: 1_003,
      expirySecs: 900,
    })
    expect(receive.receiveSettledPolicy).toBe("ordinary-exact-credit-v3")
    expect(receive.receiverIdentityPublicKey === identity).toBe(true)
    expect(await client.attestCheckoutReceiveCredit!(receive)).toBeNull()
    expect((await client.getFundsState!()).availableSats).toBe(0)

    const control = fixture.control.forIdentity(identity)
    control.completeFunding()
    const proof = await client.attestCheckoutReceiveCredit!(receive)
    expect(proof).toMatchObject({
      mode: "ordinary_v3",
      requestId: receive.id,
      receiverIdentityPublicKey: identity,
      grossSats: 1_003,
      creditedSats: 1_003,
    })
    expect(proof?.transferId).toBeTruthy()
    expect((await client.getFundsState!()).availableSats).toBe(1_003)
    control.completeFunding()
    expect(await client.attestCheckoutReceiveCredit!(receive)).toEqual(proof)
    expect((await client.getFundsState!()).availableSats).toBe(1_003)
    expect(control.snapshot().fundingInvoiceCount).toBe(1)
  } finally {
    await client.disconnect()
  }
})

it("counts repeated native send invocations separately from idempotent economic payments", async () => {
  const fixture = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      signedInvoice(amountSats, new Uint8Array(32).fill(48)),
  })
  const { wallet } = await fixture.module.initialize({
    mnemonicOrSeed: MNEMONIC,
    accountNumber: 0,
    options: { network: "REGTEST", log: false },
  })
  try {
    const control = fixture.control.forIdentity(
      await wallet.getIdentityPublicKey()
    )
    await wallet.createLightningInvoice({ amountSats: 100 })
    control.completeFunding()
    const preimage = new Uint8Array(32).fill(49)
    const paymentRequest = signedInvoice(99, preimage)
    control.registerPayout({
      paymentRequest,
      preimage: Buffer.from(preimage).toString("hex"),
      feeSats: 1,
    })
    const request = {
      invoice: paymentRequest,
      maxFeeSats: 1,
      preferSpark: false,
      transferId: fixture.module.parseTransferId(
        "c4452dd2-185a-470c-b9d4-45693379c085"
      ),
    }
    await wallet.payLightningInvoice(request)
    await wallet.payLightningInvoice(request)
    expect(control.snapshot()).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 2,
      outgoingPaymentCount: 1,
      debitedSats: 100,
    })
    expect((await wallet.getBalance()).balance).toBe(0n)
  } finally {
    await wallet.cleanup()
  }
})

it("pays one exact payout from native history and does not debit it again on retry", async () => {
  const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
    MNEMONIC,
    0
  )
  const fixture = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      signedInvoice(amountSats, new Uint8Array(32).fill(42)),
  })
  const factory = new FirstPartySparkSdkFactory({
    network: "regtest",
    loadModule: async () => fixture.module,
    now: () => NOW,
    wait: async () => {},
  })
  let client = await factory.open({
    walletId: "hermetic-payout",
    mnemonic: MNEMONIC,
    accountNumber: 0,
  })
  try {
    const receive = await client.createCheckoutReceive!({
      receiveMode: "ordinary_settled_v3",
      description: "Offline funding",
      requiredNetSats: 1_003,
      grossFundingSats: 1_003,
      expirySecs: 900,
    })
    const control = fixture.control.forIdentity(identity)
    control.completeFunding()
    const preimage = new Uint8Array(32).fill(43)
    const paymentRequest = signedInvoice(700, preimage)
    control.registerPayout({
      paymentRequest,
      preimage: Buffer.from(preimage).toString("hex"),
      feeSats: 2,
    })
    expect(control.outgoingInvoices().length).toBe(0)
    const target = {
      transferId: "98a49565-9aca-4a07-a7ae-bf50d24a06e1",
      network: "regtest" as const,
      paymentRequest,
      amountSats: 700,
      maxFeeSats: 3,
      completionTimeoutSecs: 0,
    }
    expect(await client.reconcileLightningSend!(target)).toEqual({
      status: "not_found",
    })
    expect(await client.preflightCheckoutLightningObligation!(target)).toBe(
      "ready"
    )
    expect(await client.sendCheckoutLightningObligation!(target)).toMatchObject(
      {
        status: "paid",
        payment: {
          status: "completed",
          fees: 2n,
          details: {
            htlcDetails: { preimage: Buffer.from(preimage).toString("hex") },
          },
        },
      }
    )
    const history = await client.reconcileLightningSend!(target)
    expect(history).toMatchObject({
      status: "resolved",
      verifiedTransferTotalSats: 702,
    })
    expect((await client.getFundsState!()).availableSats).toBe(301)
    await client.disconnect()
    // No retained adapter instance or factory cache can supply these reads.
    const restoredFactory = new FirstPartySparkSdkFactory({
      network: "regtest",
      loadModule: async () => fixture.module,
      now: () => NOW,
      wait: async () => {},
    })
    client = await restoredFactory.open({
      walletId: "hermetic-payout",
      mnemonic: MNEMONIC,
      accountNumber: 0,
    })
    expect(await client.attestCheckoutReceiveCredit!(receive)).toMatchObject({
      creditedSats: 1_003,
    })
    expect(await client.reconcileLightningSend!(target)).toEqual(history)
    for (const [mnemonic, accountNumber] of [
      [OTHER_MNEMONIC, 0],
      [MNEMONIC, 1],
    ] as const) {
      const unrelated = await restoredFactory.open({
        walletId: "hermetic-payout",
        mnemonic,
        accountNumber,
      })
      try {
        expect(await unrelated.attestCheckoutReceiveCredit!(receive)).toBeNull()
        expect(await unrelated.reconcileLightningSend!(target)).toEqual({
          status: "not_found",
        })
        expect((await unrelated.getFundsState!()).availableSats).toBe(0)
      } finally {
        await unrelated.disconnect()
      }
    }
    expect(await client.sendCheckoutLightningObligation!(target)).toMatchObject(
      { status: "paid" }
    )
    expect(await client.reconcileLightningSend!(target)).toEqual(history)
    expect((await client.getFundsState!()).availableSats).toBe(301)
    expect(control.snapshot()).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 1,
      outgoingPaymentCount: 1,
      debitedSats: 702,
    })
    const invoices = control.outgoingInvoices()
    expect(invoices.length === 1 && invoices[0] === paymentRequest).toBe(true)
    invoices.length = 0
    expect(control.outgoingInvoices().length).toBe(1)
  } finally {
    await client.disconnect()
  }
})
