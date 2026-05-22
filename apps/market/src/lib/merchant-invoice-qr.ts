export const MERCHANT_QR_MAX_BRANDED_PAYLOAD_LENGTH = 1_400
export const MERCHANT_QR_IMAGE_RATIO = 0.18

export type MerchantQrImageSettings = {
  src: string
  height: number
  width: number
  excavate: true
  crossOrigin: "anonymous"
}

export function canEmbedMerchantImageInQr({
  invoice,
  merchantImageUrl,
}: {
  invoice: string
  merchantImageUrl?: string | null
}): boolean {
  return (
    invoice.length > 0 &&
    invoice.length <= MERCHANT_QR_MAX_BRANDED_PAYLOAD_LENGTH &&
    !!merchantImageUrl?.trim()
  )
}

export function getMerchantQrImageSettings({
  invoice,
  merchantImageUrl,
  size,
}: {
  invoice: string
  merchantImageUrl?: string | null
  size: number
}): MerchantQrImageSettings | undefined {
  if (!canEmbedMerchantImageInQr({ invoice, merchantImageUrl })) {
    return undefined
  }

  const imageSize = Math.max(28, Math.round(size * MERCHANT_QR_IMAGE_RATIO))

  return {
    src: merchantImageUrl!.trim(),
    height: imageSize,
    width: imageSize,
    excavate: true,
    crossOrigin: "anonymous",
  }
}
