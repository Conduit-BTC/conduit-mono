import { forwardRef } from "react"
import { Link } from "@tanstack/react-router"
import Markdown, { type Components, type UrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@conduit/ui"
import { resolveProfileReference } from "../lib/profileRefs"

const ALLOWED_MARKDOWN_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]

const LINK_CLASS_NAME =
  "break-words [overflow-wrap:anywhere] underline decoration-[var(--border)] underline-offset-4 transition-colors hover:text-[var(--text-primary)] hover:decoration-[var(--text-primary)]"

const REMARK_PLUGINS = [remarkGfm]

function stripNostrScheme(value: string): string {
  return value.replace(/^(?:web\+)?nostr:/i, "")
}

function toNjumpHref(value: string): string | null {
  const ref = stripNostrScheme(value.trim())
  if (!/^(?:naddr|nevent|note)1/i.test(ref)) return null
  return `https://njump.me/${ref}`
}

export function sanitizeMarketplaceMarkdownHref(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  if (resolveProfileReference(trimmed)) {
    return stripNostrScheme(trimmed)
  }

  const njumpHref = toNjumpHref(trimmed)
  if (njumpHref) return njumpHref

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href
    }
  } catch {
    return null
  }

  return null
}

export const sanitizeMarketplaceMarkdownUrl: UrlTransform = (url, key) =>
  key === "href" ? sanitizeMarketplaceMarkdownHref(url) : null

const markdownComponents: Components = {
  a({ children, href, title }) {
    const safeHref =
      typeof href === "string" ? sanitizeMarketplaceMarkdownHref(href) : null
    const profileRef =
      typeof safeHref === "string" ? resolveProfileReference(safeHref) : null

    if (safeHref && profileRef) {
      return (
        <Link
          to="/u/$profileRef"
          params={{ profileRef: safeHref }}
          className={LINK_CLASS_NAME}
          title={title}
        >
          {children}
        </Link>
      )
    }

    if (!safeHref) {
      return <span>{children}</span>
    }

    return (
      <a
        href={safeHref}
        target="_blank"
        rel="noreferrer noopener"
        className={LINK_CLASS_NAME}
        title={title}
      >
        {children}
      </a>
    )
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-[var(--border)] pl-4 text-pretty italic text-[var(--text-muted)]">
        {children}
      </blockquote>
    )
  },
  code({ children, className }) {
    return (
      <code
        className={cn(
          "rounded border border-[var(--border)] bg-[var(--surface-elevated)] px-1 py-0.5 text-xs text-[var(--text-primary)]",
          className
        )}
      >
        {children}
      </code>
    )
  },
  h1({ children }) {
    return (
      <h3 className="text-balance text-base font-semibold leading-7 text-[var(--text-primary)]">
        {children}
      </h3>
    )
  },
  h2({ children }) {
    return (
      <h3 className="text-balance text-base font-semibold leading-7 text-[var(--text-primary)]">
        {children}
      </h3>
    )
  },
  h3({ children }) {
    return (
      <h3 className="text-balance text-sm font-semibold leading-7 text-[var(--text-primary)]">
        {children}
      </h3>
    )
  },
  h4({ children }) {
    return (
      <h4 className="text-balance text-sm font-semibold leading-7 text-[var(--text-primary)]">
        {children}
      </h4>
    )
  },
  hr() {
    return <hr className="border-[var(--border)]" />
  },
  li({ children }) {
    return <li className="pl-1 text-pretty">{children}</li>
  },
  ol({ children }) {
    return (
      <ol className="ml-5 list-decimal space-y-1 text-pretty">{children}</ol>
    )
  },
  p({ children }) {
    return <p className="text-pretty">{children}</p>
  },
  pre({ children }) {
    return (
      <pre className="max-w-full overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-xs leading-6 text-[var(--text-primary)]">
        {children}
      </pre>
    )
  },
  table({ children }) {
    return (
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-80 border-collapse text-left text-xs">
          {children}
        </table>
      </div>
    )
  },
  td({ children }) {
    return (
      <td className="border border-[var(--border)] px-3 py-2 align-top">
        {children}
      </td>
    )
  },
  th({ children }) {
    return (
      <th className="border border-[var(--border)] bg-[var(--surface-elevated)] px-3 py-2 align-top font-semibold text-[var(--text-primary)]">
        {children}
      </th>
    )
  },
  ul({ children }) {
    return <ul className="ml-5 list-disc space-y-1 text-pretty">{children}</ul>
  },
}

export interface ProductDescriptionMarkdownProps {
  text: string
  className?: string
}

export const ProductDescriptionMarkdown = forwardRef<
  HTMLDivElement,
  ProductDescriptionMarkdownProps
>(function ProductDescriptionMarkdown({ text, className }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "min-w-0 max-w-full space-y-3 break-words text-sm leading-7 text-[var(--text-secondary)] [overflow-wrap:anywhere]",
        className
      )}
    >
      <Markdown
        allowedElements={ALLOWED_MARKDOWN_ELEMENTS}
        components={markdownComponents}
        remarkPlugins={REMARK_PLUGINS}
        skipHtml
        unwrapDisallowed
        urlTransform={sanitizeMarketplaceMarkdownUrl}
      >
        {text}
      </Markdown>
    </div>
  )
})
