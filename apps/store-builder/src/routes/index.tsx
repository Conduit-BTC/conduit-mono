import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@conduit/ui"

export const Route = createFileRoute("/")({
  component: BuilderPage,
})

function BuilderPage() {
  return (
    <div className="min-h-screen bg-neutral-50 p-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-4xl font-medium text-neutral-900 mb-4">
          Store Builder
        </h1>
        <p className="text-lg text-neutral-600 mb-8">
          Create your custom storefront powered by Nostr
        </p>
        <div className="flex gap-4">
          <Button variant="primary">Create Store</Button>
          <Button variant="outline">Browse Templates</Button>
        </div>
      </div>
    </div>
  )
}
