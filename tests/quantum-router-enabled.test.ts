import { describe, expect, it } from "bun:test"
import {
  config,
  isQuantumRouterEnabled,
  resolveQuantumRouterEnabled,
} from "../packages/core/src/config"

const hosted = {
  profileEnabled: true,
  deploymentProfile: "preview",
  lightningNetwork: "mainnet",
  hostname: "router-preview.conduit-market-coo.pages.dev",
}
const local = {
  profileEnabled: false,
  deploymentProfile: "local",
  lightningNetwork: "mainnet",
  hostname: "127.0.0.1",
  dev: true,
  localRouterCanaryFlag: "true",
  localRehearsalFlag: "true",
}

describe("Quantum Router capability admission", () => {
  it("admits compiled mainnet preview and production without local flags or DEV", () => {
    expect(resolveQuantumRouterEnabled(hosted)).toBe(true)
    for (const hostname of ["shop.conduit.market", "sell.conduit.market"]) {
      expect(
        resolveQuantumRouterEnabled({
          ...hosted,
          deploymentProfile: "production",
          hostname,
          dev: false,
        })
      ).toBe(true)
    }
    expect(
      resolveQuantumRouterEnabled({
        ...hosted,
        deploymentProfile: "production",
        hostname: "conduit-market-coo.pages.dev",
      })
    ).toBe(true)
  })

  it("rejects official production hosts compiled under another profile", () => {
    for (const hostname of ["SHOP.CONDUIT.MARKET.", "sell.conduit.market"]) {
      for (const deploymentProfile of [
        "preview",
        "staging",
        "local",
        "unknown",
      ]) {
        expect(
          resolveQuantumRouterEnabled({
            ...local,
            profileEnabled: true,
            hostname,
            deploymentProfile,
          })
        ).toBe(false)
      }
    }
  })

  it("rejects Signet Pages hosts even if the bundle claims mainnet", () => {
    for (const hostname of [
      "conduit-market-signet.pages.dev",
      "abc123.conduit-market-signet.pages.dev",
      "router-preview.conduit-merchant-signet.pages.dev",
    ]) {
      for (const deploymentProfile of ["preview", "production", "staging"]) {
        expect(
          resolveQuantumRouterEnabled({
            ...hosted,
            hostname,
            deploymentProfile,
          })
        ).toBe(false)
      }
    }
  })

  it("rejects unsupported public networks and unknown profiles", () => {
    for (const lightningNetwork of [
      "signet",
      "testnet",
      "mock",
      "regtest",
      "",
    ]) {
      expect(resolveQuantumRouterEnabled({ ...hosted, lightningNetwork })).toBe(
        false
      )
    }
    for (const deploymentProfile of ["staging", "unknown", ""]) {
      expect(
        resolveQuantumRouterEnabled({ ...hosted, deploymentProfile })
      ).toBe(false)
    }
  })

  it("does not allow local rehearsal flags to turn on a disabled hosted build", () => {
    for (const deploymentProfile of ["preview", "production", "staging"]) {
      expect(resolveQuantumRouterEnabled({ ...local, deploymentProfile })).toBe(
        false
      )
    }
    expect(
      resolveQuantumRouterEnabled({ ...hosted, profileEnabled: false })
    ).toBe(false)
  })

  it("retains explicit DEV loopback rehearsal admission on the local profile only", () => {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]", "::1"]) {
      expect(resolveQuantumRouterEnabled({ ...local, hostname })).toBe(true)
    }
    expect(
      resolveQuantumRouterEnabled({ ...local, lightningNetwork: "regtest" })
    ).toBe(true)
    expect(resolveQuantumRouterEnabled({ ...local, dev: false })).toBe(false)
    expect(resolveQuantumRouterEnabled({ ...local, dev: undefined })).toBe(
      false
    )
    for (const hostname of [
      undefined,
      "localhost.example",
      "127.0.0.2",
      hosted.hostname,
    ]) {
      expect(resolveQuantumRouterEnabled({ ...local, hostname })).toBe(false)
    }
    for (const lightningNetwork of ["signet", "testnet", "mock"]) {
      expect(resolveQuantumRouterEnabled({ ...local, lightningNetwork })).toBe(
        false
      )
    }
    expect(
      resolveQuantumRouterEnabled({ ...local, localRouterCanaryFlag: "false" })
    ).toBe(false)
    expect(
      resolveQuantumRouterEnabled({ ...local, localRehearsalFlag: undefined })
    ).toBe(false)
    expect(
      resolveQuantumRouterEnabled({ ...local, localRouterCanaryFlag: "TRUE" })
    ).toBe(false)
  })

  it("accepts an explicit local capability without granting local rehearsal exceptions", () => {
    expect(
      resolveQuantumRouterEnabled({
        ...local,
        profileEnabled: true,
        localRouterCanaryFlag: undefined,
        localRehearsalFlag: undefined,
      })
    ).toBe(true)
    expect(
      resolveQuantumRouterEnabled({
        ...local,
        profileEnabled: false,
        localRouterCanaryFlag: undefined,
        localRehearsalFlag: undefined,
      })
    ).toBe(false)
    expect(
      resolveQuantumRouterEnabled({
        ...local,
        profileEnabled: true,
        dev: false,
      })
    ).toBe(false)
  })

  it("exposes the same resolved capability to both app admission callers", () => {
    expect(isQuantumRouterEnabled()).toBe(config.quantumRouterEnabled)
  })
})
