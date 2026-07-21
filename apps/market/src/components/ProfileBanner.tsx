type ProfileBannerProps = {
  src?: string
}

export function ProfileBanner({ src }: ProfileBannerProps) {
  const bannerSrc = src?.trim()

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
          className="absolute inset-0 h-full w-full object-cover object-center"
          onError={(event) => {
            event.currentTarget.hidden = true
          }}
        />
      ) : null}
    </div>
  )
}
