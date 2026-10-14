import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import {
  assertCheckoutSparkTreasuryAddressAllowed,
  selectCheckoutSparkTreasuryAddress,
} from "../packages/core/src/protocol/checkout-spark-treasury-policy"
import {
  createPublicDeploymentManifest,
  loadPagesProfiles,
  parsePagesProfiles,
  resolveDeploymentProfile,
} from "../scripts/vite/deployment_profile"

function matchesTreasuryPolicy(
  actual: ReturnType<typeof resolveDeploymentProfile>["quantumRouterTreasury"],
  expected: ReturnType<typeof resolveDeploymentProfile>["quantumRouterTreasury"]
): boolean {
  return (
    actual.mainnetAddress === expected.mainnetAddress &&
    actual.regtestAddress === expected.regtestAddress &&
    actual.retiredAddresses.length === expected.retiredAddresses.length &&
    actual.retiredAddresses.every(
      (address, index) => address === expected.retiredAddresses[index]
    )
  )
}

describe("shared router treasury deployment configuration", () => {
  it("uses one reviewed mainnet destination in preview and production", () => {
    const configured = loadPagesProfiles()
    expect(typeof configured.quantumRouterTreasury?.mainnetAddress).toBe(
      "string"
    )
    for (const name of ["preview", "production"] as const) {
      const profile = resolveDeploymentProfile({
        CONDUIT_DEPLOYMENT_PROFILE: name,
        VITE_CONDUIT_SPARK_TREASURY_ADDRESS: "unapproved-dashboard-value",
      })
      expect(
        matchesTreasuryPolicy(profile.quantumRouterTreasury, {
          mainnetAddress: configured.quantumRouterTreasury.mainnetAddress!,
          regtestAddress: "",
          retiredAddresses:
            configured.quantumRouterTreasury.retiredMainnetAddresses,
        })
      ).toBe(true)
    }
  })

  it("compiles the reviewed policy in both apps and excludes dashboard overrides", () => {
    for (const name of ["preview", "production", "staging"] as const) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `import { createConduitBuildContract } from "./scripts/vite/build_info.ts";
          import { loadPagesProfiles } from "./scripts/vite/deployment_profile.ts";
          const policy = loadPagesProfiles().quantumRouterTreasury;
          const expected = ${JSON.stringify(name)} === "staging" ? "" : policy.mainnetAddress;
          const expectedRetired = ${JSON.stringify(name)} === "staging" ? "" : policy.retiredMainnetAddresses.join(",");
          const matches = ["apps/market", "apps/merchant"].every((app) => {
            const { define } = createConduitBuildContract(app);
            return define["import.meta.env.VITE_CONDUIT_SPARK_TREASURY_ADDRESS"] === JSON.stringify(expected)
              && define["import.meta.env.VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS"] === JSON.stringify("")
              && define["import.meta.env.VITE_CONDUIT_SPARK_RETIRED_TREASURY_ADDRESSES"] === JSON.stringify(expectedRetired);
          });
          console.log(JSON.stringify({ matches }));`,
        ],
        env: {
          ...process.env,
          CF_PAGES: "",
          CONDUIT_DEPLOYMENT_PROFILE: name,
          VITE_CONDUIT_SPARK_TREASURY_ADDRESS: "unapproved-mainnet",
          VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS: "unapproved-regtest",
          VITE_CONDUIT_SPARK_RETIRED_TREASURY_ADDRESSES: "unapproved-retired",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString())).toEqual({ matches: true })
    }
  })

  it("keeps the managed mainnet policy out of local and unsupported networks", () => {
    const staging = resolveDeploymentProfile({
      CONDUIT_DEPLOYMENT_PROFILE: "staging",
      VITE_CONDUIT_SPARK_TREASURY_ADDRESS: "unapproved-mainnet",
      VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS: "unapproved-regtest",
      VITE_CONDUIT_SPARK_RETIRED_TREASURY_ADDRESSES: "unapproved-retired",
    })
    const empty = {
      mainnetAddress: "",
      regtestAddress: "",
      retiredAddresses: [],
    }
    expect(matchesTreasuryPolicy(staging.quantumRouterTreasury, empty)).toBe(
      true
    )
    expect(
      matchesTreasuryPolicy(
        resolveDeploymentProfile({}).quantumRouterTreasury,
        empty
      )
    ).toBe(true)
    expect(
      matchesTreasuryPolicy(
        resolveDeploymentProfile({
          VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS: "local-regtest",
        }).quantumRouterTreasury,
        { ...empty, regtestAddress: "local-regtest" }
      )
    ).toBe(true)
  })

  it("retains explicit local Vite dotenv configuration without treasury overrides", () => {
    const result = Bun.spawnSync({
      cwd: resolve("apps/market"),
      cmd: [
        process.execPath,
        "-e",
        `import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
        import { join } from "node:path";
        import { tmpdir } from "node:os";
        import { loadEnv } from "vite";
        import { createConduitBuildContract } from "../../scripts/vite/build_info.ts";
        const directory = mkdtempSync(join(tmpdir(), "conduit-treasury-env-"));
        try {
          writeFileSync(join(directory, ".env.regtest"), "VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS=local-dotenv-regtest\\n");
          const { define } = createConduitBuildContract(".");
          const local = loadEnv("regtest", directory, "VITE_");
          const untouched = ["VITE_CONDUIT_SPARK_TREASURY_ADDRESS", "VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS", "VITE_CONDUIT_SPARK_RETIRED_TREASURY_ADDRESSES"].every((name) => !("import.meta.env." + name in define));
          console.log(JSON.stringify({ untouched, dotenvRetained: local.VITE_CONDUIT_SPARK_REGTEST_TREASURY_ADDRESS === "local-dotenv-regtest" }));
        } finally { rmSync(directory, { recursive: true, force: true }); }`,
      ],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !name.startsWith("CF_PAGES") &&
            name !== "CONDUIT_DEPLOYMENT_PROFILE" &&
            !name.startsWith("VITE_CONDUIT_SPARK_")
        )
      ),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      untouched: true,
      dotenvRetained: true,
    })
  })

  it("requires an explicit bounded public policy with content-free errors", () => {
    const profiles = loadPagesProfiles()
    const missing = structuredClone(profiles) as Record<string, unknown>
    delete missing.quantumRouterTreasury
    expect(() => parsePagesProfiles(missing)).toThrow(
      "Pages deployment treasury configuration is invalid."
    )
    for (const address of [undefined, "", "wrong-network", "x".repeat(2049)]) {
      const invalid = structuredClone(profiles)
      invalid.quantumRouterTreasury.mainnetAddress = address as string
      expect(() => parsePagesProfiles(invalid)).toThrow(
        "Pages deployment treasury configuration is invalid."
      )
    }
    for (const retired of [
      ["wrong-network"],
      Array.from(
        { length: 17 },
        () => profiles.quantumRouterTreasury.mainnetAddress!
      ),
      [profiles.quantumRouterTreasury.mainnetAddress!],
    ]) {
      const invalid = structuredClone(profiles)
      invalid.quantumRouterTreasury.retiredMainnetAddresses = retired
      expect(() => parsePagesProfiles(invalid)).toThrow(
        "Pages deployment treasury configuration is invalid."
      )
    }
    const absent = structuredClone(profiles)
    absent.quantumRouterTreasury.mainnetAddress = null
    expect(
      resolveDeploymentProfile(
        { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
        parsePagesProfiles(absent)
      ).quantumRouterTreasury.mainnetAddress
    ).toBe("")
  })

  it("binds current and retired destinations into the digest but not the manifest", () => {
    const profiles = loadPagesProfiles()
    const baseline = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      profiles
    )
    const removed = structuredClone(profiles)
    removed.quantumRouterTreasury.mainnetAddress = null
    const changed = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      removed
    )
    expect(changed.configDigest).not.toBe(baseline.configDigest)
    removed.quantumRouterTreasury.retiredMainnetAddresses = [
      profiles.quantumRouterTreasury.mainnetAddress!,
    ]
    const retired = resolveDeploymentProfile(
      { CONDUIT_DEPLOYMENT_PROFILE: "preview" },
      removed
    )
    expect(retired.configDigest).not.toBe(changed.configDigest)
    expect(retired.quantumRouterTreasury.retiredAddresses).toHaveLength(1)
    const retiredPolicy = {
      ...retired.quantumRouterTreasury,
      retiredAddresses:
        retired.quantumRouterTreasury.retiredAddresses.join(","),
    }
    expect(() =>
      assertCheckoutSparkTreasuryAddressAllowed(
        "mainnet",
        profiles.quantumRouterTreasury.mainnetAddress!,
        retiredPolicy
      )
    ).not.toThrow()
    expect(
      selectCheckoutSparkTreasuryAddress("mainnet", retiredPolicy)
    ).toBeNull()
    expect(() =>
      assertCheckoutSparkTreasuryAddressAllowed(
        "mainnet",
        profiles.quantumRouterTreasury.mainnetAddress!,
        { mainnetAddress: "", retiredAddresses: "" }
      )
    ).toThrow()
    const manifest = createPublicDeploymentManifest({
      app: "market",
      profile: baseline,
      commitSha: "fixture-commit",
      branch: "fixture-branch",
      buildTime: "2026-10-05T12:00:00.000Z",
      sourceUrl: "https://github.com/Conduit-BTC/conduit-mono",
    })
    expect(
      JSON.stringify(manifest).includes(
        profiles.quantumRouterTreasury.mainnetAddress!
      )
    ).toBe(false)
    expect(manifest.publicConfigDigest).toBe(baseline.configDigest)
  })

  it("validates every reviewed static mainnet address with the pinned SDK offline", () => {
    // A separate Node process cannot inherit Bun's synthetic SDK module mocks.
    // Import only public pure codecs: no wallet initialization or provider calls.
    for (const invalidChecksum of [false, true]) {
      const result = Bun.spawnSync({
        cwd: resolve("apps/market"),
        cmd: [
          "node",
          "--input-type=module",
          "-e",
          `import { readFileSync } from "node:fs";
        import { isValidSparkAddress, getNetworkFromSparkAddress, decodeSparkAddress, encodeSparkAddress } from "@buildonspark/spark-sdk";
        const policy = JSON.parse(readFileSync("../../deploy/pages-profiles.json", "utf8")).quantumRouterTreasury;
        const addresses = [policy.mainnetAddress, ...policy.retiredMainnetAddresses].filter(Boolean);
        if (${invalidChecksum}) addresses[0] = addresses[0].slice(0, -1) + (addresses[0].endsWith("q") ? "p" : "q");
        let valid;
        try {
          valid = addresses.length > 0 && addresses.every((address) => {
            const decoded = decodeSparkAddress(address, "MAINNET");
            return isValidSparkAddress(address) && getNetworkFromSparkAddress(address) === "MAINNET"
              && !decoded.sparkInvoiceFields && /^(02|03)[0-9a-f]{64}$/.test(decoded.identityPublicKey)
              && encodeSparkAddress(decoded) === address;
          });
        } catch { valid = false; }
        process.exit(valid ? 0 : 1);`,
        ],
        stdout: "ignore",
        stderr: "ignore",
      })
      expect(result.exitCode).toBe(invalidChecksum ? 1 : 0)
    }
  })
})
