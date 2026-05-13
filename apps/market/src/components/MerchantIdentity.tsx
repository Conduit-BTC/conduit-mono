import { formatNpub, getProfileName, type Profile } from "@conduit/core"

export function getPendingMerchantDisplayName(
  pubkey: string,
  options: { prefix?: string; chars?: number } = {}
): string {
  return `${options.prefix ?? "Store"} ${formatNpub(pubkey, options.chars ?? 6)}`
}

export function getMerchantDisplayName(
  profile: Profile | undefined,
  pubkey: string,
  options: { prefix?: string; chars?: number } = {}
): string {
  return (
    getProfileName(profile) ??
    getPendingMerchantDisplayName(pubkey, {
      prefix: options.prefix,
      chars: options.chars,
    })
  )
}

type MerchantAvatarFallbackProps = {
  iconClassName?: string
}

export function MerchantAvatarFallback({
  iconClassName = "h-6 w-6",
}: MerchantAvatarFallbackProps) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]">
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
