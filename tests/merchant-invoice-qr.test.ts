import { describe, expect, it } from "bun:test"
import {
  canEmbedMerchantImageInQr,
  getMerchantQrImageSettings,
  MERCHANT_QR_MAX_BRANDED_PAYLOAD_LENGTH,
} from "../apps/market/src/lib/merchant-invoice-qr"

describe("merchant invoice QR", () => {
  it("uses a conservative centered image size for short invoices", () => {
    expect(
      getMerchantQrImageSettings({
        invoice: "lnbc1invoice",
        merchantImageUrl: "https://example.com/avatar.png",
        size: 200,
      })
    ).toEqual({
      src: "https://example.com/avatar.png",
      height: 36,
      width: 36,
      excavate: true,
      crossOrigin: "anonymous",
    })
  })

  it("falls back to plain QR for missing or dense merchant image contexts", () => {
    expect(
      canEmbedMerchantImageInQr({
        invoice: "lnbc1invoice",
        merchantImageUrl: "",
      })
    ).toBe(false)
    expect(
      getMerchantQrImageSettings({
        invoice: `lnbc1${"x".repeat(MERCHANT_QR_MAX_BRANDED_PAYLOAD_LENGTH)}`,
        merchantImageUrl: "https://example.com/avatar.png",
        size: 200,
      })
    ).toBeUndefined()
  })
})
