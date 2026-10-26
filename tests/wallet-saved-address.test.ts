import { describe, expect, test } from "bun:test"
import { resolveSparkLightningAddress } from "../packages/core/src/wallets/resolve-spark-lightning-address"
import type { BreezAddressState } from "../packages/core/src/wallets/breez-lightning-address"

const registered = (address: string): BreezAddressState => ({
  status: "registered",
  address,
  username: address.split("@")[0]!,
  lnurl: "lnurl-fixture",
  publicLookup: "verified",
  zapAdvertised: false,
  receiveEvidence: "unverified",
})

describe("saved wallet address selection", () => {
  test("restores selection without opening an unavailable provider session", async () => {
    let calls = 0
    const result = await resolveSparkLightningAddress({
      walletId: "fixture",
      lookupAvailable: false,
      loadSavedAddress: async () => "saved@conduit.cash",
      manager: {
        getLightningAddress: async () => {
          calls++
          throw new Error("Provider cannot open")
        },
      },
      assertCurrent() {},
      onRegistered() {},
    })
    expect(result).toEqual({
      status: "saved",
      address: "saved@conduit.cash",
      availability: "unavailable",
    })
    expect(calls).toBe(0)
  })

  test("provider rejection retains selection and a later success verifies only that address", async () => {
    let fails = true
    const writes: string[] = []
    const input = {
      walletId: "fixture",
      loadSavedAddress: async () => "saved@conduit.cash",
      manager: {
        getLightningAddress: async () => {
          if (fails) throw new Error("Offline")
          return registered("saved@conduit.cash")
        },
      },
      assertCurrent() {},
      onRegistered: (address: string) => writes.push(address),
    }
    expect(await resolveSparkLightningAddress(input)).toMatchObject({
      status: "saved",
      address: "saved@conduit.cash",
    })
    expect(writes).toEqual([])
    fails = false
    expect(await resolveSparkLightningAddress(input)).toEqual(
      registered("saved@conduit.cash")
    )
    expect(writes).toEqual(["saved@conduit.cash"])
  })

  test("retired observations cannot publish preview or queue metadata", async () => {
    const controller = new AbortController()
    let previews = 0,
      writes = 0,
      calls = 0
    await expect(
      resolveSparkLightningAddress({
        walletId: "fixture",
        signal: controller.signal,
        loadSavedAddress: async () => {
          controller.abort()
          return "saved@conduit.cash"
        },
        onSavedAddress: () => previews++,
        manager: {
          getLightningAddress: async () => {
            calls++
            return registered("saved@conduit.cash")
          },
        },
        assertCurrent() {},
        onRegistered: () => writes++,
      })
    ).rejects.toThrow()
    expect({ previews, writes, calls }).toEqual({
      previews: 0,
      writes: 0,
      calls: 0,
    })
  })

  for (const provider of [
    { status: "unavailable", reason: "provider_unavailable" },
    { status: "unavailable", reason: "rate_limited", retryAt: 123456 },
    { status: "absent" },
    registered("other@conduit.cash"),
    { ...registered("saved@conduit.cash"), publicLookup: "unavailable" },
  ] as BreezAddressState[])
    test(`retains saved selection through ${JSON.stringify(provider)}`, async () => {
      const calls: unknown[] = []
      const writes: string[] = []
      const previews: unknown[] = []
      const result = await resolveSparkLightningAddress({
        walletId: "fixture",
        loadSavedAddress: async () => "saved@conduit.cash",
        onSavedAddress: (state) => previews.push(state),
        manager: {
          getLightningAddress: async (...args) => {
            calls.push(args)
            expect(previews).toEqual([
              {
                status: "saved",
                address: "saved@conduit.cash",
                availability: "checking",
              },
            ])
            return provider
          },
        },
        assertCurrent() {},
        onRegistered: (address) => writes.push(address),
      })
      expect(result).toMatchObject({
        status: "saved",
        address: "saved@conduit.cash",
      })
      expect(calls).toEqual([["fixture", false, undefined, "conduit.cash"]])
      expect(writes).toEqual([])
      if (
        provider.status === "unavailable" &&
        provider.reason === "rate_limited"
      )
        expect(result).toMatchObject({
          reason: "rate_limited",
          retryAt: 123456,
        })
    })

  test("unknown saved state never falls back to provider discovery", async () => {
    let calls = 0
    await expect(
      resolveSparkLightningAddress({
        walletId: "fixture",
        loadSavedAddress: async () => {
          throw new Error("Signer unavailable")
        },
        manager: {
          getLightningAddress: async () => {
            calls++
            return registered("fallback@breez.tips")
          },
        },
        assertCurrent() {},
        onRegistered() {},
      })
    ).rejects.toThrow("Signer unavailable")
    expect(calls).toBe(0)
  })

  test("a selection changed during lookup retires the older result", async () => {
    let selected = "old@breez.tips"
    const writes: string[] = []
    const result = await resolveSparkLightningAddress({
      walletId: "fixture",
      loadSavedAddress: async () => selected,
      manager: {
        getLightningAddress: async () => {
          selected = "saved@conduit.cash"
          return registered("old@breez.tips")
        },
      },
      assertCurrent() {},
      onRegistered: (address) => writes.push(address),
    })
    expect(result).toMatchObject({
      status: "saved",
      address: "saved@conduit.cash",
    })
    expect(writes).toEqual([])
  })
})
