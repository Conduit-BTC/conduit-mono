import "fake-indexeddb/auto"

async function main(): Promise<void> {
  const {
    formatGuestCheckoutOrderSmokeFailure,
    parseGuestCheckoutOrderSmokeConfig,
    runGuestCheckoutOrderSmoke,
  } = await import("./guest_checkout_order_runner")
  const { db, disconnectNdk } = await import("@conduit/core")

  try {
    const config = parseGuestCheckoutOrderSmokeConfig()
    await runGuestCheckoutOrderSmoke(config)
    console.log(
      "Guest checkout order smoke passed. The merchant recovered one encrypted guest order. No invoice was requested and no payment was attempted."
    )
  } catch (error) {
    console.error(formatGuestCheckoutOrderSmokeFailure(error))
    process.exitCode = 1
  } finally {
    disconnectNdk()
    db.close()
  }
}

if (import.meta.main) await main()
