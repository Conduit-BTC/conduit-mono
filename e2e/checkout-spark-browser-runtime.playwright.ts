import { createHash, randomUUID } from "node:crypto"
import path from "node:path"

import { expect, test } from "@playwright/test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"

import {
  createCheckoutSparkReconciliation,
  freezeCheckoutSparkPlan,
} from "../packages/core/src/protocol/checkout-spark-reconciliation"

const marketUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"}`
const databaseModuleUrl = `/@fs/${path
  .resolve(process.cwd(), "packages/core/src/db/index.ts")
  .replaceAll("\\", "/")}`
const protocolModuleUrl = `/@fs/${path
  .resolve(
    process.cwd(),
    "packages/core/src/protocol/checkout-spark-reconciliation.ts"
  )
  .replaceAll("\\", "/")}`
const repositoryModuleUrl = `/@fs/${path
  .resolve(
    process.cwd(),
    "packages/core/src/protocol/checkout-spark-repository.ts"
  )
  .replaceAll("\\", "/")}`

type LockFixtureWindow = typeof window & {
  releaseCheckoutSparkLock?: () => void
  checkoutSparkLockDone?: Promise<void>
}

test("checkout Spark local recovery stays single-tab and retired across browser reloads @market", async ({
  context,
}) => {
  // Exercise browser storage and Web Locks only. Synthetic observations never
  // reach a Spark SDK, wallet provider, relay, or checkout route.
  const fixtureUrl = `${marketUrl}/__checkout-spark-browser-runtime`
  await context.route(fixtureUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Checkout Spark browser runtime fixture</title>",
    })
  )
  const firstPage = await context.newPage()
  const secondPage = await context.newPage()
  const databaseName = `conduit-checkout-spark-browser-${randomUUID()}`
  const checkoutId = `checkout-${randomUUID()}`

  try {
    await Promise.all([firstPage.goto(fixtureUrl), secondPage.goto(fixtureUrl)])

    const saved = await firstPage.evaluate(
      async ({
        databaseModuleUrl,
        protocolModuleUrl,
        repositoryModuleUrl,
        databaseName,
        checkoutId,
      }) => {
        const { ConduitDB } = (await import(
          databaseModuleUrl
        )) as typeof import("@conduit/core/db")
        const {
          applyCheckoutSparkEvidence,
          createCheckoutSparkReconciliation,
          freezeCheckoutSparkPlan,
        } = (await import(
          protocolModuleUrl
        )) as typeof import("@conduit/core/protocol")
        const { DexieCheckoutSparkRepository } = (await import(
          repositoryModuleUrl
        )) as typeof import("@conduit/core/protocol")
        const database = new ConduitDB(databaseName)
        try {
          const createdAt = Date.now()
          const plan = freezeCheckoutSparkPlan({
            checkoutId,
            orderId: `order-${checkoutId}`,
            merchantPubkey: "a".repeat(64),
            walletId: `wallet-${checkoutId}`,
            network: "mainnet",
            createdAt,
            takeoverAt: createdAt + 120_000,
            funding: {
              requestId: `funding-${checkoutId}`,
              paymentRequest: "synthetic-funding-request",
              paymentHash: "b".repeat(64),
              requiredNetSats: 171,
              grossFundingSats: 180,
              createdAt,
              expiresAt: createdAt + 60_000,
            },
            obligations: [
              {
                kind: "merchant",
                recipientId: "a".repeat(64),
                paymentRequest: "synthetic-merchant-request",
                amountSats: 50,
                maxFeeSats: 5,
              },
              {
                kind: "conduit",
                recipientId: "fixture@pay.invalid",
                paymentRequest: "synthetic-conduit-request",
                amountSats: 111,
                maxFeeSats: 5,
              },
            ],
          })
          const repository = new DexieCheckoutSparkRepository(database)
          await repository.create(plan)
          let state = applyCheckoutSparkEvidence(
            createCheckoutSparkReconciliation(plan),
            {
              type: "funding",
              requestId: plan.funding.requestId,
              paymentRequest: plan.funding.paymentRequest,
              paymentHash: plan.funding.paymentHash,
              walletId: plan.walletId,
              network: plan.network,
              requiredNetSats: plan.funding.requiredNetSats,
              grossFundingSats: plan.funding.grossFundingSats,
              state: "spendable",
              observedAt: createdAt + 1,
            }
          )
          for (const [index, obligation] of plan.obligations.entries()) {
            state = applyCheckoutSparkEvidence(state, {
              type: "obligation",
              obligationId: obligation.obligationId,
              outgoingId: obligation.outgoingId,
              paymentRequest: obligation.paymentRequest,
              amountSats: obligation.amountSats,
              maxFeeSats: obligation.maxFeeSats,
              state: "paid",
              observedAt: createdAt + index + 2,
            })
          }
          const snapshot = await repository.save(state, 1)
          if (snapshot.status !== "active") {
            throw new Error("Synthetic checkout state was not saved")
          }
          return { plan, revision: snapshot.revision }
        } finally {
          database.close()
        }
      },
      {
        databaseModuleUrl,
        protocolModuleUrl,
        repositoryModuleUrl,
        databaseName,
        checkoutId,
      }
    )

    await secondPage.reload()
    const restored = await secondPage.evaluate(
      async ({
        databaseModuleUrl,
        repositoryModuleUrl,
        databaseName,
        checkoutId,
        planDigest,
      }) => {
        const { ConduitDB } = (await import(
          databaseModuleUrl
        )) as typeof import("@conduit/core/db")
        const { DexieCheckoutSparkRepository } = (await import(
          repositoryModuleUrl
        )) as typeof import("@conduit/core/protocol")
        const database = new ConduitDB(databaseName)
        try {
          const snapshot = await new DexieCheckoutSparkRepository(
            database
          ).load(checkoutId, planDigest)
          if (snapshot.status !== "active") return { status: snapshot.status }
          return {
            status: snapshot.status,
            revision: snapshot.revision,
            funding: snapshot.state.funding.state,
            obligations: snapshot.state.obligations.map((item) => item.state),
          }
        } finally {
          database.close()
        }
      },
      {
        databaseModuleUrl,
        repositoryModuleUrl,
        databaseName,
        checkoutId,
        planDigest: saved.plan.planDigest,
      }
    )
    expect(restored).toEqual({
      status: "active",
      revision: saved.revision,
      funding: "spendable",
      obligations: ["paid", "paid"],
    })

    await firstPage.evaluate(
      async ({ protocolModuleUrl, planDigest }) => {
        const { runWithCheckoutSparkMerchantRecoveryLock } = (await import(
          protocolModuleUrl
        )) as typeof import("@conduit/core/protocol")
        const fixtureWindow = window as LockFixtureWindow
        let acquired!: () => void
        const acquiredPromise = new Promise<void>((resolve) => {
          acquired = resolve
        })
        const hold = new Promise<void>((resolve) => {
          fixtureWindow.releaseCheckoutSparkLock = resolve
        })
        const task = runWithCheckoutSparkMerchantRecoveryLock(
          planDigest,
          async () => {
            acquired()
            await hold
          }
        )
        fixtureWindow.checkoutSparkLockDone = task
        await Promise.race([
          acquiredPromise,
          task.then(() => {
            throw new Error(
              "Recovery lock released before the test acquired it"
            )
          }),
        ])
      },
      { protocolModuleUrl, planDigest: saved.plan.planDigest }
    )

    const blocked = await secondPage.evaluate(
      async ({ protocolModuleUrl, planDigest }) => {
        const { runWithCheckoutSparkMerchantRecoveryLock } = (await import(
          protocolModuleUrl
        )) as typeof import("@conduit/core/protocol")
        let entered = false
        try {
          await runWithCheckoutSparkMerchantRecoveryLock(
            planDigest,
            async () => {
              entered = true
            }
          )
          return { entered, error: null }
        } catch (error) {
          return {
            entered,
            error: error instanceof Error ? error.name : String(error),
          }
        }
      },
      { protocolModuleUrl, planDigest: saved.plan.planDigest }
    )
    expect(blocked).toEqual({
      entered: false,
      error: "CheckoutSparkMerchantRecoveryLockUnavailableError",
    })

    await firstPage.evaluate(async () => {
      const fixtureWindow = window as LockFixtureWindow
      fixtureWindow.releaseCheckoutSparkLock?.()
      await fixtureWindow.checkoutSparkLockDone
      delete fixtureWindow.releaseCheckoutSparkLock
      delete fixtureWindow.checkoutSparkLockDone
    })
    const afterRelease = await secondPage.evaluate(
      async ({ protocolModuleUrl, planDigest }) => {
        const { runWithCheckoutSparkMerchantRecoveryLock } = (await import(
          protocolModuleUrl
        )) as typeof import("@conduit/core/protocol")
        return runWithCheckoutSparkMerchantRecoveryLock(
          planDigest,
          async () => "entered"
        )
      },
      { protocolModuleUrl, planDigest: saved.plan.planDigest }
    )
    expect(afterRelease).toBe("entered")

    const tombstone = await firstPage.evaluate(
      async ({
        databaseModuleUrl,
        repositoryModuleUrl,
        databaseName,
        checkoutId,
        planDigest,
      }) => {
        const { ConduitDB } = (await import(
          databaseModuleUrl
        )) as typeof import("@conduit/core/db")
        const { DexieCheckoutSparkRepository } = (await import(
          repositoryModuleUrl
        )) as typeof import("@conduit/core/protocol")
        const database = new ConduitDB(databaseName)
        try {
          const repository = new DexieCheckoutSparkRepository(database)
          const snapshot = await repository.load(checkoutId, planDigest)
          if (snapshot.status !== "active") {
            throw new Error("Synthetic checkout state is no longer active")
          }
          return await repository.retire({
            checkoutId,
            planDigest,
            expectedRevision: snapshot.revision,
            evidence: {
              walletId: snapshot.state.plan.walletId,
              network: snapshot.state.plan.network,
              observedAt: snapshot.state.updatedAt + 1,
              availableSats: 0,
              ownedSats: 0,
              incomingSats: 0,
              fundingReceiveTerminal: true,
              sendHistoryTerminal: true,
              claimsTerminal: true,
              refundsTerminal: true,
            },
          })
        } finally {
          database.close()
        }
      },
      {
        databaseModuleUrl,
        repositoryModuleUrl,
        databaseName,
        checkoutId,
        planDigest: saved.plan.planDigest,
      }
    )
    expect(tombstone.planDigest).toBe(saved.plan.planDigest)

    await secondPage.reload()
    const retired = await secondPage.evaluate(
      async ({
        databaseModuleUrl,
        repositoryModuleUrl,
        databaseName,
        plan,
      }) => {
        const { ConduitDB } = (await import(
          databaseModuleUrl
        )) as typeof import("@conduit/core/db")
        const { DexieCheckoutSparkRepository } = (await import(
          repositoryModuleUrl
        )) as typeof import("@conduit/core/protocol")
        const database = new ConduitDB(databaseName)
        try {
          const repository = new DexieCheckoutSparkRepository(database)
          const snapshot = await repository.load(
            plan.checkoutId,
            plan.planDigest
          )
          let replayError: string | null = null
          try {
            await repository.create(plan)
          } catch (error) {
            replayError = error instanceof Error ? error.name : String(error)
          }
          return { snapshot, replayError }
        } finally {
          database.close()
        }
      },
      { databaseModuleUrl, repositoryModuleUrl, databaseName, plan: saved.plan }
    )
    expect(retired).toEqual({
      snapshot: { status: "retired", tombstone },
      replayError: "CheckoutSparkRepositoryConflictError",
    })
  } finally {
    await firstPage
      .evaluate(async () => {
        const fixtureWindow = window as LockFixtureWindow
        fixtureWindow.releaseCheckoutSparkLock?.()
        await fixtureWindow.checkoutSparkLockDone
      })
      .catch(() => undefined)
    await firstPage
      .evaluate(
        async ({ databaseModuleUrl, databaseName }) => {
          const { ConduitDB } = (await import(
            databaseModuleUrl
          )) as typeof import("@conduit/core/db")
          const database = new ConduitDB(databaseName)
          await database.delete()
        },
        { databaseModuleUrl, databaseName }
      )
      .catch(() => undefined)
  }
})

for (const store of ["preparation", "recovery"] as const) {
  test(`checkout Spark ${store} saves retain concurrent-tab records @market`, async ({
    context,
  }) => {
    const fixtureUrl = `${marketUrl}/__checkout-spark-storage-runtime`
    await context.route(fixtureUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Checkout Spark storage fixture</title>
<script type="module">
  import RefreshRuntime from "/@react-refresh"
  RefreshRuntime.injectIntoGlobalHook(window)
  window.$RefreshReg$ = () => {}
  window.$RefreshSig$ = () => (type) => type
</script>`,
      })
    )
    const firstPage = await context.newPage()
    const secondPage = await context.newPage()
    const storageKey =
      store === "preparation"
        ? "conduit:checkout-spark-router-preparations:v1"
        : "conduit:checkout-spark-recovery-outbox:v1"
    const moduleUrl =
      store === "preparation"
        ? "/src/lib/checkout-spark-router-preparation.ts"
        : "/src/lib/checkout-spark-recovery-handoff.ts"
    const createdAt = Date.now()
    const fixtures = Array.from({ length: 2 }, () => {
      const checkoutId = randomUUID()
      const merchantPubkey = getPublicKey(generateSecretKey())
      const plan = freezeCheckoutSparkPlan({
        checkoutId,
        orderId: `order-${checkoutId}`,
        merchantPubkey,
        walletId: `wallet-${checkoutId}`,
        network: "mainnet",
        createdAt,
        takeoverAt: createdAt + 120_000,
        funding: {
          requestId: `funding-${checkoutId}`,
          paymentRequest: "synthetic-funding-request",
          paymentHash: createHash("sha256").update(randomUUID()).digest("hex"),
          requiredNetSats: 171,
          grossFundingSats: 180,
          createdAt,
          expiresAt: createdAt + 60_000,
        },
        obligations: [
          {
            kind: "merchant",
            recipientId: merchantPubkey,
            paymentRequest: "synthetic-merchant-request",
            amountSats: 50,
            maxFeeSats: 5,
          },
          {
            kind: "conduit",
            recipientId: "fixture@pay.invalid",
            paymentRequest: "synthetic-conduit-request",
            amountSats: 111,
            maxFeeSats: 5,
          },
        ],
      })
      const signedRecipientWrap = finalizeEvent(
        {
          kind: 1059,
          created_at: Math.floor(createdAt / 1_000),
          tags: [["p", merchantPubkey]],
          content: "synthetic-recovery-ciphertext",
        },
        generateSecretKey()
      )
      const record = {
        schemaVersion: 1,
        handoffId: createHash("sha256").update(randomUUID()).digest("hex"),
        rumorId: createHash("sha256").update(randomUUID()).digest("hex"),
        checkoutId,
        orderId: plan.orderId,
        planDigest: plan.planDigest,
        walletId: plan.walletId,
        network: plan.network,
        senderPubkey: getPublicKey(generateSecretKey()),
        merchantPubkey,
        signedRecipientWrap,
        createdAt,
      }
      return {
        preparation: {
          schemaVersion: 1,
          reconciliation: createCheckoutSparkReconciliation(plan),
          recoveryHandoffId: null,
          fundingInvoiceExposedAt: null,
          fundingSubmissionState: "not_started",
          savedAt: createdAt,
        },
        recovery: {
          record,
          deliveryProgress: {
            schemaVersion: 1,
            recipientWrapId: signedRecipientWrap.id,
            acknowledgedRelayRefs: [],
          },
          savedAt: createdAt,
        },
      }
    })
    type StorageFixtureWindow = typeof window & {
      releaseStorageWrite?: () => void
      storageWriteDone?: Promise<void>
      storageWriteFinished?: boolean
    }

    try {
      await Promise.all([
        firstPage.goto(fixtureUrl),
        secondPage.goto(fixtureUrl),
      ])
      await Promise.all(
        [firstPage, secondPage].map((page) =>
          page.waitForFunction(() => "$RefreshReg$" in window)
        )
      )
      // Pause one same-origin writer after reading the shared array. The
      // second tab must wait before reading, writing, and checking durability.
      await firstPage.evaluate(
        async ({ storageKey, first }) => {
          localStorage.removeItem(storageKey)
          const fixtureWindow = window as StorageFixtureWindow
          await new Promise<void>((started) => {
            fixtureWindow.storageWriteDone = navigator.locks.request(
              `conduit:checkout-spark-storage:${storageKey}`,
              async () => {
                const raw = localStorage.getItem(storageKey)
                const previous = raw ? JSON.parse(raw) : []
                const gate = new Promise<void>((release) => {
                  fixtureWindow.releaseStorageWrite = release
                })
                started()
                await gate
                localStorage.setItem(
                  storageKey,
                  JSON.stringify([...previous, first])
                )
              }
            )
          })
        },
        {
          storageKey,
          first:
            store === "preparation"
              ? fixtures[0]!.preparation
              : fixtures[0]!.recovery,
        }
      )
      await secondPage.evaluate(
        async ({ moduleUrl, store, second }) => {
          const module = await import(moduleUrl)
          const fixtureWindow = window as StorageFixtureWindow
          fixtureWindow.storageWriteFinished = false
          const saved =
            store === "preparation"
              ? module.saveCheckoutSparkRouterPreparation(second.preparation)
              : module.saveCheckoutSparkRecoveryDelivery(
                  second.recovery.record,
                  second.recovery.deliveryProgress,
                  undefined,
                  second.recovery.savedAt
                )
          fixtureWindow.storageWriteDone = Promise.resolve(saved).then(() => {
            fixtureWindow.storageWriteFinished = true
          })
        },
        { moduleUrl, store, second: fixtures[1]! }
      )
      const finishedWhileLocked = await secondPage.evaluate(
        () => (window as StorageFixtureWindow).storageWriteFinished
      )
      await firstPage.evaluate(async () => {
        const fixtureWindow = window as StorageFixtureWindow
        fixtureWindow.releaseStorageWrite?.()
        await fixtureWindow.storageWriteDone
      })
      await secondPage.evaluate(
        async () => await (window as StorageFixtureWindow).storageWriteDone
      )
      const retained = await secondPage.evaluate(
        async ({ moduleUrl, store }) => {
          const module = await import(moduleUrl)
          return store === "preparation"
            ? module
                .listCheckoutSparkRouterPreparations()
                .map(
                  (entry: {
                    reconciliation: { plan: { checkoutId: string } }
                  }) => entry.reconciliation.plan.checkoutId
                )
            : module
                .listCheckoutSparkRecoveryDeliveries()
                .map(
                  (entry: {
                    record: { signedRecipientWrap: { id: string } }
                  }) => entry.record.signedRecipientWrap.id
                )
        },
        { moduleUrl, store }
      )
      expect(retained).toHaveLength(2)
      expect(finishedWhileLocked).toBe(false)
      if (store === "recovery") {
        expect(retained).toEqual(
          fixtures.map((entry) => entry.recovery.record.signedRecipientWrap.id)
        )
      }
      const unsupported = await secondPage.evaluate(
        async ({ moduleUrl, store, second }) => {
          const module = await import(moduleUrl)
          let writes = 0
          const storage = {
            getItem: (key: string) => localStorage.getItem(key),
            setItem: () => {
              writes += 1
            },
            removeItem: () => {
              writes += 1
            },
          }
          Object.defineProperty(navigator, "locks", {
            value: undefined,
            configurable: true,
          })
          try {
            if (store === "preparation") {
              await module.saveCheckoutSparkRouterPreparation(
                second.preparation,
                storage
              )
            } else {
              await module.saveCheckoutSparkRecoveryDelivery(
                second.recovery.record,
                second.recovery.deliveryProgress,
                storage,
                second.recovery.savedAt
              )
            }
            return { blocked: false, writes }
          } catch (error) {
            return {
              blocked: (error as Error).message.includes(
                "cannot safely coordinate"
              ),
              writes,
            }
          } finally {
            Reflect.deleteProperty(navigator, "locks")
          }
        },
        { moduleUrl, store, second: fixtures[1]! }
      )
      expect(unsupported).toEqual({ blocked: true, writes: 0 })
    } finally {
      await firstPage.close()
      await secondPage.close()
    }
  })
}
