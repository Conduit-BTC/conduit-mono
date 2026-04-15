import { Card, CardContent, CardHeader, CardTitle } from "./Card"
import { Button } from "./Button"

interface ErrorPageProps {
  title?: string
  message?: string
  showReload?: boolean
}

export function ErrorPage({
  title = "Something went wrong",
  message = "An unexpected error occurred. Please try again.",
  showReload = true,
}: ErrorPageProps) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">{message}</p>
          {showReload && (
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
