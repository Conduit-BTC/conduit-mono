import { normalizePublicMediaUrl } from "@conduit/core"

type ProfileBannerProps = {
  src?: string
}

export function ProfileBanner({ src }: ProfileBannerProps) {
  const bannerSrc = normalizePublicMediaUrl(src)

  return (
    <div
      data-profile-banner
      className="relative h-28 w-full overflow-hidden bg-gradient-to-r from-[var(--surface-elevated)] to-[var(--surface)] sm:h-40 lg:h-48"
    >
      {bannerSrc ? (
        <img
          key={bannerSrc}
          src={bannerSrc}
          alt=""
          aria-hidden="true"
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover object-center"
          onError={(event) => {
            event.currentTarget.hidden = true
          }}
        />
      ) : null}
    </div>
  )
}
