import { useRef, useState } from "react"
import { MoreHorizontal, Search } from "lucide-react"
import {
  ActionRow,
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  Input,
  Label,
  PreferenceSectionBody,
  PreferenceSectionCard,
  PreferenceSectionDivider,
  SectionGrid,
  SegmentedControl,
  SegmentedControlItem,
  SettingsRow,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  StatePanel,
  StatusPill,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@conduit/ui"

export function Controls() {
  const [selection, setSelection] = useState("")
  const [message, setMessage] = useState("")
  const [view, setView] = useState("List")
  return (
    <div className="space-y-6">
      <section className="space-y-5 border-t border-[var(--border)] pt-6">
        <header className="space-y-1.5">
          <h2 className="text-lg font-semibold">Action hierarchy</h2>
          <p className="max-w-prose text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            One primary action per decision. Outline for alternatives; ghost for
            supporting actions. Orange and violet are brand variants for
            deliberate emphasis, not additional primary actions.
          </p>
        </header>
        <div className="space-y-5">
          <ActionRow>
            <Button onClick={() => setMessage("Primary action selected")}>
              Continue
            </Button>
            <Button
              variant="outline"
              onClick={() => setMessage("Alternative selected")}
            >
              Save draft
            </Button>
            <Button
              variant="ghost"
              onClick={() => setMessage("Action cancelled")}
            >
              Cancel
            </Button>
            <Button disabled>Unavailable</Button>
            <Button disabled aria-busy>
              Saving…
            </Button>
          </ActionRow>
          <ActionRow>
            <Button size="sm">Compact</Button>
            <Button>Default</Button>
            <Button size="lg">Prominent</Button>
            <Button
              size="icon"
              variant="outline"
              aria-label="Search sample catalog"
            >
              <Search className="size-4" aria-hidden="true" />
            </Button>
          </ActionRow>
          <ActionRow>
            <Button variant="secondary">Orange action</Button>
            <Button variant="accent">Violet action</Button>
            <Button variant="destructive">Remove item</Button>
            <Button variant="link">Text action</Button>
            <span className="text-sm text-[var(--text-secondary)]">
              12 products
            </span>
          </ActionRow>
          <p role="status" className="text-sm text-[var(--text-secondary)]">
            {message}
          </p>
        </div>
      </section>
      <SectionGrid>
        <section className="space-y-5 border-t border-[var(--border)] pt-6">
          <header className="space-y-1.5">
            <h2 className="text-lg font-semibold">Fields and choices</h2>
            <p className="max-w-prose text-pretty text-sm leading-6 text-[var(--text-secondary)]">
              Visible labels, local hints and native paste behavior.
            </p>
          </header>
          <div className="space-y-5">
            <Field
              label="Search catalog"
              description="Use a product name or category."
            >
              {(props) => <Input {...props} placeholder="Coffee" />}
            </Field>
            <Field label="Read-only reference">
              {(props) => <Input {...props} readOnly value="SAMPLE-1042" />}
            </Field>
            <Field
              label="Unavailable field"
              description="Connect a service before editing this field."
            >
              {(props) => (
                <Input {...props} disabled placeholder="Unavailable" />
              )}
            </Field>
            <div className="space-y-1">
              <Label htmlFor="sample-category">Searchable category</Label>
              <Combobox
                id="sample-category"
                value={selection}
                onValueChange={setSelection}
                placeholder="Choose a category"
                searchPlaceholder="Find a category"
                options={[
                  { value: "coffee", label: "Coffee" },
                  { value: "craft", label: "Handmade crafts" },
                  {
                    value: "long",
                    label:
                      "Exceptionally long category name for overflow inspection",
                  },
                ]}
              />
            </div>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Checkbox defaultChecked />
              Include archived examples
            </label>
          </div>
        </section>
        <section className="space-y-5 border-t border-[var(--border)] pt-6">
          <header className="space-y-1.5">
            <h2 className="text-lg font-semibold">Navigation and status</h2>
            <p className="max-w-prose text-pretty text-sm leading-6 text-[var(--text-secondary)]">
              Tabs change a panel; navigation links change a location. Color
              always has a text label.
            </p>
          </header>
          <div className="space-y-6">
            <Breadcrumb
              items={[
                {
                  label: "Workbench",
                  content: <a href="#examples">Workbench</a>,
                },
                { label: "Inventory" },
              ]}
            />
            <SegmentedControl role="group" aria-label="Sample view mode">
              {["List", "Grid"].map((mode) => (
                <SegmentedControlItem
                  key={mode}
                  selected={view === mode}
                  aria-pressed={view === mode}
                  onClick={() => setView(mode)}
                >
                  {mode}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <p role="status" className="text-sm text-[var(--text-secondary)]">
              {view} view selected (demo).
            </p>
            <Tabs defaultValue="active">
              <TabsList aria-label="Sample inventory tabs">
                <TabsTrigger value="active">Active</TabsTrigger>
                <TabsTrigger value="draft">Drafts</TabsTrigger>
                <TabsTrigger value="archived" disabled>
                  Archived
                </TabsTrigger>
              </TabsList>
              <TabsContent value="active">
                Active inventory panel. Arrow keys move between tabs.
              </TabsContent>
              <TabsContent value="draft">Draft inventory panel.</TabsContent>
            </Tabs>
            <ActionRow>
              {(
                ["success", "warning", "error", "info", "neutral"] as const
              ).map((tone, i) => (
                <StatusPill key={tone} variant={tone}>
                  {
                    [
                      "Ready",
                      "Needs attention",
                      "Unavailable",
                      "Informational",
                      "Draft",
                    ][i]
                  }
                </StatusPill>
              ))}
            </ActionRow>
            <ActionRow>
              <Badge variant="warning">Stock running low</Badge>
              <Badge variant="destructive">Action required</Badge>
            </ActionRow>
            <p className="text-sm text-[var(--text-secondary)]">
              Use a tinted tag when attention is needed. Routine status and
              counts stay unboxed.
            </p>
            <div
              aria-busy="true"
              aria-label="Loading sample rows"
              className="space-y-3"
            >
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-1/2" />
              <span className="sr-only">Loading</span>
            </div>
            <StatePanel
              tone="pending"
              title="Change pending"
              description="Keep the current state visible while awaiting confirmation."
            />
          </div>
        </section>
      </SectionGrid>
    </div>
  )
}

export function FormExample() {
  const [name, setName] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const [saved, setSaved] = useState(false)
  const error = submitted && !name.trim() ? "Enter a product name." : undefined
  return (
    <SectionGrid>
      <Card>
        <CardHeader>
          <CardTitle>Product details</CardTitle>
          <CardDescription>
            A short form composed from shared Field, Input, Textarea, Checkbox
            and ActionRow.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault()
              setSubmitted(true)
              setSaved(Boolean(name.trim()))
              if (!name.trim())
                event.currentTarget.querySelector("input")?.focus()
            }}
          >
            <Field
              label="Product name (required)"
              description="Use a clear, descriptive name."
              error={error}
            >
              {(props) => (
                <Input
                  {...props}
                  required
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setSaved(false)
                  }}
                  placeholder="Colombia whole-bean coffee"
                />
              )}
            </Field>
            <Field
              label="Description"
              description="Long descriptions wrap. Paste is supported."
            >
              {(props) => (
                <Textarea
                  {...props}
                  rows={4}
                  placeholder="Describe the product and what is included."
                />
              )}
            </Field>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Checkbox defaultChecked />
              Offer pickup at the market
            </label>
            <ActionRow>
              <Button type="submit">Save sample product</Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setName("")
                  setSubmitted(false)
                  setSaved(false)
                }}
              >
                Reset
              </Button>
            </ActionRow>
            <p
              role="status"
              className="text-pretty text-sm text-[var(--text-secondary)]"
            >
              {saved
                ? "Sample saved in this preview only."
                : error
                  ? "The form needs a product name."
                  : "Submit the empty form to inspect its error and focus behavior."}
            </p>
          </form>
        </CardContent>
      </Card>
      <div className="space-y-6">
        <StatePanel
          title="Form rules"
          description="Keep a single column for reading and error recovery. Pair related short values on desktop only. Describe why an action is disabled and place errors beside their controls."
        />
        <StatePanel
          title="Long content"
          description="Titles and descriptions wrap; technical references may break anywhere. Product and merchant names stay visible; do not rely on an accessible name alone to reveal text to sighted readers."
        />
      </div>
    </SectionGrid>
  )
}

export function Overlays() {
  const [destructive, setDestructive] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [message, setMessage] = useState("")
  return (
    <section className="space-y-5 border-t border-[var(--border)] pt-6">
      <header className="space-y-1.5">
        <h2 className="text-lg font-semibold">Dialogs, sheets and menus</h2>
        <p className="max-w-prose text-pretty text-sm leading-6 text-[var(--text-secondary)]">
          Open each surface, tab through its controls, then press Escape. Focus
          returns to its trigger.
        </p>
      </header>
      <div className="space-y-6">
        <ActionRow>
          <Dialog>
            <DialogTrigger asChild>
              <Button>Edit pickup details</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit pickup details</DialogTitle>
                <DialogDescription>
                  Update the sample instructions. This dialog has intentionally
                  long content to test a phone viewport and scrolling.
                </DialogDescription>
              </DialogHeader>
              <Field
                label="Pickup instructions"
                description="Tell the customer where to go."
              >
                {(props) => (
                  <Textarea
                    {...props}
                    rows={6}
                    defaultValue="Community hall, north entrance. Please use the accessible ground-floor door beside the courtyard. Bring the order reference to the collection desk."
                  />
                )}
              </Field>
              <DialogFooter className="gap-2">
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button
                    onClick={() => setMessage("Sample pickup details saved")}
                  >
                    Save details
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open order sheet</Button>
            </SheetTrigger>
            <SheetContent className="w-full max-w-md space-y-6 overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <SheetHeader>
                <SheetTitle>Order #1042</SheetTitle>
                <SheetDescription>
                  A focused detail surface that preserves the surrounding list.
                </SheetDescription>
              </SheetHeader>
              <StatusPill variant="success">Confirmed paid</StatusPill>
              <StatePanel
                title="Ready for pickup"
                description="Colombia whole-bean coffee, 340 g. Community hall, north entrance. The detail surface retains full product and fulfillment information."
              />
              <SheetFooter>
                <SheetClose asChild>
                  <Button variant="outline">Back to orders</Button>
                </SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label="Sample order actions">
                <MoreHorizontal aria-hidden="true" className="size-4" />
                Actions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Sample order</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => setMessage("Sample order opened")}
              >
                View order
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                Print receipt (unavailable)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setMessage("Sample reference selected")}
              >
                Copy reference
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialog open={destructive} onOpenChange={setDestructive}>
            <DialogTrigger asChild>
              <Button variant="destructive">Remove sample draft</Button>
            </DialogTrigger>
            <AlertDialogContent
              onOpenAutoFocus={(event) => {
                event.preventDefault()
                cancelRef.current?.focus()
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>Remove this sample draft?</AlertDialogTitle>
                <AlertDialogDescription>
                  This is a fictional example. In a product flow, explain
                  exactly what will be removed and whether it can be recovered.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="gap-2">
                <Button
                  ref={cancelRef}
                  variant="outline"
                  onClick={() => setDestructive(false)}
                >
                  Keep draft
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setDestructive(false)
                    setMessage("Sample draft removed in preview only")
                  }}
                >
                  Remove draft
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </ActionRow>
        <p role="status" className="text-sm text-[var(--text-secondary)]">
          {message}
        </p>
        <StatePanel
          title="Overlay rules"
          description="Give each dialog a title and description. Keep cancellation visible, put initial focus on the safe action for destructive confirmation, and preserve keyboard focus when the surface closes."
        />
      </div>
    </section>
  )
}

export function Settings() {
  const [enabled, setEnabled] = useState(true)
  const [retry, setRetry] = useState(false)
  return (
    <SectionGrid>
      <PreferenceSectionCard
        headingId="settings-example"
        title="Preferences"
        description="Shared settings rows use headings and rules, with no surrounding window."
      >
        <PreferenceSectionDivider />
        <PreferenceSectionBody className="space-y-6">
          <SettingsRow
            label="Show completed orders"
            description="Include completed orders in this sample list."
            controlId="show-completed"
          >
            <Switch
              id="show-completed"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </SettingsRow>
          <PreferenceSectionDivider />
          <SettingsRow
            label="Current connection"
            description="Status text reflects supplied feature state."
          >
            <StatusPill variant="warning">Reconnecting</StatusPill>
          </SettingsRow>
        </PreferenceSectionBody>
      </PreferenceSectionCard>
      <div className="space-y-4">
        <StatePanel
          tone="error"
          title="Connection unavailable"
          description="Your saved settings remain visible. Try again when the connection is available."
          action={
            <Button variant="outline" onClick={() => setRetry(true)}>
              {retry ? "Retry requested (demo)" : "Try again"}
            </Button>
          }
        />
        <StatePanel
          tone="pending"
          title="Restore in progress"
          description="Keep the recovery state explicit. Presentation components never read recovery material or decide whether a retry is safe."
        />
      </div>
    </SectionGrid>
  )
}
