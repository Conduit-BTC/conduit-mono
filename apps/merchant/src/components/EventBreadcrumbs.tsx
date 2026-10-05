import { Link, useSearch } from "@tanstack/react-router"
import { Breadcrumb } from "@conduit/ui"

export function EventBreadcrumbs({ title }: { title: string }) {
  const { relation } = useSearch({ from: "/events" })
  return (
    <Breadcrumb
      items={[
        {
          label: "Events",
          content: (
            <Link to="/events" search={{ relation }}>
              Events
            </Link>
          ),
        },
        { label: title },
      ]}
    />
  )
}
