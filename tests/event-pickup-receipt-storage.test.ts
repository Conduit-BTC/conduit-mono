import { afterEach, describe, expect, spyOn, test } from "bun:test"
import Dexie from "dexie"
import { indexedDB, IDBKeyRange } from "fake-indexeddb"
import { ConduitDB } from "@conduit/core/db"
import { createEventGuestReceipt } from "@conduit/core/protocol/event-guest-checkout"
import { createEventPickupReceiptRepository } from "@conduit/core/protocol/event-pickup-receipt-storage"

const databases: ConduitDB[] = []
const DAY = 24 * 60 * 60 * 1_000

function fixture() {
  const database = new ConduitDB(
    `event-pickup-receipt-${crypto.randomUUID()}`,
    { indexedDB, IDBKeyRange }
  )
  databases.push(database)
  let now = 1_000
  const buyerScope = { kind: "guest" as const }
  const receipt = createEventGuestReceipt("a".repeat(64))
  const input = {
    receipt,
    buyerScope,
    occurrenceCoordinate: `31922:${"b".repeat(64)}:selected-day`,
    occurrenceEnd: 100_000,
  }
  return {
    database,
    input,
    buyerScope,
    setNow(value: number) {
      now = value
    },
    repository: () =>
      createEventPickupReceiptRepository({ database, now: () => now }),
  }
}

afterEach(async () => {
  for (const database of databases.splice(0)) await database.delete()
})

describe("private event pickup receipt retention", () => {
  test("a saved receipt reloads without a guest signing key until the selected event end plus one day", async () => {
    const state = fixture()
    const saved = await state.repository().save(state.input)
    expect(saved.expiresAt).toBe(state.input.occurrenceEnd + DAY)
    state.database.close()
    await state.database.open()
    const restored = await state
      .repository()
      .load(state.input.receipt.orderId, state.buyerScope)
    expect(
      restored?.receipt.claimSecret === state.input.receipt.claimSecret
    ).toBe(true)
    expect(restored?.occurrenceCoordinate).toBe(
      state.input.occurrenceCoordinate
    )
  })

  test("saving again keeps the original receipt and retention snapshot instead of extending it", async () => {
    const state = fixture()
    const saved = await state.repository().save(state.input)
    state.setNow(2_000)
    const repeated = await state.repository().save(state.input)
    expect(repeated.createdAt).toBe(saved.createdAt)
    expect(repeated.expiresAt).toBe(saved.expiresAt)
    await expect(
      state.repository().save({
        ...state.input,
        occurrenceEnd: state.input.occurrenceEnd + DAY,
      })
    ).rejects.toThrow("does not match")
    const restored = await state
      .repository()
      .load(saved.orderId, state.buyerScope)
    expect(restored?.receipt.claimSecret === saved.receipt.claimSecret).toBe(
      true
    )
    expect(restored?.expiresAt).toBe(saved.expiresAt)
  })

  test("Delete survives reopening and a stale tab cannot restore the removed capability", async () => {
    const state = fixture()
    await state.repository().save(state.input)
    await state
      .repository()
      .remove(state.input.receipt.orderId, state.buyerScope)
    state.database.close()
    await state.database.open()
    expect(
      await state
        .repository()
        .load(state.input.receipt.orderId, state.buyerScope)
    ).toBeNull()
    await expect(state.repository().save(state.input)).rejects.toThrow(
      "deleted"
    )
    await state
      .repository()
      .remove(state.input.receipt.orderId, state.buyerScope)
  })

  test("expiry is exclusive at exactly one day after the selected end and cleanup cannot restore it", async () => {
    const state = fixture()
    await state.repository().save(state.input)
    state.setNow(state.input.occurrenceEnd + DAY - 1)
    expect(
      (await state
        .repository()
        .load(state.input.receipt.orderId, state.buyerScope)) !== null
    ).toBe(true)
    state.setNow(state.input.occurrenceEnd + DAY)
    expect(
      await state
        .repository()
        .load(state.input.receipt.orderId, state.buyerScope)
    ).toBeNull()
    await expect(state.repository().save(state.input)).rejects.toThrow(
      "expired"
    )
    expect(await state.repository().pruneExpired()).toBe(0)
    expect(await state.repository().list(state.buyerScope)).toEqual([])
  })

  test("a session change during persistence does not expose a late receipt to the replacement session", async () => {
    const state = fixture()
    let current = true
    const repository = createEventPickupReceiptRepository({
      database: state.database,
      now: () => 1_000,
      assertCurrent: () => {
        if (!current) throw new Error("Scope changed")
      },
    })
    const put = state.database.eventPickupReceipts.put.bind(
      state.database.eventPickupReceipts
    )
    const write = spyOn(
      state.database.eventPickupReceipts,
      "put"
    ).mockImplementation(async (...parameters) => {
      const key = await put(...parameters)
      current = false
      return key
    })
    try {
      await expect(repository.save(state.input)).rejects.toThrow(
        "session changed"
      )
    } finally {
      write.mockRestore()
    }
    current = true
    const restored = await repository.load(
      state.input.receipt.orderId,
      state.buyerScope
    )
    expect(
      restored?.receipt.claimSecret === state.input.receipt.claimSecret
    ).toBe(true)
  })

  test("guest and signed-in receipt lists stay scoped without granting guest signing recovery", async () => {
    const state = fixture()
    const signedIn = { kind: "signed_in" as const, pubkey: "c".repeat(64) }
    const another = { kind: "signed_in" as const, pubkey: "d".repeat(64) }
    await state.repository().save(state.input)
    const accountReceipt = createEventGuestReceipt(
      state.input.receipt.merchantPubkey
    )
    await state
      .repository()
      .save({ ...state.input, receipt: accountReceipt, buyerScope: signedIn })
    expect((await state.repository().list(state.buyerScope)).length).toBe(1)
    expect((await state.repository().list(signedIn)).length).toBe(1)
    expect(await state.repository().list(another)).toEqual([])
    expect(
      await state.repository().load(accountReceipt.orderId, state.buyerScope)
    ).toBeNull()
    await expect(
      state.repository().remove(accountReceipt.orderId, another)
    ).rejects.toThrow("does not match")
    expect(
      (await state.repository().load(accountReceipt.orderId, signedIn)) !== null
    ).toBe(true)
  })

  test("another receipt, merchant or occurrence cannot replace an existing order binding", async () => {
    const state = fixture()
    await state.repository().save(state.input)
    const other = createEventGuestReceipt(state.input.receipt.merchantPubkey)
    await expect(
      state.repository().save({
        ...state.input,
        receipt: { ...other, orderId: state.input.receipt.orderId },
      })
    ).rejects.toThrow("does not match")
    await expect(
      state.repository().save({
        ...state.input,
        receipt: { ...state.input.receipt, merchantPubkey: "c".repeat(64) },
      })
    ).rejects.toThrow("does not match")
    await expect(
      state.repository().save({
        ...state.input,
        occurrenceCoordinate: `31922:${"b".repeat(64)}:another-day`,
      })
    ).rejects.toThrow("does not match")
    const restored = await state
      .repository()
      .load(state.input.receipt.orderId, state.buyerScope)
    expect(
      restored?.receipt.claimSecret === state.input.receipt.claimSecret
    ).toBe(true)
  })

  test("concurrent identical saves converge, while conflicting saves cannot both win", async () => {
    const state = fixture()
    await Promise.all([
      state.repository().save(state.input),
      state.repository().save(state.input),
    ])
    const changed = {
      ...state.input,
      occurrenceEnd: state.input.occurrenceEnd + 1,
    }
    const outcomes = await Promise.allSettled([
      state.repository().save(state.input),
      state.repository().save(changed),
    ])
    expect(outcomes.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ])
    expect((await state.repository().list(state.buyerScope)).length).toBe(1)
  })

  test("a rejected storage write is not reported saved and never exposes its raw error", async () => {
    const state = fixture()
    const write = spyOn(
      state.database.eventPickupReceipts,
      "put"
    ).mockRejectedValue(new Error(state.input.receipt.claimSecret))
    try {
      await expect(state.repository().save(state.input)).rejects.toThrow(
        "storage is unavailable"
      )
    } finally {
      write.mockRestore()
    }
    expect(
      await state
        .repository()
        .load(state.input.receipt.orderId, state.buyerScope)
    ).toBeNull()
  })

  test("a silently dropped write fails readback instead of promising browser recovery", async () => {
    const state = fixture()
    const write = spyOn(
      state.database.eventPickupReceipts,
      "put"
    ).mockResolvedValue(state.input.receipt.orderId)
    try {
      await expect(state.repository().save(state.input)).rejects.toThrow(
        "storage is unavailable"
      )
    } finally {
      write.mockRestore()
    }
    expect(await state.repository().list(state.buyerScope)).toEqual([])
  })

  test("failed Delete remains a visible failure and preserves the previously saved receipt", async () => {
    const state = fixture()
    await state.repository().save(state.input)
    const write = spyOn(
      state.database.eventPickupReceipts,
      "put"
    ).mockRejectedValue(new Error("Unavailable"))
    try {
      await expect(
        state.repository().remove(state.input.receipt.orderId, state.buyerScope)
      ).rejects.toThrow("storage is unavailable")
    } finally {
      write.mockRestore()
    }
    const restored = await state
      .repository()
      .load(state.input.receipt.orderId, state.buyerScope)
    expect(
      restored?.receipt.claimSecret === state.input.receipt.claimSecret
    ).toBe(true)
  })

  test("Delete actually removes the secret bytes; only its bounded replay barrier remains", async () => {
    const state = fixture()
    await state.repository().save(state.input)
    await state
      .repository()
      .remove(state.input.receipt.orderId, state.buyerScope)
    // At-rest inspection is necessary: hiding a receipt in the public reader
    // would not establish that Delete removed the private capability itself.
    const raw = await state.database.eventPickupReceipts.get(
      state.input.receipt.orderId
    )
    expect(JSON.stringify(raw).includes(state.input.receipt.claimSecret)).toBe(
      false
    )
    state.setNow(state.input.occurrenceEnd + DAY)
    expect(await state.repository().pruneExpired()).toBe(1)
    expect(await state.repository().pruneExpired()).toBe(0)
  })

  test("receipt storage rejects invalid or overflowing expiry metadata without saving it", async () => {
    const state = fixture()
    for (const occurrenceEnd of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(
        state.repository().save({ ...state.input, occurrenceEnd })
      ).rejects.toThrow("invalid")
    }
    await expect(
      state
        .repository()
        .save({ ...state.input, occurrenceCoordinate: "not-an-event" })
    ).rejects.toThrow("invalid")
    expect(await state.repository().list(state.buyerScope)).toEqual([])
  })

  test("receipt-only recovery survives beyond the guest session without retaining a signing capability", async () => {
    const state = fixture()
    await state.repository().save({ ...state.input, occurrenceEnd: 7 * DAY })
    state.setNow(2 * DAY)
    const restored = await state
      .repository()
      .load(state.input.receipt.orderId, state.buyerScope)
    expect(
      restored?.receipt.claimSecret === state.input.receipt.claimSecret
    ).toBe(true)
    expect(Object.keys(restored ?? {}).sort()).toEqual(
      [
        "createdAt",
        "expiresAt",
        "merchantPubkey",
        "occurrenceCoordinate",
        "occurrenceEnd",
        "orderId",
        "owner",
        "receipt",
        "schemaVersion",
      ].sort()
    )
    expect(Object.keys(restored?.receipt ?? {}).sort()).toEqual(
      ["claimSecret", "format", "merchantPubkey", "orderId", "version"].sort()
    )
  })

  test("silently failed Delete is not reported successful", async () => {
    const state = fixture()
    await state.repository().save(state.input)
    const write = spyOn(
      state.database.eventPickupReceipts,
      "put"
    ).mockResolvedValue(state.input.receipt.orderId)
    try {
      await expect(
        state.repository().remove(state.input.receipt.orderId, state.buyerScope)
      ).rejects.toThrow("storage is unavailable")
    } finally {
      write.mockRestore()
    }
    expect(
      (await state
        .repository()
        .load(state.input.receipt.orderId, state.buyerScope)) !== null
    ).toBe(true)
  })

  test("an unavailable browser database cannot report a receipt saved", async () => {
    const database = new ConduitDB(
      `unavailable-receipt-${crypto.randomUUID()}`,
      {
        indexedDB: undefined,
        IDBKeyRange,
      }
    )
    const state = fixture()
    try {
      await expect(
        createEventPickupReceiptRepository({ database, now: () => 1_000 }).save(
          state.input
        )
      ).rejects.toThrow("storage is unavailable")
    } finally {
      database.close()
    }
  })

  test("an unavailable database settles receipt observation as failure instead of leaving readiness pending", async () => {
    const database = new ConduitDB(
      `unavailable-receipt-observer-${crypto.randomUUID()}`,
      { indexedDB: undefined, IDBKeyRange }
    )
    let unsubscribe = () => {}
    let privateResults = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Receipt observation did not settle.")),
          1_000
        )
        unsubscribe = createEventPickupReceiptRepository({ database }).observe(
          { buyerScope: { kind: "guest" } },
          () => {
            privateResults += 1
            reject(new Error("Unavailable storage returned receipt data."))
          },
          resolve
        )
      })
      expect(privateResults).toBe(0)
    } finally {
      if (timer) clearTimeout(timer)
      unsubscribe()
      database.close()
    }
  })

  test("version 31 installed data survives the additive receipt store upgrade", async () => {
    const state = fixture()
    const schemas = Object.fromEntries(
      state.database.tables
        .filter((table) => table.name !== "eventPickupReceipts")
        .map((table) => [
          table.name,
          [
            table.schema.primKey.src,
            ...table.schema.indexes.map((index) => index.src),
          ].join(", "),
        ])
    )
    const old = new Dexie(state.database.name, { indexedDB, IDBKeyRange })
    old.version(31).stores(schemas)
    const retained = new Map<string, object>()
    try {
      await old.open()
      for (const table of old.tables) {
        const primary = table.schema.primKey.name
        const row = {
          [primary]: `${table.name}-retained`,
          marker: "before-receipt-upgrade",
        }
        retained.set(table.name, row)
        await table.put(row)
      }
    } finally {
      old.close()
    }
    await state.database.open()
    expect(state.database.verno).toBe(32)
    for (const [name, row] of retained) {
      const table = state.database.table(name)
      expect(
        JSON.stringify(
          await table.get(
            (row as Record<string, string>)[table.schema.primKey.name]!
          )
        ) === JSON.stringify(row)
      ).toBe(true)
    }
    await state.repository().save(state.input)
    expect(
      (await state
        .repository()
        .load(state.input.receipt.orderId, state.buyerScope)) !== null
    ).toBe(true)
  })
})
