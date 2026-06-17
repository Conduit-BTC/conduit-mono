import { afterEach, describe, expect, it } from "bun:test"
import {
  __resetRelayNetworkBudget,
  runWithRelayNetworkBudget,
  snapshotRelayNetworkBudget,
} from "@conduit/core"

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  __resetRelayNetworkBudget()
})

describe("relay network budget", () => {
  it("caps visible marketplace relay work", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<number>())
    const started: number[] = []
    const tasks = gates.map((gate, index) =>
      runWithRelayNetworkBudget(
        async () => {
          started.push(index)
          return await gate.promise
        },
        {
          budgetClass: "visible_marketplace_read",
          relayUrl: `wss://relay-${index}.example`,
        }
      )
    )

    await flushMicrotasks()

    expect(started).toEqual([0, 1, 2, 3, 4])
    expect(snapshotRelayNetworkBudget()).toMatchObject({
      activeGlobal: 5,
      queued: 1,
    })

    gates[0].resolve(0)
    await tasks[0]
    await flushMicrotasks()

    expect(started).toEqual([0, 1, 2, 3, 4, 5])

    for (let index = 1; index < gates.length; index += 1) {
      gates[index].resolve(index)
    }
    await Promise.all(tasks)
  })

  it("allows critical order work to burst ahead of queued visible reads", async () => {
    const visibleGates = Array.from({ length: 6 }, () => deferred<string>())
    const criticalGate = deferred<string>()
    const started: string[] = []
    const visibleTasks = visibleGates.map((gate, index) =>
      runWithRelayNetworkBudget(
        async () => {
          started.push(`visible-${index}`)
          return await gate.promise
        },
        {
          budgetClass: "visible_marketplace_read",
          relayUrl: `wss://visible-${index}.example`,
        }
      )
    )
    const criticalTask = runWithRelayNetworkBudget(
      async () => {
        started.push("critical")
        return await criticalGate.promise
      },
      {
        budgetClass: "critical_order_write",
        relayUrl: "wss://critical.example",
      }
    )

    await flushMicrotasks()
    expect(started).toEqual([
      "visible-0",
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "critical",
    ])

    visibleGates[0].resolve("visible-0")
    await visibleTasks[0]
    await flushMicrotasks()

    expect(started).toEqual([
      "visible-0",
      "visible-1",
      "visible-2",
      "visible-3",
      "visible-4",
      "critical",
      "visible-5",
    ])

    criticalGate.resolve("critical")
    visibleGates[5].resolve("visible-5")
    for (let index = 1; index < 5; index += 1) {
      visibleGates[index].resolve(`visible-${index}`)
    }
    await Promise.all([...visibleTasks, criticalTask])
  })

  it("serializes work for the same relay", async () => {
    const firstGate = deferred<string>()
    const secondGate = deferred<string>()
    const started: string[] = []

    const first = runWithRelayNetworkBudget(
      async () => {
        started.push("first")
        return await firstGate.promise
      },
      {
        budgetClass: "interactive_detail",
        relayUrl: "wss://shared.example",
      }
    )
    const second = runWithRelayNetworkBudget(
      async () => {
        started.push("second")
        return await secondGate.promise
      },
      {
        budgetClass: "interactive_detail",
        relayUrl: "wss://shared.example",
      }
    )

    await flushMicrotasks()

    expect(started).toEqual(["first"])
    expect(snapshotRelayNetworkBudget()).toMatchObject({
      activeGlobal: 1,
      queued: 1,
    })

    firstGate.resolve("first")
    await first
    await flushMicrotasks()

    expect(started).toEqual(["first", "second"])

    secondGate.resolve("second")
    await second
  })
})
