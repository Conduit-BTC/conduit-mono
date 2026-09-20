import { createFileRoute, redirect } from "@tanstack/react-router"
import { validateMerchantsSearch } from "./merchants"

export const Route = createFileRoute("/sellers")({
  validateSearch: validateMerchantsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/merchants", search, replace: true })
  },
})
