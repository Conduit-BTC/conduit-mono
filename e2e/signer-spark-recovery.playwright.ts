import { expect, test } from "@playwright/test"
import {
  createRuntimeSignerIdentity,
  disposeRuntimeSignerIdentity,
  installRealTestSigner,
} from "./helpers/real-nip07-signer"

// Recovery material must not enter screenshots, traces, videos or assertion output.
test.use({ trace: "off", screenshot: "off", video: "off" })
test("signer Spark recovery survives fresh browser storage and account revocation @market", async ({
  page,
}) => {
  const identity = createRuntimeSignerIdentity()
  const port = process.env.PLAYWRIGHT_MARKET_PORT ?? "7000"
  await installRealTestSigner(
    page,
    identity,
    `ws://127.0.0.1:${process.env.PLAYWRIGHT_RELAY_PORT}`
  )
  try {
    await page.goto(`http://127.0.0.1:${port}/products`)
    await expect(page.getByLabel("Open account menu")).toBeVisible({
      timeout: 15000,
    })
    const result = await page.evaluate(async (root) => {
      const core = await import(`${root}/packages/core/src/index.ts`)
      const provider = await import(`${root}/apps/market/src/lib/spark-sdk.ts`)
      const databaseModule = await import(
        `${root}/packages/core/src/db/index.ts`
      )
      const sessionModule = await import(
        `${root}/packages/core/src/protocol/session-signer.ts`
      )
      const signer = sessionModule.getAccountSigner()
      if (!signer) throw new Error("E2E_ACCOUNT_SESSION_MISSING")
      const source = new databaseModule.ConduitDB(
        `recovery-source-${crypto.randomUUID()}`
      )
      const fresh = new databaseModule.ConduitDB(
        `recovery-fresh-${crypto.randomUUID()}`
      )
      const relayRecords = new Map()
      const unavailable = core.SPARK_RECOVERY_RENDEZVOUS[2].url
      const transport = {
        async publish(
          url: string,
          event: { id: string },
          shouldContinue: () => boolean
        ) {
          if (!shouldContinue()) return "cancelled"
          if (url === unavailable) return "timed_out"
          const records = relayRecords.get(url) ?? new Map()
          records.set(event.id, structuredClone(event))
          relayRecords.set(url, records)
          return "acked"
        },
        async read(url: string, _owner: string, eventId?: string) {
          return {
            status: url === unavailable ? "unavailable" : "complete",
            events: [...(relayRecords.get(url)?.values() ?? [])].filter(
              (event) => !eventId || event.id === eventId
            ),
          }
        },
      }
      const createService = (
        db: InstanceType<typeof databaseModule.ConduitDB>
      ) =>
        new core.SparkRecoveryService({
          signer,
          store: new core.DexieSparkRecoveryStore(db),
          transport,
          deriveIdentity: provider.deriveSparkRecoveryIdentity,
        })
      try {
        const bundle = {
          mnemonic: core.generateSparkMnemonic(),
          accountNumber: 1,
          network: "mainnet",
        }
        const expected = await provider.deriveSparkRecoveryIdentity(bundle)
        const first = createService(source)
        const backup = await first.prepare(bundle)
        const pointerId = await first.preparePrimary(backup)
        const delivery = await first.deliver(backup.eventId)
        await first.deliver(pointerId)
        const restore = createService(fresh)
        const discovery = await restore.discover()
        const recovered = await restore.restore(discovery.primary)
        const sameIdentity =
          (await provider.deriveSparkRecoveryIdentity(recovered)) === expected
        const stored = JSON.stringify(
          await fresh.sparkRecoveryEvidence.toArray()
        )
        const noPlaintext =
          !stored.includes(bundle.mnemonic) && !stored.includes(expected)
        sessionModule.retireAccountSigner(signer)
        let staleRejected = false
        try {
          await restore.restore(discovery.primary)
        } catch (error) {
          staleRejected =
            !!error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "authority_changed"
        }
        return {
          sameIdentity,
          noPlaintext,
          staleRejected,
          ready: delivery.ready,
          independentCopies: delivery.independentCopies,
          partial: discovery.coverage === "partial",
          noDuplicate: !discovery.creationEligible,
        }
      } finally {
        await source.delete()
        await fresh.delete()
      }
    }, `/@fs${process.cwd()}`)
    expect(result).toEqual({
      sameIdentity: true,
      noPlaintext: true,
      staleRejected: true,
      ready: true,
      independentCopies: 2,
      partial: true,
      noDuplicate: true,
    })
  } finally {
    disposeRuntimeSignerIdentity(identity)
  }
})
