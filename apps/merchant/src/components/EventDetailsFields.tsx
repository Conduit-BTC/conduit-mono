import type { ReactNode } from "react"
import { Button, Field, Input } from "@conduit/ui"
import { EventDescriptionField } from "./EventAuthoringFields"

/** Shared create/edit presentation; signed dates and publication stay with callers. */
export function EventDetailsFields({
  idPrefix,
  title,
  summary,
  location,
  disabled = false,
  banner,
  onTitleChange,
  onSummaryChange,
  onLocationChange,
}: {
  idPrefix: string
  title: string
  summary: string
  location: string
  disabled?: boolean
  banner: ReactNode
  onTitleChange: (value: string) => void
  onSummaryChange: (value: string) => void
  onLocationChange: (value: string) => void
}) {
  return (
    <div className="space-y-5">
      <Field id={`${idPrefix}-title`} label="Event title">
        {(control) => (
          <Input
            {...control}
            value={title}
            required
            disabled={disabled}
            onChange={(event) => onTitleChange(event.target.value)}
          />
        )}
      </Field>
      <EventDescriptionField
        id={`${idPrefix}-summary`}
        value={summary}
        disabled={disabled}
        onChange={onSummaryChange}
      />
      {banner}
      <Field id={`${idPrefix}-location`} label="Location">
        {(control) => (
          <Input
            {...control}
            value={location}
            required
            disabled={disabled}
            onChange={(event) => onLocationChange(event.target.value)}
          />
        )}
      </Field>
    </div>
  )
}

/** Hide without unmounting: close/reopen keeps drafts and signed-attempt recovery. */
export function EventDetailsEditor({
  id,
  label,
  open,
  disabled,
  onOpenChange,
  children,
}: {
  id: string
  label: string
  open: boolean
  disabled: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="space-y-4">
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
      >
        {open ? "Close editor" : label}
      </Button>
      <div id={id} hidden={!open} className="space-y-4">
        <p className="text-sm text-[var(--text-secondary)]">
          Closing keeps your unsaved edits in this page. Save to publish
          changes.
        </p>
        {children}
      </div>
    </div>
  )
}
