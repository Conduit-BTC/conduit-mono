import { randomUUID } from "node:crypto"
import path from "node:path"

import { expect, test } from "@playwright/test"

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
