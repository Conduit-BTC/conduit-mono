import { CircleAlert, ShieldCheck } from "lucide-react"
import {
  formatNpub,
  getProfileName,
  parseNip05Identifier,
  useNip05Verification,
  type Profile,
} from "@conduit/core"

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

export function getProfileNip05(profile: Profile | undefined): string | null {
  const nip05 = profile?.nip05?.trim()
  return nip05 || null
}

function getNip05DisplayLabel(nip05: string): string {
  const parsed = parseNip05Identifier(nip05)
  return parsed?.name === "_" ? parsed.domain : nip05.trim()
}

export function Nip05TrustIndicator({
  pubkey,
  nip05,
  className = "",
}: {
  pubkey: string
  nip05: string
  className?: string
}) {
  const verification = useNip05Verification(pubkey, nip05)
  const displayLabel = getNip05DisplayLabel(nip05)
  const icon =
    verification.status === "valid" ? (
      <ShieldCheck
        className="h-3.5 w-3.5 shrink-0 text-primary-500"
        aria-hidden="true"
      />
    ) : verification.status === "invalid" ? (
      <CircleAlert
        className="h-3.5 w-3.5 shrink-0 text-[var(--warning)]"
        aria-hidden="true"
      />
    ) : null
  const label =
    verification.status === "valid"
      ? "Verified NIP-05"
      : verification.status === "invalid"
        ? "NIP-05 verification failed"
        : null

  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      {label ? <span className="sr-only">{label}: </span> : null}
      {icon}
      <span className="min-w-0 truncate">{displayLabel}</span>
    </span>
  )
}

type MerchantAvatarFallbackProps = {
  iconClassName?: string
}

export function MerchantAvatarFallback({
  iconClassName = "h-6 w-6",
}: MerchantAvatarFallbackProps) {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-full bg-[var(--avatar-bg)]">
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
