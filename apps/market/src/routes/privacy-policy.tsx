import { createFileRoute } from "@tanstack/react-router"
import { ProductPrivacyPolicy } from "@conduit/ui"

export const Route = createFileRoute("/privacy-policy")({
  component: ProductPrivacyPolicy,
})
