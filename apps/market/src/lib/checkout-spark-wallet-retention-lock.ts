/** Serialize temporary checkout-wallet preparation with registry cleanup. */
let pending: Promise<void> = Promise.resolve()

export async function acquireCheckoutSparkWalletRetentionLock(): Promise<
  () => void
> {
  const prior = pending
  let releaseTurn!: () => void
  pending = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  await prior
  let released = false
  return () => {
    if (released) return
    released = true
    releaseTurn()
  }
}
