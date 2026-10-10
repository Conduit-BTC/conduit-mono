import { createFileRoute, redirect } from "@tanstack/react-router"
export const Route = createFileRoute("/payments")({
  beforeLoad: () => {
    throw redirect({ to: "/wallet" })
  },
})
