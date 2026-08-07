import { describe, expect, it } from "bun:test"

import { getPortableWalletFormError } from "../apps/market/src/lib/portable-wallet-form"

describe("Portable Wallet form validation", () => {
  it("requires the label, phrase, and a valid account override", () => {
    expect(
      getPortableWalletFormError({
        mode: "restore",
        label: "",
        password: "",
        mnemonic: "",
        accountNumber: "",
      })
    ).toBe("Enter a wallet label.")

    expect(
      getPortableWalletFormError({
        mode: "restore",
        label: "Recovered Spark",
        password: "long-enough-password",
        mnemonic: "",
        accountNumber: "0",
      })
    ).toBe("Enter the recovery phrase.")

    expect(
      getPortableWalletFormError({
        mode: "restore",
        label: "Recovered Spark",
        password: "long-enough-password",
        mnemonic: "synthetic recovery words",
        accountNumber: "-1",
      })
    ).toBe("Enter a valid Spark account number.")
  })

  it("requires the explicit Spark account number from the recovery bundle", () => {
    expect(
      getPortableWalletFormError({
        mode: "restore",
        label: "Recovered Spark",
        password: "long-enough-password",
        mnemonic: "synthetic recovery words",
        accountNumber: "",
      })
    ).toBe("Enter the Spark account number from the recovery bundle.")
  })

  it("accepts complete create and restore submissions", () => {
    expect(
      getPortableWalletFormError({
        mode: "create",
        label: "New Spark",
        password: "long-enough-password",
        mnemonic: "",
        accountNumber: "0",
      })
    ).toBeNull()

    expect(
      getPortableWalletFormError({
        mode: "restore",
        label: "Recovered Spark",
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
        label: "New Spark",
        password: "too-short",
        mnemonic: "",
        accountNumber: "0",
      })
    ).toBe("Use at least 10 characters for the local wallet password.")
  })

  it("accepts only Spark account numbers in the hardened BIP32 range", () => {
    const input = {
      mode: "restore" as const,
      label: "Recovered Spark",
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
})
