import { afterEach, describe, expect, it, mock } from "bun:test"
import {
  getWeblnPaymentFailurePhase,
  WeblnPaymentError,
  weblnSendPayment,
  type WebLNProvider,
} from "../packages/core/src/protocol/webln"

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window"
)

function setTestWindow(value: { webln?: WebLNProvider }): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  })
}

function createProvider(overrides: Partial<WebLNProvider> = {}): WebLNProvider {
  return {
    enable: async () => {},
    makeInvoice: async () => ({ paymentRequest: "lnbc1invoice" }),
    sendPayment: async () => ({ preimage: "preimage" }),
    ...overrides,
  }
}

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor)
    return
  }

  Reflect.deleteProperty(globalThis, "window")
})

describe("weblnSendPayment", () => {
  it("reports unavailable when no provider exists", async () => {
    setTestWindow({})

    await expect(
      weblnSendPayment({ invoice: "lnbc1invoice" })
    ).rejects.toMatchObject({
      name: "WeblnPaymentError",
      phase: "unavailable",
    })
  })

  it("reports unavailable when the provider cannot send payments", async () => {
    const enable = mock(async () => {})
    setTestWindow({
      webln: {
        enable,
        makeInvoice: async () => ({ paymentRequest: "lnbc1invoice" }),
      } as WebLNProvider,
    })

    await expect(
      weblnSendPayment({ invoice: "lnbc1invoice" })
    ).rejects.toMatchObject({
      name: "WeblnPaymentError",
      phase: "unavailable",
    })
    expect(enable).not.toHaveBeenCalled()
  })

  it("reports enable failures before submitting the invoice", async () => {
    const sendPayment = mock(async (_invoice: string) => ({
      preimage: "preimage",
    }))
    setTestWindow({
      webln: createProvider({
        enable: mock(async () => {
          throw new Error("Connection rejected")
        }),
        sendPayment,
      }),
    })

    await expect(
      weblnSendPayment({ invoice: "lnbc1invoice" })
    ).rejects.toMatchObject({
      name: "WeblnPaymentError",
      phase: "enable",
    })
    expect(sendPayment).not.toHaveBeenCalled()
  })

  it("reports payment rejections after submitting the invoice", async () => {
    setTestWindow({
      webln: createProvider({
        sendPayment: mock(async (_invoice: string) => {
          throw new Error("Payment rejected")
        }),
      }),
    })

    await expect(
      weblnSendPayment({ invoice: "lnbc1invoice" })
    ).rejects.toMatchObject({
      name: "WeblnPaymentError",
      phase: "submitted",
    })
  })

  it("reports a missing or empty payment proof after a resolved payment", async () => {
    for (const result of [{}, { preimage: " " }]) {
      setTestWindow({
        webln: createProvider({
          sendPayment: async () => result,
        }),
      })

      await expect(
        weblnSendPayment({ invoice: "lnbc1invoice" })
      ).rejects.toMatchObject({
        name: "WeblnPaymentError",
        phase: "settled_without_proof",
      })
    }
  })

  it("returns a valid payment proof", async () => {
    const enable = mock(async () => {})
    const sendPayment = mock(async (_invoice: string) => ({
      preimage: "preimage",
      paymentHash: "payment-hash",
    }))
    setTestWindow({
      webln: createProvider({ enable, sendPayment }),
    })

    await expect(
      weblnSendPayment({ invoice: "lnbc1invoice" })
    ).resolves.toEqual({
      preimage: "preimage",
      paymentHash: "payment-hash",
    })
    expect(enable).toHaveBeenCalledTimes(1)
    expect(sendPayment).toHaveBeenCalledWith("lnbc1invoice")
  })
})

describe("getWeblnPaymentFailurePhase", () => {
  it("returns the failure phase reported by typed payment errors", () => {
    for (const phase of [
      "unavailable",
      "enable",
      "submitted",
      "settled_without_proof",
    ] as const) {
      const error = new WeblnPaymentError("Payment failed", phase)

      expect(getWeblnPaymentFailurePhase(error)).toBe(phase)
    }
  })
})
