import { StrictMode, useState, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import {
  ActionRow,
  Field,
  PageHeader,
  PageLayout,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ThemeToggleButton,
} from "@conduit/ui"
import {
  getServerThemeSnapshot,
  getThemeSnapshot,
  initializeTheme,
  setThemePreference,
  subscribeToTheme,
} from "@conduit/ui/theme"
import { Commerce, Events, Orders, type ExampleState } from "./Commerce"
import { Controls, FormExample, Overlays, Settings } from "./Controls"
import { Baseline, Foundations } from "./Reference"
import "@conduit/ui/styles/site.css"
import "./styles.css"

initializeTheme()
const sections = [
  ["commerce", "Commerce"],
  ["foundations", "Foundations"],
  ["controls", "Controls"],
  ["forms", "Forms"],
  ["overlays", "Overlays"],
  ["orders", "Orders"],
  ["events", "Event / inventory"],
  ["settings", "Settings / status"],
  ["baseline", "Baseline report"],
] as const

function Workbench() {
  const [section, setSection] = useState("commerce")
  const [state, setState] = useState<ExampleState>("ready")
  const [long, setLong] = useState(false)
  const [compact, setCompact] = useState(false)
  const [largeText, setLargeText] = useState(false)
  const [expandedSpacing, setExpandedSpacing] = useState(false)
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot
  )
  return (
    <PageLayout
      className="ui-workbench space-y-4 sm:space-y-6"
      data-large-text={largeText}
      data-expanded-spacing={expandedSpacing}
    >
      <a href="#examples" className="sr-only focus:not-sr-only focus:underline">
        Skip to examples
      </a>
      <PageHeader
        title="Conduit UI workbench"
        description="Shared components · Shared foundation"
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 [&_h1]:text-2xl sm:[&_h1]:text-3xl [&_p]:text-sm"
        actions={<ThemeToggleButton />}
      />
      <details className="border-y border-[var(--border)]">
        <summary className="cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]">
          Preview controls ·{" "}
          {theme.resolvedTheme === "day-market" ? "Day" : "Night"} · {state}
        </summary>
        <div className="flex flex-wrap items-end gap-5 border-t border-[var(--border)] p-4">
          <div className="w-full min-w-0 sm:w-auto sm:min-w-40">
            <Field label="Theme">
              {(props) => (
                <Select
                  value={theme.preference}
                  onValueChange={(value) => {
                    if (
                      value === "system" ||
                      value === "day-market" ||
                      value === "night-market"
                    )
                      setThemePreference(value)
                  }}
                >
                  <SelectTrigger {...props}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="day-market">Day Market</SelectItem>
                    <SelectItem value="night-market">Night Market</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          <div className="w-full min-w-0 sm:w-auto sm:min-w-36">
            <Field label="Example state">
              {(props) => (
                <Select
                  value={state}
                  onValueChange={(value) => {
                    if (
                      [
                        "ready",
                        "loading",
                        "empty",
                        "error",
                        "pending",
                      ].includes(value)
                    )
                      setState(value as ExampleState)
                  }}
                >
                  <SelectTrigger {...props}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["ready", "loading", "empty", "error", "pending"].map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {value[0].toUpperCase() + value.slice(1)}
                        </SelectItem>
                      )
                    )}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          <ActionRow className="min-h-10">
            <Switch
              id="long-content"
              checked={long}
              onCheckedChange={setLong}
            />
            <label htmlFor="long-content" className="text-sm">
              Long content
            </label>
          </ActionRow>
          <ActionRow className="min-h-10">
            <Switch
              id="compact-rows"
              checked={compact}
              onCheckedChange={setCompact}
            />
            <label htmlFor="compact-rows" className="text-sm">
              Compact tables
            </label>
          </ActionRow>
          <ActionRow className="min-h-10">
            <Switch
              id="large-text"
              checked={largeText}
              onCheckedChange={setLargeText}
            />
            <label htmlFor="large-text" className="text-sm">
              200% text
            </label>
          </ActionRow>
          <ActionRow className="min-h-10">
            <Switch
              id="expanded-spacing"
              checked={expandedSpacing}
              onCheckedChange={setExpandedSpacing}
            />
            <label htmlFor="expanded-spacing" className="text-sm">
              Expanded text spacing
            </label>
          </ActionRow>
          <p className="basis-full text-pretty text-sm leading-normal text-[var(--text-secondary)]">
            Reading checks enlarge root text or apply the WCAG spacing overrides
            to the whole preview, including menus and dialogs. They do not
            change your browser settings.
          </p>
          <p className="basis-full text-pretty text-sm leading-normal text-[var(--text-secondary)]">
            State controls apply to Commerce and Event / inventory. All data is
            fictional; no signer, wallet, relay or account action runs. Resize
            the browser to inspect phone and desktop layouts.
          </p>
        </div>
      </details>
      <main id="examples" tabIndex={-1}>
        <Tabs value={section} onValueChange={setSection}>
          <div className="mb-5 sm:hidden">
            <Field label="Reference section">
              {(props) => (
                <Select value={section} onValueChange={setSection}>
                  <SelectTrigger {...props}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sections.map(([id, label]) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          <TabsList
            aria-label="Reference sections"
            className="mb-5 hidden w-full flex-wrap justify-start gap-1 sm:flex"
          >
            {sections.map(([id, label]) => (
              <TabsTrigger key={id} value={id}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="commerce">
            <Commerce state={state} long={long} />
          </TabsContent>
          <TabsContent value="foundations">
            <Foundations />
          </TabsContent>
          <TabsContent value="controls">
            <Controls />
          </TabsContent>
          <TabsContent value="forms">
            <FormExample />
          </TabsContent>
          <TabsContent value="overlays">
            <Overlays />
          </TabsContent>
          <TabsContent value="orders">
            <Orders compact={compact} long={long} />
          </TabsContent>
          <TabsContent value="events">
            <Events state={state} long={long} compact={compact} />
          </TabsContent>
          <TabsContent value="settings">
            <Settings />
          </TabsContent>
          <TabsContent value="baseline">
            <Baseline />
          </TabsContent>
        </Tabs>
      </main>
      <footer className="border-t border-[var(--border)] pt-4 text-pretty text-xs text-[var(--text-secondary)]">
        @conduit/ui · Development / local preview only · Current theme:{" "}
        {theme.resolvedTheme} · Shared visual foundation · Validate each
        consuming workflow.
      </footer>
    </PageLayout>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Workbench />
  </StrictMode>
)
