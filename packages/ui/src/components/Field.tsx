import { useId, type ReactNode } from "react"
import { Label } from "./Label"

export interface FieldControlProps {
  id: string
  "aria-describedby"?: string
  "aria-invalid"?: true
}

/** Presentation only: validation and values stay with the consuming form. */
export function Field({
  id: controlId,
  label,
  description,
  error,
  children,
}: {
  id?: string
  label: ReactNode
  description?: ReactNode
  error?: ReactNode
  children: (props: FieldControlProps) => ReactNode
}) {
  const generatedId = useId()
  const id = controlId ?? generatedId
  const descriptionId = `${id}-description`
  const errorId = `${id}-error`
  const describedBy = [description && descriptionId, error && errorId]
    .filter(Boolean)
    .join(" ")

  return (
    <div className="grid min-w-0 grid-cols-1 gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {description ? (
        <p
          id={descriptionId}
          className="mt-1 text-pretty text-sm leading-normal text-[var(--text-secondary)]"
        >
          {description}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          className="mt-1 text-pretty text-sm leading-normal font-medium text-[var(--error-text)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
