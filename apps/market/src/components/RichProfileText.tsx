import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { cn } from "@conduit/ui"
import { resolveProfileReference } from "../lib/profileRefs"

const LINK_PATTERN =
  /((?:https?:\/\/|web\+nostr:|nostr:)[^\s]+|(?:npub|nprofile|note|nevent)1[023456789acdefghjklmnpqrstuvwxyz]+)/giu

function stripTrailingPunctuation(value: string): {
  core: string
  trailing: string
} {
  const match = value.match(/^(.*?)([),.;!?]+)?$/)
  return {
    core: match?.[1] ?? value,
    trailing: match?.[2] ?? "",
  }
}

function toExternalHref(value: string): string | null {
  if (/^https?:\/\//i.test(value)) return value
  if (/^(?:web\+)?nostr:/i.test(value)) {
    if (resolveProfileReference(value)) return null
    return `https://njump.me/${value.replace(/^(?:web\+)?nostr:/i, "")}`
  }
  if (/^(?:npub|nprofile)1/i.test(value)) {
    if (resolveProfileReference(value)) return null
  }
  if (/^(?:note|nevent)1/i.test(value)) {
    return `https://njump.me/${value}`
  }
  return null
}

function renderLine(line: string, lineIndex: number): ReactNode {
  if (line.length === 0) {
    return <span className="inline-block min-h-[1lh]">&nbsp;</span>
  }

  const parts: ReactNode[] = []
  let lastIndex = 0

  for (const match of line.matchAll(LINK_PATTERN)) {
    const matched = match[0]
    const index = match.index ?? 0

    if (index > lastIndex) {
      parts.push(
        <span key={`text-${lineIndex}-${index}`}>
          {line.slice(lastIndex, index)}
        </span>
      )
    }

    const { core, trailing } = stripTrailingPunctuation(matched)
    const profileRef = resolveProfileReference(core)
    const href = toExternalHref(core)

    if (profileRef) {
      parts.push(
        <Link
          key={`profile-${lineIndex}-${index}`}
          to="/u/$profileRef"
          params={{ profileRef: core }}
          className="underline decoration-white/20 underline-offset-4 transition-colors hover:text-[var(--text-primary)] hover:decoration-white/40"
        >
          {core}
        </Link>
      )
    } else if (href) {
      parts.push(
        <a
          key={`link-${lineIndex}-${index}`}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-white/20 underline-offset-4 transition-colors hover:text-[var(--text-primary)] hover:decoration-white/40"
        >
          {core}
        </a>
      )
    } else {
      parts.push(<span key={`raw-${lineIndex}-${index}`}>{core}</span>)
    }

    if (trailing) {
      parts.push(<span key={`trail-${lineIndex}-${index}`}>{trailing}</span>)
    }

    lastIndex = index + matched.length
  }

  if (lastIndex < line.length) {
    parts.push(<span key={`tail-${lineIndex}`}>{line.slice(lastIndex)}</span>)
  }

  return parts
}

export function RichProfileText({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const lines = text.split(/\r?\n/)

  return (
    <div className={cn("break-words whitespace-pre-wrap", className)}>
      {lines.map((line, index) => (
        <div key={index}>{renderLine(line, index)}</div>
      ))}
    </div>
  )
}
