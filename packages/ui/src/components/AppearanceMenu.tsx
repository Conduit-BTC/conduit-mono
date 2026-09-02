import { Palette } from "lucide-react"
import { useTheme } from "../hooks/useTheme"
import { THEME_PREFERENCE_OPTIONS, parseThemePreference } from "../theme"
import { cn } from "../utils"
import {
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./DropdownMenu"

export type AppearanceMenuProps = {
  className?: string
  contentClassName?: string
}

export function AppearanceMenu({
  className,
  contentClassName,
}: AppearanceMenuProps) {
  const { preference, setPreference } = useTheme()
  const currentLabel =
    THEME_PREFERENCE_OPTIONS.find((option) => option.id === preference)
      ?.label ?? THEME_PREFERENCE_OPTIONS[0]!.label

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        aria-label={`Appearance: ${currentLabel}`}
        className={cn(
          "h-10 rounded-xl px-2 text-sm font-medium text-[var(--text-primary)]",
          className
        )}
      >
        <Palette
          className="mr-2 size-4 text-[var(--text-secondary)]"
          aria-hidden="true"
        />
        <span>Appearance</span>
      </DropdownMenuSubTrigger>

      <DropdownMenuPortal>
        <DropdownMenuSubContent
          className={cn(
            "w-[14rem] rounded-xl border border-[var(--border-overlay)] bg-[var(--surface-overlay)] p-2 shadow-[var(--shadow-dialog)]",
            contentClassName
          )}
        >
          <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-xs font-medium text-[var(--text-muted)]">
            Appearance
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            aria-label="Appearance theme preference"
            value={preference}
            onValueChange={(value) => {
              setPreference(parseThemePreference(value))
            }}
          >
            {THEME_PREFERENCE_OPTIONS.map((option) => (
              <DropdownMenuRadioItem
                key={option.id}
                value={option.id}
                data-theme-preference={option.id}
                className="min-h-10 rounded-lg py-2 text-sm font-medium"
                onSelect={(event) => event.preventDefault()}
              >
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  )
}
