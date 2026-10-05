import { expect, it } from "bun:test"

import { shuffleLoadingMessages } from "../apps/market/src/components/checkout-loading-messages"

it("exhausts every message once before the loading bag repeats", () => {
  const messages = Object.freeze(["first", "second", "third", "fourth"])

  for (const random of [0, 0.25, 0.5, 0.999]) {
    const bag = shuffleLoadingMessages(messages, () => random)

    expect(bag).toHaveLength(messages.length)
    expect(new Set(bag).size).toBe(messages.length)
    expect([...bag].sort()).toEqual([...messages].sort())
    expect(bag).not.toBe(messages)
  }
  expect(messages).toEqual(["first", "second", "third", "fourth"])
})

it("keeps empty and single-message bags intact without drawing randomness", () => {
  let draws = 0
  const random = () => {
    draws += 1
    return 0
  }

  expect(shuffleLoadingMessages([], random)).toEqual([])
  expect(shuffleLoadingMessages(["only"], random)).toEqual(["only"])
  expect(draws).toBe(0)
})
