import { Fragment, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

export function Breadcrumb({
  items,
}: {
  items: { label: string; content?: ReactNode }[]
}) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
        {items.map((item, index) => (
          <Fragment key={item.label}>
            {index > 0 ? (
              <li aria-hidden="true">
                <ChevronRight className="size-4" />
              </li>
            ) : null}
            <li
              aria-current={index === items.length - 1 ? "page" : undefined}
              className="min-w-0 break-words [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:text-[var(--text-primary)]"
            >
              {item.content ?? item.label}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  )
}
