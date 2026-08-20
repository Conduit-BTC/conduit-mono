import { describe, expect, it } from "bun:test"

import {
  getPortableWalletFormError,
  getPortableWalletLabel,
  resolvePortableWalletAccountNumber,
} from "../apps/market/src/lib/portable-wallet-form"

describe("Portable Wallet form validation", () => {
  it("requires the phrase and validates a supplied account override", () => {
    expect(
      getPortableWalletFormError({
        mode: "restore",
        password: "long-enough-password",
        mnemonic: "",
        accountNumber: "",
      })
    ).toBe("Enter the recovery phrase.")

    expect(
      getPortableWalletFormError({
        mode: "restore",
        password: "long-enough-password",
        mnemonic: "synthetic recovery words",
        accountNumber: "-1",
      })
    ).toBe("Enter a valid Spark account number.")
  })

  it("accepts the standard inferred Spark account number", () => {
    expect(
      getPortableWalletFormError({
        mode: "restore",
        password: "long-enough-password",
        mnemonic: "synthetic recovery words",
        accountNumber: "",
      })
    ).toBeNull()
  })

  it("accepts complete create and restore submissions", () => {
    expect(
      getPortableWalletFormError({
        mode: "create",
        password: "long-enough-password",
        mnemonic: "",
        accountNumber: "0",
      })
    ).toBeNull()

    expect(
      getPortableWalletFormError({
        mode: "restore",
        password: "long-enough-password",
        mnemonic: "synthetic recovery words",
        accountNumber: "1",
      })
    ).toBeNull()
  })

  it("requires a local password before creation can start", () => {
    expect(
      getPortableWalletFormError({
        mode: "create",
        password: "too-short",
        mnemonic: "",
        accountNumber: "0",
      })
    ).toBe("Use at least 10 characters for the local wallet password.")
  })

  it("accepts only Spark account numbers in the hardened BIP32 range", () => {
    const input = {
      mode: "restore" as const,
      password: "long-enough-password",
      mnemonic: "synthetic recovery words",
    }

    expect(
      getPortableWalletFormError({
        ...input,
        accountNumber: "2147483647",
      })
    ).toBeNull()
    expect(
      getPortableWalletFormError({
        ...input,
        accountNumber: "2147483648",
      })
    ).toBe("Enter a valid Spark account number.")
  })

  it("uses an optional nickname or a stable generated-label base", () => {
    expect(getPortableWalletLabel("  Personal wallet  ")).toBe(
      "Personal wallet"
    )
    expect(getPortableWalletLabel("   ")).toBe("Spark wallet")
  })

  it("uses Mainnet account 1 by default and preserves an explicit override", () => {
    expect(resolvePortableWalletAccountNumber("", 1)).toBe(1)
    expect(resolvePortableWalletAccountNumber("0", 1)).toBe(0)
  })
})
