export async function awaitOrderDeliveryPresentation<T>(input: {
  now: () => number
  publish: () => Promise<T>
  startedAt: number
  waitForPresentation: () => Promise<void>
}): Promise<{ delivery: T; deliveryLatencyMs: number }> {
  const measuredDelivery = (async () => {
    const delivery = await input.publish()
    return {
      delivery,
      deliveryLatencyMs: Math.max(0, input.now() - input.startedAt),
    }
  })()

  const [result] = await Promise.all([
    measuredDelivery,
    input.waitForPresentation(),
  ])
  return result
}
