import type { Profile } from "@conduit/core"

export function getMerchantDisplayName(profile: Profile | undefined, pubkey: string): string {
  const preferred = profile?.displayName?.trim() || profile?.name?.trim()
  if (preferred) return preferred
  return `Merchant ${pubkey.slice(0, 6)}`
}

type MerchantAvatarFallbackProps = {
  iconClassName?: string
}

export function MerchantAvatarFallback({ iconClassName = "h-6 w-6" }: MerchantAvatarFallbackProps) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-full bg-[radial-gradient(circle_at_top,rgba(255,86,164,0.24),transparent_55%),linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] text-[var(--text-primary)]">
      <img
        src="/images/logo/logo-icon.svg"
        alt=""
        aria-hidden="true"
        className={`${iconClassName} rotate-180 select-none object-contain brightness-0 invert`}
        draggable="false"
      />
    </div>
  )
}
