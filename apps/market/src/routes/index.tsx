import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@conduit/ui"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  return (
    <div className="min-h-screen bg-neutral-50 p-8">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-4xl font-medium text-neutral-900 mb-4">
          Conduit Market
        </h1>
        <p className="text-lg text-neutral-600 mb-8">
          A decentralized marketplace powered by Nostr
        </p>
        <div className="flex gap-4">
          <Button variant="primary">Connect Wallet</Button>
          <Button variant="outline">Browse Products</Button>
        </div>
      </div>
    </div>
  )
}
