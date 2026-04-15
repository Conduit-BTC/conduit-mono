import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { pubkeyToNpub } from "@conduit/core"

/**
 * Copy icon button. When `npub` is true (default), converts a hex pubkey to
 * npub before copying. Pass `npub={false}` for non-pubkey values.
 */
export function CopyButton({
  value,
  label = "Copy",
  npub = true,
}: {
  value: string
  label?: string
  npub?: boolean
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      const text = npub ? pubkeyToNpub(value) : value
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      className={`inline-flex h-6 w-6 items-center justify-center rounded-full border transition-colors ${
        copied
          ? "border-green-500/40 bg-green-500/12 text-green-400"
          : "border-[var(--border)] bg-[var(--surface-elevated)] text-[var(--text-muted)] hover:border-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      }`}
      onClick={handleCopy}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  )
}
