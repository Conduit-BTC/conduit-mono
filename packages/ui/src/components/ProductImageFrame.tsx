import { ImageOff } from "lucide-react"
import { useEffect, useState } from "react"
import { normalizePublicMediaUrl, type ProductImage } from "@conduit/core"
import { cn } from "../utils"

interface ProductImageFrameProps {
  image?: ProductImage
  title: string
  imageLoading?: "eager" | "lazy"
  enableHoverZoom?: boolean
  soldOut?: boolean
  onInvalidImage?: () => void
  className?: string
}

export function ProductImageFrame({
  image,
  title,
  imageLoading = "lazy",
  enableHoverZoom = false,
  soldOut = false,
  onInvalidImage,
  className,
}: ProductImageFrameProps) {
  const [imageFailed, setImageFailed] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const normalizedUrl = normalizePublicMediaUrl(image?.url)
  const activeImage =
    image && normalizedUrl ? { ...image, url: normalizedUrl } : undefined
  const imageKey = activeImage?.url ?? ""

  useEffect(() => {
    setImageFailed(false)
    setImageLoaded(false)
  }, [imageKey])

  return (
    <div
      className={cn(
        "relative aspect-[4/3] overflow-hidden border-b border-[var(--border)] bg-[var(--background)]",
        className
      )}
    >
      {activeImage && !imageFailed ? (
        <>
          <div
            aria-hidden="true"
            className={cn(
              "absolute inset-0 bg-[var(--surface-elevated)] transition-opacity duration-300",
              !imageLoaded && "animate-pulse",
              imageLoaded ? "opacity-0" : "opacity-100"
            )}
          />
          <img
            src={activeImage.url}
            alt={activeImage.alt ?? title}
            width={640}
            height={480}
            className={cn(
              "h-full w-full object-cover transition-[opacity,transform] duration-300",
              enableHoverZoom && "group-hover:scale-105",
              imageLoaded ? "opacity-100" : "opacity-0",
              soldOut && "grayscale group-hover:scale-100",
              soldOut && imageLoaded && "opacity-55"
            )}
            decoding="async"
            loading={imageLoading}
            referrerPolicy="no-referrer"
            onLoad={() => setImageLoaded(true)}
            onError={() => {
              setImageFailed(true)
              onInvalidImage?.()
            }}
          />
        </>
      ) : (
        <div
          className={cn(
            "flex h-full w-full flex-col items-center justify-center gap-2 bg-[var(--surface-elevated)] text-[var(--text-muted)]",
            soldOut && "opacity-60"
          )}
        >
          <ImageOff className="size-6" aria-hidden="true" />
          <span className="px-4 text-center text-xs">Image unavailable</span>
        </div>
      )}
    </div>
  )
}
