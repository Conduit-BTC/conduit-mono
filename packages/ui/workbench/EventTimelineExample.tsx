import { useLayoutEffect, useState } from "react"
import {
  Button,
  EventTimelineEntry,
  EventTimelineLoading,
  EventTimelineViewport,
  StatePanel,
  useEventTimelineAnchor,
} from "@conduit/ui"
import type { ExampleState } from "./Commerce"

const pastEvents = [
  { day: "03", title: "Autumn makers market" },
  { day: "10", title: "Neighborhood harvest market" },
  { day: "17", title: "Saturday coffee market" },
]
const upcomingEvents = [
  { day: "24", title: "Riverside makers market" },
  { day: "25", title: "Sunday community market" },
  { day: "30", title: "Evening food market" },
  { day: "31", title: "October craft market" },
]
type SampleEvent = (typeof pastEvents)[number]
const pageSize = 2

export function EventTimelineExample({
  state,
  long,
}: {
  state: ExampleState
  long: boolean
}) {
  const [pastCount, setPastCount] = useState(1)
  const [upcomingCount, setUpcomingCount] = useState(2)
  const [selected, setSelected] = useState<SampleEvent | null>(null)

  return (
    <section
      aria-labelledby="event-timeline-heading"
      className="max-w-3xl space-y-4 border-t border-[var(--border)] pt-6"
    >
      <h2
        id="event-timeline-heading"
        className="text-balance text-xl font-semibold"
      >
        Page-scrolling Event Timeline
      </h2>
      <p className="text-pretty text-base text-[var(--text-secondary)]">
        One page scrollbar, starting at Now. Open a sample event and return to
        the same position, or load earlier events without moving the timeline
        anchor. All dates and events are fictional.
      </p>
      {selected ? (
        <SampleEventDetail event={selected} onBack={() => setSelected(null)} />
      ) : state === "loading" ? (
        <EventTimelineLoading count={2} />
      ) : state === "empty" ? (
        <StatePanel
          title="No sample events"
          description="Choose Ready in Preview controls to view the timeline."
        />
      ) : state === "error" ? (
        <StatePanel
          tone="error"
          title="Sample events are unavailable"
          description="Unavailable information is not an empty event list. Choose Ready to restore the example."
        />
      ) : (
        <SampleTimeline
          busy={state === "pending"}
          long={long}
          pastCount={pastCount}
          upcomingCount={upcomingCount}
          onLoadEarlier={() =>
            setPastCount(Math.min(pastEvents.length, pastCount + pageSize))
          }
          onLoadLater={() =>
            setUpcomingCount(
              Math.min(upcomingEvents.length, upcomingCount + pageSize)
            )
          }
          onOpen={setSelected}
        />
      )}
    </section>
  )
}

function SampleTimeline({
  busy,
  long,
  pastCount,
  upcomingCount,
  onLoadEarlier,
  onLoadLater,
  onOpen,
}: {
  busy: boolean
  long: boolean
  pastCount: number
  upcomingCount: number
  onLoadEarlier: () => void
  onLoadLater: () => void
  onOpen: (event: SampleEvent) => void
}) {
  const anchor = useEventTimelineAnchor({
    isFetching: false,
    itemCount: pastCount + upcomingCount,
    pastCount,
    viewportKey: "ui-workbench-page-timeline",
    scrollMode: "page",
  })
  const renderEvent = (event: SampleEvent) => (
    <EventTimelineEntry
      key={event.day}
      date={{
        dateTime: `2026-10-${event.day}`,
        day: event.day,
        month: "OCT",
        year: "2026",
      }}
      title={
        long
          ? `${event.title}, independent makers and seasonal food from the neighborhood collective`
          : event.title
      }
      organizerName={
        long
          ? "The neighborhood community collective and independent makers association"
          : "Sample community collective"
      }
      schedule={`October ${event.day}, 2026, 10 am to 4 pm`}
      onOpen={() => {
        anchor.rememberPosition()
        onOpen(event)
      }}
    />
  )

  return (
    <EventTimelineViewport
      busy={busy}
      scrollMode="page"
      viewportRef={anchor.timelineViewportRef}
      nowAnchorRef={anchor.nowAnchorRef}
      pastEvents={pastEvents.slice(-pastCount).map(renderEvent)}
      currentAndFutureEvents={upcomingEvents
        .slice(0, upcomingCount)
        .map(renderEvent)}
      hiddenEarlierCount={pastEvents.length - pastCount}
      hiddenLaterCount={upcomingEvents.length - upcomingCount}
      pageSize={pageSize}
      onLoadEarlier={() => {
        anchor.prepareForPrepend()
        onLoadEarlier()
      }}
      onLoadLater={onLoadLater}
    />
  )
}

function SampleEventDetail({
  event,
  onBack,
}: {
  event: SampleEvent
  onBack: () => void
}) {
  useLayoutEffect(() => {
    document.getElementById("event-timeline-heading")?.scrollIntoView()
  }, [])

  return (
    <div className="space-y-4">
      <Button variant="outline" onClick={onBack}>
        Back to sample timeline
      </Button>
      <h3 className="text-lg font-semibold">{event.title}</h3>
      <p className="text-base text-[var(--text-secondary)]">
        This local detail example only exercises scroll restoration. No event is
        fetched, changed or published.
      </p>
    </div>
  )
}
