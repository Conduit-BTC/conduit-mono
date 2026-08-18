import type { ComponentProps } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@conduit/ui"
import { MerchantAvatarFallback } from "./MerchantIdentity"

export function ConversationProfilePicture({
  src,
  alt,
  onLoadingStatusChange,
}: {
  src?: string
  alt: string
  onLoadingStatusChange?: ComponentProps<
    typeof AvatarImage
  >["onLoadingStatusChange"]
}) {
  return (
    <Avatar className="h-full w-full">
      <AvatarImage
        src={src}
        alt={alt}
        className="object-cover"
        onLoadingStatusChange={onLoadingStatusChange}
      />
      <AvatarFallback>
        <MerchantAvatarFallback />
      </AvatarFallback>
    </Avatar>
  )
}
