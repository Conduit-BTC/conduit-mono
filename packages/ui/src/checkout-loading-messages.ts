/** Make a fresh presentation-only bag without changing the original messages. */
export function shuffleLoadingMessages<T>(
  messages: readonly T[],
  random: () => number = Math.random
): T[] {
  const bag = [...messages]
  for (let index = bag.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[bag[index], bag[other]] = [bag[other], bag[index]]
  }
  return bag
}
