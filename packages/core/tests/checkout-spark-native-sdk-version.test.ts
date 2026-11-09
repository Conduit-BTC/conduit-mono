import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { getPublicKey } from "nostr-tools"
import { encodeSparkAddress } from "@buildonspark/spark-sdk"
import corePackage from "../package.json"
import marketPackage from "../../../apps/market/package.json"
import merchantPackage from "../../../apps/merchant/package.json"
import { loadFirstPartySparkModule } from "../src/wallets/spark-sdk"
import {
  CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY,
  createCheckoutSparkNativeTreasurySdkAdapter,
  getCheckoutSparkNativeTreasuryPolicyForSdkVersion,
  prepareCheckoutSparkNativeTreasuryRequest,
  type CheckoutSparkNativeTreasurySdkTransfer,
} from "../src/protocol/checkout-spark-treasury-sdk"

function installedSdkVersion(location: URL): string {
  let directory = dirname(
    createRequire(location).resolve("@buildonspark/spark-sdk")
  )
  for (;;) {
    const manifestPath = join(directory, "package.json")
    if (existsSync(manifestPath)) {
      const artifact = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name: string
        version: string
      }
      if (artifact.name === "@buildonspark/spark-sdk") return artifact.version
    }
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error("Resolved Spark SDK package manifest not found")
    directory = parent
  }
}

test("the installed Spark SDK retains reviewed native fee capability", async () => {
  const manifests = [
    [corePackage, new URL("../package.json", import.meta.url)],
    [
      marketPackage,
      new URL("../../../apps/market/package.json", import.meta.url),
    ],
    [
      merchantPackage,
      new URL("../../../apps/merchant/package.json", import.meta.url),
    ],
  ] as const
  for (const [manifest, location] of manifests) {
    // Check the resolved artifact as well as the declared pin, without relying
    // on the SDK exposing its package.json through its public export map.
    expect(installedSdkVersion(location)).toBe(
      manifest.dependencies["@buildonspark/spark-sdk"]
    )
    expect(
      getCheckoutSparkNativeTreasuryPolicyForSdkVersion(
        manifest.dependencies["@buildonspark/spark-sdk"]
      )
    ).toBe(CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY)
  }
  expect((await loadFirstPartySparkModule()).nativeTreasuryPolicy).toBe(
    CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY
  )
  for (const version of ["0.13.0", "0.14.0"])
    expect(getCheckoutSparkNativeTreasuryPolicyForSdkVersion(version)).toBe(
      CHECKOUT_SPARK_NATIVE_TREASURY_ZERO_FEE_POLICY
    )
  for (const version of ["0.15.0", "^0.14.0", "0.14.1", undefined])
    expect(
      getCheckoutSparkNativeTreasuryPolicyForSdkVersion(version)
    ).toBeUndefined()
})

test("installed native adapter preserves exact debit and offline-receiver proof", async () => {
  // Real installed public codecs; all wallet operations below are in-memory.
  const codec = await loadFirstPartySparkModule()
  const sender = `02${getPublicKey(new Uint8Array(32).fill(1))}`
  const receiver = `02${getPublicKey(new Uint8Array(32).fill(2))}`
  const transferId = "11111111-1111-4111-8111-111111111111"
  const nativeTreasury = prepareCheckoutSparkNativeTreasuryRequest(codec, {
    network: "mainnet",
    sparkAddress: encodeSparkAddress({
      identityPublicKey: receiver,
      network: "MAINNET",
    }),
    senderIdentityPublicKey: sender,
    invoiceId: "22222222-2222-4222-8222-222222222222",
  })
  const request = {
    network: "mainnet" as const,
    nativeTreasury,
    amountSats: 3,
    authorizedDebitSats: 3,
  }
  let fulfilled = false
  let sendCalls = 0
  let queryCalls = 0
  let available = 3n
  const transfer: CheckoutSparkNativeTreasurySdkTransfer = {
    id: transferId,
    status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED",
    type: "TRANSFER",
    transferDirection: "OUTGOING",
    totalValue: 3,
    valueSentByWallet: 3,
    valueReceivedByWallet: 0,
    sparkInvoice: nativeTreasury.invoiceRequest,
    senders: [{ identityPublicKey: sender }],
    receivers: [
      {
        identityPublicKey: receiver,
        amountSats: 3,
        status: "TRANSFER_RECEIVER_STATUS_CLAIM_PENDING",
      },
    ],
  }
  const wallet = {
    getIdentityPublicKey: async () => sender,
    getBalance: async () => ({
      satsBalance: { available, owned: available, incoming: 0n },
    }),
    querySparkInvoices: async (invoices: string[]) => {
      queryCalls++
      expect(invoices).toEqual([nativeTreasury.invoiceRequest])
      return {
        invoiceStatuses: [
          {
            invoice: nativeTreasury.invoiceRequest,
            status: fulfilled ? 2 : 0,
            ...(fulfilled
              ? {
                  transferType: {
                    $case: "satsTransfer" as const,
                    satsTransfer: {
                      transferId: codec.parseTransferId(transferId).bytes,
                    },
                  },
                }
              : {}),
          },
        ],
      }
    },
    getTransfer: async (id: string) => {
      expect(id).toBe(transferId)
      return transfer
    },
    fulfillSparkInvoice: async (invoices: unknown) => {
      sendCalls++
      expect(invoices).toEqual([
        { invoice: nativeTreasury.invoiceRequest, amount: 3n },
      ])
      fulfilled = true
      return {
        satsTransactionSuccess: [
          {
            invoice: nativeTreasury.invoiceRequest,
            transferResponse: transfer,
          },
        ],
        satsTransactionErrors: [],
        tokenTransactionSuccess: [],
        tokenTransactionErrors: [],
        invalidInvoices: [],
      }
    },
  }
  const input = {
    wallet,
    codec,
    network: "MAINNET" as const,
    read: <T>(read: () => Promise<T>) => read(),
  }
  const adapter = createCheckoutSparkNativeTreasurySdkAdapter(input)
  expect(await adapter.inspectCheckoutTreasury(request)).toMatchObject({
    status: "not_found",
  })
  // A dedicated checkout wallet must account for its entire approved remainder.
  available = 4n
  expect(await adapter.preflightCheckoutTreasury(request)).toBe("unavailable")
  available = 3n
  expect(await adapter.preflightCheckoutTreasury(request)).toBe("ready")
  expect(
    await adapter.sendCheckoutTreasury({
      ...request,
      priorSendMayHaveOccurred: false,
    })
  ).toEqual({ status: "submitted", providerTransferId: transferId })
  expect(await adapter.inspectCheckoutTreasury(request)).toMatchObject({
    status: "paid",
    finalDebitSats: 3,
    finalFeeSats: 0,
    providerTransferId: transferId,
  })
  expect(sendCalls).toBe(1)

  // Independent history found the committed invoice; do not fulfill it again.
  expect(
    await adapter.sendCheckoutTreasury({
      ...request,
      priorSendMayHaveOccurred: false,
    })
  ).toEqual({ status: "submitted" })
  expect(sendCalls).toBe(1)

  const queriesBefore = queryCalls
  const unsupported = createCheckoutSparkNativeTreasurySdkAdapter({
    ...input,
    codec: {
      ...codec,
      nativeTreasuryPolicy:
        getCheckoutSparkNativeTreasuryPolicyForSdkVersion("0.15.0"),
    },
  })
  expect(await unsupported.inspectCheckoutTreasury(request)).toMatchObject({
    status: "lookup_unavailable",
  })
  expect(
    await unsupported.sendCheckoutTreasury({
      ...request,
      priorSendMayHaveOccurred: false,
    })
  ).toEqual({ status: "ambiguous" })
  expect(queryCalls).toBe(queriesBefore)
  expect(sendCalls).toBe(1)
})
