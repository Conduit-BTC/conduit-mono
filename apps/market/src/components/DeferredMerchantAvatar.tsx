import { useEffect, useRef, useState } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@conduit/ui"
import { MerchantAvatarFallback } from "./MerchantIdentity"

/** Radix preloads AvatarImage, so mount it only near a visible row. */
export function DeferredMerchantAvatar({
  picture,
  className,
  imageClassName,
  iconClassName,
  fallbackClassName,
}: {
  picture?: string
  className?: string
  imageClassName?: string
  iconClassName?: string
  fallbackClassName?: string
}) {
  const avatarRef = useRef<HTMLSpanElement>(null)
  const [nearViewport, setNearViewport] = useState(false)

  useEffect(() => {
    const avatar = avatarRef.current
    if (!avatar) return
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setNearViewport(true)
          observer.disconnect()
        }
      },
      { rootMargin: "300px" }
    )
    observer.observe(avatar)
    return () => observer.disconnect()
  }, [])

  return (
    <Avatar ref={avatarRef} className={className}>
      {nearViewport && picture ? (
        <AvatarImage src={picture} alt="" className={imageClassName} />
      ) : null}
      <AvatarFallback className={fallbackClassName}>
        <MerchantAvatarFallback iconClassName={iconClassName} />
      </AvatarFallback>
    </Avatar>
  )
}
