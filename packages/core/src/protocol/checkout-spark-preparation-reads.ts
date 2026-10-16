/**
 * Independent, read-only checkout preparation work. Keep the original order,
 * stop admitting queued reads on failure/revocation, and drain started reads
 * before returning so a retry cannot overlap this preparation's remaining work.
 */
export async function mapCheckoutSparkPreparationReads<T, TResult>(
  values: readonly T[],
  assertCurrent: () => void,
  read: (value: T) => Promise<TResult>
): Promise<TResult[]> {
  assertCurrent()
  const results = new Array<TResult>(values.length)
  let next = 0
  let failed = false
  let failure: unknown
  const worker = async () => {
    while (!failed && next < values.length) {
      const index = next++
      try {
        assertCurrent()
        const result = await read(values[index]!)
        assertCurrent()
        results[index] = result
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, worker))
  if (failed) throw failure
  assertCurrent()
  return results
}
