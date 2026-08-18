import { createFileRoute } from "@tanstack/react-router"
import { ProductTermsOfService } from "@conduit/ui"

export const Route = createFileRoute("/terms-of-service")({
  component: ProductTermsOfService,
})
