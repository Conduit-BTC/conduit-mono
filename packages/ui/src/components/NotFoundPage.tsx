import { Card, CardContent, CardHeader, CardTitle } from "./Card"
import { Button } from "./Button"

interface NotFoundPageProps {
  backTo?: string
  backLabel?: string
}

export function NotFoundPage({
  backTo = "/",
  backLabel = "Go home",
}: NotFoundPageProps) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <CardTitle className="text-xl">Page not found</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            The page you're looking for doesn't exist or has been moved.
          </p>
          <Button variant="outline" asChild>
            <a href={backTo}>{backLabel}</a>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
