import { describe, expect, it } from "bun:test"
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure"
import { v2 } from "nostr-tools/nip44"
import { addressRequestsDTag } from "../packages/core/src/wallets/spark-recovery-address"
import {
  SPARK_RECOVERY_KIND,
  SPARK_RECOVERY_PREFIX,
  SPARK_MAIN_D_TAG,
  sparkRecoveryChoiceDTag,
  validateSparkRecoveryEvent,
} from "../packages/core/src/wallets/spark-recovery-contract"
import {
  mergeSparkRecoveryRecords,
  SPARK_RECOVERY_RENDEZVOUS,
  validateSparkRecoveryState,
  type SparkRecoveryRecord,
  type SparkRecoveryState,
} from "../packages/core/src/wallets/spark-recovery-service"

function fixture() {
  const secret = generateSecretKey()
  const owner = getPublicKey(secret)
  const createdAt = Math.floor(Date.now() / 1000)
  const record = (
    address = SPARK_RECOVERY_PREFIX + crypto.randomUUID()
  ): SparkRecoveryRecord => ({
    event: finalizeEvent(
      {
        kind: SPARK_RECOVERY_KIND,
        created_at: createdAt,
        tags: [["d", address]],
        // Encrypted disposable data, never a wallet seed or account credential.
        content: v2.encrypt(
          "conduit.spark.validation.v1:" + crypto.randomUUID(),
          v2.utils.getConversationKey(secret, owner)
        ),
      },
      secret
    ),
    targets: SPARK_RECOVERY_RENDEZVOUS.map((target) => ({ ...target })),
    delivery: SPARK_RECOVERY_RENDEZVOUS.map((target) => ({
      url: target.url,
      status: "pending",
      accepted: false,
      readBack: false,
      lastRead: "not_queried",
      checkedAt: 0,
    })),
    exported: false,
  })
  const state = (records: SparkRecoveryRecord[]): SparkRecoveryState => ({
    ownerPubkey: owner,
    unresolvedObserved: false,
    records,
    removedWalletIds: [crypto.randomUUID()],
    registryExcludedWalletIds: [crypto.randomUUID()],
  })
  return { owner, record, state }
}

describe("Spark recovery owned validation snapshots", () => {
  it("detaches event and state outputs from ordinary caller mutation", () => {
    const f = fixture()
    const input = f.state([f.record()])
    const event = validateSparkRecoveryEvent(input.records[0].event, f.owner)
    const saved = validateSparkRecoveryState(input, f.owner)
    const expectedEvent = JSON.stringify(event)
    const expectedState = JSON.stringify(saved)
    input.records[0].event.tags[0][1] = "changed"
    input.records[0].targets[0].url = "wss://changed.invalid"
    input.records[0].delivery[0].accepted = true
    input.records[0].exported = true
    input.removedWalletIds![0] = "changed"
    input.registryExcludedWalletIds![0] = "changed"
    input.unresolvedObserved = true
    input.records.length = 0
    // Boolean comparisons keep ciphertext and generated identities out of failures.
    expect(JSON.stringify(event) === expectedEvent).toBe(true)
    expect(JSON.stringify(saved) === expectedState).toBe(true)
  })

  it("detaches merged evidence from both inputs and does not mutate either input", () => {
    const f = fixture()
    const current = f.state([f.record()])
    const walletId = crypto.randomUUID()
    current.walletNameSync = {
      mainnet: {
        pending: {
          [walletId]: {
            name: "Pending local label",
            token: crypto.randomUUID(),
          },
        },
      },
    }
    const requestEvent = f.record(addressRequestsDTag("mainnet")).event
    current.addressRequestSync = {
      mainnet: {
        observed: requestEvent,
        operation: {
          event: structuredClone(requestEvent),
          targets: ["wss://relay.conduit.market"],
        },
      },
    }
    const incoming = [f.record()]
    const currentBefore = JSON.stringify(current)
    const incomingBefore = JSON.stringify(incoming)
    const result = mergeSparkRecoveryRecords(current, incoming, true)
    expect(
      JSON.stringify(result.walletNameSync) ===
        JSON.stringify(current.walletNameSync)
    ).toBe(true)
    expect(
      JSON.stringify(result.addressRequestSync) ===
        JSON.stringify(current.addressRequestSync)
    ).toBe(true)
    expect(JSON.stringify(current) === currentBefore).toBe(true)
    expect(JSON.stringify(incoming) === incomingBefore).toBe(true)
    const resultBefore = JSON.stringify(result)
    current.records[0].event.tags[0][1] = "changed"
    current.removedWalletIds![0] = "changed"
    current.registryExcludedWalletIds![0] = "changed"
    current.records[0].delivery[0].accepted = true
    current.walletNameSync.mainnet!.pending[walletId].name = "Changed label"
    current.addressRequestSync.mainnet!.observed!.tags[0][1] = "changed"
    current.addressRequestSync.mainnet!.operation!.targets[0] =
      "wss://changed.invalid"
    incoming[0].targets[0].url = "wss://changed.invalid"
    incoming[0].delivery[0].readBack = true
    incoming[0].event.tags.length = 0
    incoming.length = 0
    expect(JSON.stringify(result) === resultBefore).toBe(true)
    expect(result.unresolvedObserved).toBe(true)
  })

  for (const checkedAt of [9, 10, 11]) {
    it(
      "keeps monotonic evidence with delivery update time " + checkedAt,
      () => {
        const f = fixture()
        const old = f.record()
        old.exported = true
        Object.assign(old.delivery[0], {
          checkedAt: 10,
          status: "acked",
          lastRead: "present",
          accepted: true,
        })
        const update = structuredClone(old)
        update.exported = false
        Object.assign(update.delivery[0], {
          checkedAt,
          status: "rejected",
          lastRead: "absent",
          accepted: false,
          readBack: true,
        })
        const current = f.state([old])
        current.unresolvedObserved = true
        const result = mergeSparkRecoveryRecords(current, [update])
        const evidence = result.records[0].delivery[0]
        expect(evidence.status).toBe(checkedAt >= 10 ? "rejected" : "acked")
        expect(evidence.lastRead).toBe(checkedAt >= 10 ? "absent" : "present")
        expect(evidence.checkedAt).toBe(Math.max(10, checkedAt))
        expect(evidence.accepted).toBe(true)
        expect(evidence.readBack).toBe(true)
        expect(result.records[0].exported).toBe(true)
        expect(result.unresolvedObserved).toBe(true)
      }
    )
  }

  for (const source of ["current", "incoming"] as const) {
    it("rejects duplicate event IDs in the " + source + " input", () => {
      const f = fixture()
      const record = f.record()
      const duplicate = [record, structuredClone(record)]
      expect(() =>
        mergeSparkRecoveryRecords(
          f.state(source === "current" ? duplicate : []),
          source === "incoming" ? duplicate : []
        )
      ).toThrow("invalid_record")
    })
  }

  it("rejects different valid target plans for the same signed event", () => {
    const f = fixture()
    const old = f.record()
    const update = structuredClone(old)
    update.targets[0].url += "/"
    update.delivery[0].url = update.targets[0].url
    expect(() => mergeSparkRecoveryRecords(f.state([old]), [update])).toThrow(
      "conflict"
    )
  })

  for (const category of ["backup", "legacy"] as const) {
    it(
      "enforces the combined " +
        category +
        " budget after merging valid inputs",
      () => {
        const f = fixture()
        const records = Array.from({ length: 129 }, () =>
          category === "legacy" ? f.record(SPARK_MAIN_D_TAG) : f.record()
        )
        const current = f.state(records.slice(0, 128))
        const incoming = records.slice(128)
        expect(
          validateSparkRecoveryState(current, f.owner).records.length
        ).toBe(128)
        expect(
          validateSparkRecoveryState(f.state(incoming), f.owner).records.length
        ).toBe(1)
        expect(() => mergeSparkRecoveryRecords(current, incoming)).toThrow(
          "invalid_record"
        )
      }
    )
  }

  it("validates losing scoped revisions before compacting choices", () => {
    const f = fixture()
    const first = f.record(sparkRecoveryChoiceDTag("main", "mainnet"))
    const second = f.record(sparkRecoveryChoiceDTag("main", "mainnet"))
    const winner = first.event.id < second.event.id ? first : second
    const loser = winner === first ? second : first
    // Ordinary malformed signed bytes must not disappear behind the frontier.
    loser.event.created_at--
    expect(() =>
      mergeSparkRecoveryRecords(f.state([first, second]), [])
    ).toThrow("invalid_record")
  })

  it("preserves absent versus explicitly empty local exclusion metadata", () => {
    const f = fixture()
    for (const field of [
      "removedWalletIds",
      "registryExcludedWalletIds",
    ] as const) {
      const absent = f.state([])
      delete absent[field]
      const empty = f.state([])
      empty[field] = []
      expect(field in mergeSparkRecoveryRecords(absent, [])).toBe(false)
      expect(field in mergeSparkRecoveryRecords(empty, [])).toBe(true)
      expect(mergeSparkRecoveryRecords(empty, [])[field]?.length).toBe(0)
    }
  })
})
