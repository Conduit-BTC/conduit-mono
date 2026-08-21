import { expect, test } from "@playwright/test"

const marketUrl = `http://127.0.0.1:${
  process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
}`

type StoredOrderDelivery = {
  orderId: string
  orderDeliveryStatus: "pending" | "sent"
  orderRelayDelivery: {
    signedRecipientWrap: {
      id: string
      content: string
    }
    relayDelivery: Array<{
      relayUrl: string
      status: "pending" | "acked" | "timed_out"
    }>
  }
}

test("a staged encrypted order and partial ACK state survive browser restart", async ({
  page,
}) => {
  await page.goto(marketUrl)
  const databaseName = "conduit"
  await page.waitForFunction(async (name) => {
    const databases = await indexedDB.databases()
    return databases.some((database) => database.name === name)
  }, databaseName)
  const orderId = `e2e-order-${Date.now()}`
  const encryptedContent = "encrypted-gift-wrap-only"
  const staged = {
    orderId,
    buyerPubkey: "a".repeat(64),
    buyerIdentityKind: "signed_in",
    merchantPubkey: "b".repeat(64),
    checkoutMode: "pay_later",
    items: [],
    itemSubtotalSats: 1,
    shippingCostSats: 0,
    totalSats: 1,
    totalMsats: 1_000,
    currency: "SATS",
    addressValidity: "not_required",
    shippingZoneEligibility: "not_required",
    orderDeliveryStatus: "pending",
    orderDeliveryRoute: "declared_inbox",
    orderRelayDelivery: {
      signedRecipientWrap: {
        id: "c".repeat(64),
        pubkey: "d".repeat(64),
        created_at: 1_700_000_000,
        kind: 1059,
        tags: [["p", "b".repeat(64)]],
        content: encryptedContent,
        sig: "e".repeat(128),
      },
      route: "declared_inbox",
      relayDelivery: [
        {
          relayUrl: "wss://one.conduit.market",
          source: "declared",
          status: "pending",
          attemptCount: 0,
        },
        {
          relayUrl: "wss://two.conduit.market",
          source: "declared",
          status: "pending",
          attemptCount: 0,
        },
      ],
      deliveryAttemptCount: 0,
      retryCount: 0,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 86_400_000,
    },
    invoiceStatus: "not_requested",
    paymentStatus: "not_started",
    proofDeliveryStatus: "not_started",
    zapReceiptStatus: "not_applicable",
    phase: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  const writeRecord = async (record: unknown) => {
    await page.evaluate(
      async ({ databaseName, value }) => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(databaseName)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result
            if (!database.objectStoreNames.contains("orderLifecycles")) {
              database.close()
              reject(new Error("Market lifecycle store is unavailable"))
              return
            }
            const transaction = database.transaction(
              "orderLifecycles",
              "readwrite"
            )
            transaction.objectStore("orderLifecycles").put(value)
            transaction.oncomplete = () => {
              database.close()
              resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
          }
        })
      },
      { databaseName, value: record }
    )
  }

  const readRecord = async (): Promise<StoredOrderDelivery | undefined> =>
    await page.evaluate(
      async ({ databaseName, key }) => {
        return await new Promise<StoredOrderDelivery | undefined>(
          (resolve, reject) => {
            const request = indexedDB.open(databaseName)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
              const database = request.result
              const transaction = database.transaction(
                "orderLifecycles",
                "readonly"
              )
              const get = transaction.objectStore("orderLifecycles").get(key)
              get.onsuccess = () =>
                resolve(get.result as StoredOrderDelivery | undefined)
              get.onerror = () => reject(get.error)
              transaction.oncomplete = () => database.close()
            }
          }
        )
      },
      { databaseName, key: orderId }
    )

  try {
    await writeRecord(staged)
    await page.reload()

    const afterStageRestart = await readRecord()
    expect(afterStageRestart?.orderDeliveryStatus).toBe("pending")
    expect(
      afterStageRestart?.orderRelayDelivery.signedRecipientWrap.content
    ).toBe(encryptedContent)
    expect(
      afterStageRestart?.orderRelayDelivery.relayDelivery.map(
        (target) => target.relayUrl
      )
    ).toEqual(["wss://one.conduit.market", "wss://two.conduit.market"])

    const partial = structuredClone(staged)
    partial.orderDeliveryStatus = "sent"
    partial.orderRelayDelivery.deliveryAttemptCount = 1
    partial.orderRelayDelivery.relayDelivery[0] = {
      ...partial.orderRelayDelivery.relayDelivery[0],
      status: "acked",
      attemptCount: 1,
    }
    partial.orderRelayDelivery.relayDelivery[1] = {
      ...partial.orderRelayDelivery.relayDelivery[1],
      status: "timed_out",
      attemptCount: 1,
    }
    await writeRecord(partial)
    await page.reload()

    const afterPartialRestart = await readRecord()
    expect(afterPartialRestart?.orderRelayDelivery.signedRecipientWrap.id).toBe(
      staged.orderRelayDelivery.signedRecipientWrap.id
    )
    expect(
      afterPartialRestart?.orderRelayDelivery.relayDelivery.map(
        (target) => target.status
      )
    ).toEqual(["acked", "timed_out"])
  } finally {
    await page.evaluate(
      async ({ name, key }) => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(name)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const database = request.result
            const transaction = database.transaction(
              "orderLifecycles",
              "readwrite"
            )
            transaction.objectStore("orderLifecycles").delete(key)
            transaction.oncomplete = () => {
              database.close()
              resolve()
            }
            transaction.onerror = () => reject(transaction.error)
            transaction.onabort = () => reject(transaction.error)
          }
        })
      },
      { name: databaseName, key: orderId }
    )
  }
})
