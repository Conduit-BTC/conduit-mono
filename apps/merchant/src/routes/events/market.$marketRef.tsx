import { createFileRoute, redirect } from "@tanstack/react-router"

/** Preserve links from the earlier future-market organizer preview. */
export const Route = createFileRoute("/events/market/$marketRef")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/events/$collectionRef",
      params: { collectionRef: params.marketRef },
      search: {},
      replace: true,
    })
  },
})
