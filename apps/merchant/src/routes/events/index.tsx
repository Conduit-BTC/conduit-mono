import { createFileRoute } from "@tanstack/react-router"

import { EventsDirectoryPage } from "../events"

export const Route = createFileRoute("/events/")({
  component: EventsDirectoryPage,
})
