import { useEffect, useMemo, useState } from "react"
import { QRCodeSVG } from "qrcode.react"
import {
  canEmbedMerchantImageInQr,
  getMerchantQrImageSettings,
} from "../lib/merchant-invoice-qr"

type MerchantInvoiceQrProps = {
  invoice: string
  merchantName?: string
  merchantImageUrl?: string | null
  size?: number
  className?: string
}

export function MerchantInvoiceQr({
  invoice,
  merchantName,
  merchantImageUrl,
  size = 184,
  className = "",
}: MerchantInvoiceQrProps) {
  const [imageReady, setImageReady] = useState(false)
  const shouldPreloadImage = canEmbedMerchantImageInQr({
    invoice,
    merchantImageUrl,
  })

  useEffect(() => {
    setImageReady(false)
    if (!shouldPreloadImage || !merchantImageUrl) return

    let cancelled = false
    const image = new Image()
    image.crossOrigin = "anonymous"
    image.onload = () => {
      if (!cancelled) setImageReady(true)
    }
    image.onerror = () => {
      if (!cancelled) setImageReady(false)
    }
    image.src = merchantImageUrl

    return () => {
      cancelled = true
    }
  }, [merchantImageUrl, shouldPreloadImage])

  const imageSettings = useMemo(
    () =>
      imageReady
        ? getMerchantQrImageSettings({
            invoice,
            merchantImageUrl,
            size,
          })
        : undefined,
    [imageReady, invoice, merchantImageUrl, size]
  )
  const label = merchantName
    ? `Lightning invoice QR code for ${merchantName}`
    : "Lightning invoice QR code"

  return (
    <div
      className={[
        "inline-flex flex-col items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4",
        className,
      ].join(" ")}
    >
      <div className="rounded-2xl bg-white p-3 shadow-[var(--shadow-glass-inset)]">
        <QRCodeSVG
          value={invoice}
          size={size}
          level="H"
          marginSize={4}
          title={label}
          bgColor="white"
          fgColor="black"
          imageSettings={imageSettings}
        />
      </div>
      <div className="text-center text-xs leading-5 text-[var(--text-secondary)]">
        {merchantName ? (
          <>Manual Lightning invoice for {merchantName}</>
        ) : (
          <>Manual Lightning invoice</>
        )}
        {shouldPreloadImage && !imageReady && (
          <span className="block text-[var(--text-muted)]">
            Showing plain QR until the merchant image loads.
          </span>
        )}
      </div>
    </div>
  )
}
