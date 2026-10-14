import { expect, it } from "bun:test"
import { createRuntimeMnemonic } from "./support/runtime-wallet-fixtures"
import { createHash } from "node:crypto"
import { FirstPartySparkSdkFactory } from "../apps/market/src/lib/spark-sdk"
import { deriveMerchantCheckoutSparkRecoveryIdentity } from "../apps/merchant/src/lib/checkout-spark-settled-recovery"
import { createHermeticSparkNative } from "../e2e/helpers/hermetic-spark-native"
import { collectCheckoutSparkNativeRetirementEvidence } from "../packages/core/src/protocol/checkout-spark-native-retirement"
import {
  bolt11PaymentHashField,
  bolt11PlainDescriptionField,
} from "./support/bolt11-fixture"
import {
  bolt11PaymentSecretField,
  makeSignedBolt11Fixture,
} from "./support/signed-bolt11-fixture"

const NOW = 1_800_000_000_000
const WALLET_ID = "offline-native-checkout"
// Runtime-generated recovery material, retained only within this fixture.
const MNEMONIC = createRuntimeMnemonic()

function invoice(amountSats: number, preimage: Uint8Array): string {
  return makeSignedBolt11Fixture({
    hrp: `lnbcrt${amountSats * 10}n`,
    createdAt: NOW / 1_000,
    fields: [
      bolt11PaymentHashField(createHash("sha256").update(preimage).digest()),
      bolt11PaymentSecretField(),
      bolt11PlainDescriptionField("Offline restored wallet fixture"),
      { tag: "x", words: [28, 4] },
    ],
  })
}

it("restores native payment evidence without replay and waits for the last payout before terminal retirement evidence", async () => {
  const fixture = createHermeticSparkNative({
    deriveIdentity: deriveMerchantCheckoutSparkRecoveryIdentity,
    issueFundingInvoice: async ({ amountSats }) =>
      invoice(amountSats, new Uint8Array(32).fill(61)),
  })
  const createFactory = () =>
    new FirstPartySparkSdkFactory({
      network: "regtest",
      loadModule: async () => fixture.module,
      now: () => NOW,
      wait: async () => {},
    })
  const credentials = { mnemonic: MNEMONIC, accountNumber: 0 }
  const buyer = await createFactory().open({
    ...credentials,
    walletId: WALLET_ID,
  })
  const identity = await deriveMerchantCheckoutSparkRecoveryIdentity(
    MNEMONIC,
    0
  )
  const control = fixture.control.forIdentity(identity)
  const firstPreimage = new Uint8Array(32).fill(62)
  const firstPayout = {
    transferId: "d39d4111-f12e-4d3f-8da4-bd659ee28e50",
    network: "regtest" as const,
    paymentRequest: invoice(700, firstPreimage),
    amountSats: 700,
    maxFeeSats: 2,
    completionTimeoutSecs: 0,
  }
  control.registerPayout({
    paymentRequest: firstPayout.paymentRequest,
    preimage: Buffer.from(firstPreimage).toString("hex"),
    feeSats: 2,
  })
  const receive = await buyer.createCheckoutReceive!({
    receiveMode: "ordinary_settled_v3",
    description: "Offline native recovery",
    requiredNetSats: 1_003,
    grossFundingSats: 1_003,
    expirySecs: 900,
  })
  let fundingTransferId: string
  try {
    control.completeFunding()
    const credit = await buyer.attestCheckoutReceiveCredit!(receive)
    if (!credit) throw new Error("Offline funding credit was not verified")
    fundingTransferId = credit.transferId
    expect(
      await buyer.sendCheckoutLightningObligation!(firstPayout)
    ).toMatchObject({
      status: "paid",
    })
    expect((await buyer.getFundsState!()).availableSats).toBe(301)
  } finally {
    await buyer.disconnect()
  }

  // A new adapter instance and fresh authenticated reader get their evidence
  // from the native fixture, not from the disconnected buyer's client state.
  const restored = await createFactory().open({
    ...credentials,
    walletId: WALLET_ID,
  })
  const native = await fixture.openAuthenticatedRetirementReader({
    ...credentials,
    network: "regtest",
  })
  const retirementInput = {
    authenticatedReader: native.reader,
    walletId: WALLET_ID,
    network: "regtest" as const,
    sparkAddress: native.sparkAddress,
    stateUpdatedAt: NOW,
    expectedTransferIds: [fundingTransferId, firstPayout.transferId],
    now: () => NOW + 1,
  }
  try {
    expect(await restored.attestCheckoutReceiveCredit!(receive)).toMatchObject({
      transferId: fundingTransferId,
      creditedSats: 1_003,
    })
    expect(await restored.reconcileLightningSend!(firstPayout)).toMatchObject({
      status: "resolved",
      verifiedTransferTotalSats: 702,
    })
    expect(
      await restored.sendCheckoutLightningObligation!(firstPayout)
    ).toMatchObject({
      status: "paid",
    })
    expect(control.snapshot()).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 1,
      outgoingPaymentCount: 1,
      debitedSats: 702,
    })
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(retirementInput)
    ).toBeNull()

    const lastPreimage = new Uint8Array(32).fill(63)
    const lastPayout = {
      ...firstPayout,
      transferId: "b6b68255-263e-4c51-9c2d-1b3252a354bd",
      paymentRequest: invoice(300, lastPreimage),
      amountSats: 300,
      maxFeeSats: 1,
    }
    control.registerPayout({
      paymentRequest: lastPayout.paymentRequest,
      preimage: Buffer.from(lastPreimage).toString("hex"),
      feeSats: 1,
    })
    expect(
      await restored.sendCheckoutLightningObligation!(lastPayout)
    ).toMatchObject({
      status: "paid",
    })
    expect(await restored.reconcileLightningSend!(lastPayout)).toMatchObject({
      status: "resolved",
      verifiedTransferTotalSats: 301,
    })
    retirementInput.expectedTransferIds.push(lastPayout.transferId)
    expect(control.snapshot()).toEqual({
      fundingInvoiceCount: 1,
      sendInvocationCount: 2,
      outgoingPaymentCount: 2,
      debitedSats: 1_003,
    })
    expect((await restored.getFundsState!()).availableSats).toBe(0)
    expect(
      await collectCheckoutSparkNativeRetirementEvidence(retirementInput)
    ).toMatchObject({
      walletId: WALLET_ID,
      network: "regtest",
      availableSats: 0,
      ownedSats: 0,
      incomingSats: 0,
      fundingReceiveTerminal: true,
      sendHistoryTerminal: true,
    })
  } finally {
    await native.cleanup()
    await restored.disconnect()
  }
  expect(
    await collectCheckoutSparkNativeRetirementEvidence(retirementInput)
  ).toBeNull()
})
