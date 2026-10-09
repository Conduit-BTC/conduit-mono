import { CircleAlert, ShieldCheck } from "lucide-react"
import {
  formatNpub,
  getProfileName,
  parseNip05Identifier,
  useNip05Verification,
  type Profile,
} from "@conduit/core"
import { useBrainstormVerification } from "../hooks/useBrainstormVerification"

export function getPendingMerchantDisplayName(
  pubkey: string,
  options: { prefix?: string; chars?: number } = {}
): string {
  return `${options.prefix ?? "Merchant"} ${formatNpub(pubkey, options.chars ?? 6)}`
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

const NO_NIP05_INDICATOR = { Icon: null, label: null, color: "" }
const NIP05_INDICATORS = {
  valid: {
    Icon: ShieldCheck,
    label: "Verified NIP-05",
    color: "text-primary-500",
  },
  invalid: {
    Icon: CircleAlert,
    label: "NIP-05 verification failed",
    color: "text-[var(--warning)]",
  },
  absent: NO_NIP05_INDICATOR,
  checking: NO_NIP05_INDICATOR,
  unknown: NO_NIP05_INDICATOR,
}

export function Nip05TrustIndicator({
  pubkey,
  nip05,
  className = "",
  display = "full",
}: {
  pubkey: string
  nip05: string
  className?: string
  display?: "full" | "icon"
}) {
  const verification = useNip05Verification(pubkey, nip05)
  const displayLabel = getNip05DisplayLabel(nip05)
  const brainstormVerified = useBrainstormVerification(
    pubkey,
    verification.status === "valid"
  )
  const { Icon, label, color } = NIP05_INDICATORS[verification.status]
  const icon = Icon ? (
    <Icon
      className={`h-3.5 w-3.5 shrink-0 ${color}${brainstormVerified ? " nip05-brainstorm-verified" : ""}`}
      aria-hidden="true"
    />
  ) : null

  const verificationLabel = label
    ? `${label}${brainstormVerified ? "; also verified by Brainstorm's network" : ""}`
    : null
  const tooltip = verificationLabel
    ? `${verificationLabel}: ${displayLabel}`
    : undefined

  if (display === "icon") {
    if (!label) return null
    return (
      <span
        className={`inline-flex shrink-0 items-center ${className}`}
        role="img"
        aria-label={tooltip}
        title={tooltip}
      >
        {icon}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}
      title={tooltip}
    >
      {verificationLabel ? (
        <span className="sr-only">{verificationLabel}: </span>
      ) : null}
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
