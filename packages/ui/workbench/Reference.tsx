import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SectionGrid,
  SummaryList,
  SummaryRow,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@conduit/ui"

const inventory = [
  [
    "Actions",
    "Button, ActionRow",
    "Primary, outline, ghost, disabled, pending; legacy warm/accent variants retained.",
  ],
  [
    "Forms",
    "Field, Input, Textarea, Label, Checkbox, Switch, Select, Combobox",
    "Label/help/error associations; validation belongs to feature code.",
  ],
  [
    "Surfaces",
    "Card, PreferenceSectionCard, SettingsRow",
    "Standard content, settings body/divider/footer, long copy.",
  ],
  [
    "Layout",
    "PageLayout, PageHeader, SectionGrid",
    "Shared gutters and content width; phone reading order.",
  ],
  [
    "Commerce",
    "ProductCard, ProductCartAction, EventMarketCard, EventTimeline, OrderDetailCard",
    "Existing domain components; prepared display data and action slots.",
  ],
  [
    "Summaries",
    "SummaryList, SummaryRow",
    "Checkout, fees, inventory totals; tabular numbers and wrapping labels.",
  ],
  [
    "Data",
    "Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption",
    "Semantic markup, compact/comfortable density, named keyboard scroll region.",
  ],
  [
    "States",
    "StatusPill, Badge, Skeleton, StatePanel",
    "Loading, empty, error, pending, selected and unavailable stay distinct.",
  ],
  [
    "Overlays",
    "Dialog, AlertDialog, Sheet, DropdownMenu, Popover, Command",
    "Existing Radix focus/keyboard behavior and cmdk search.",
  ],
  [
    "Navigation",
    "Tabs, SegmentedControl, Breadcrumb, AccountMenu",
    "Panel selection and page navigation retain different semantics.",
  ],
]

export function Foundations() {
  return (
    <div className="space-y-6">
      <SectionGrid>
        <Card>
          <CardHeader>
            <CardTitle>Typography</CardTitle>
            <CardDescription>
              Existing Bricolage Grotesque roles; no new font or theme branch.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="voice-3xl text-balance">Page title · 30 / 42</p>
            <p className="voice-xl text-balance">Section heading · 20 / 28</p>
            <p className="voice-base text-pretty">
              Body and form input · 16 / 24
            </p>
            <p className="voice-sm text-pretty">Supporting text · 14 / 21</p>
            <p className="voice-xs">Metadata · 12 / 18</p>
            <p className="font-mono text-sm tabular-nums">
              SAMPLE-1042 · 24,000 sats
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Spacing, density and shape</CardTitle>
            <CardDescription>
              Proposed composition rules using existing Tailwind spacing and
              radius tokens.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SummaryList>
              <SummaryRow label="Related inline controls">
                8 px · gap-2
              </SummaryRow>
              <SummaryRow label="Within a section">16 px · gap-4</SummaryRow>
              <SummaryRow label="Between sections">24 px · gap-6</SummaryRow>
              <SummaryRow label="Page gutters">16 / 24 px</SummaryRow>
              <SummaryRow label="Content width">max-w-7xl</SummaryRow>
              <SummaryRow label="Reading width">max-w-prose</SummaryRow>
              <SummaryRow label="Controls / cards">
                radius-md / radius-xl
              </SummaryRow>
              <SummaryRow label="Settings cards">Existing 1.75 rem</SummaryRow>
              <SummaryRow label="Table rows">8 / 16 px vertical</SummaryRow>
            </SummaryList>
          </CardContent>
        </Card>
      </SectionGrid>
      <Card>
        <CardHeader>
          <CardTitle>Semantic surfaces</CardTitle>
          <CardDescription>
            Theme values remain in the shared CSS owner. Change themes with the
            control above.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-6">
              <p className="font-medium">Background</p>
              <p className="text-sm text-[var(--text-secondary)]">
                Page canvas
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
              <p className="font-medium">Surface</p>
              <p className="text-sm text-[var(--text-secondary)]">
                Persistent content
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-6">
              <p className="font-medium">Elevated surface</p>
              <p className="text-sm text-[var(--text-secondary)]">
                Nested controls / selected row
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Accessibility and responsive rules</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-3 pl-5 text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            <li>
              Preserve the same reading order on phone and desktop. Stack
              section grids on phones and scroll genuinely tabular data within a
              named region.
            </li>
            <li>
              Use visible focus rings, visible labels and descriptive names for
              icon actions. Tabs use arrow keys; menus support arrows and
              Escape; dialogs trap and restore focus.
            </li>
            <li>
              Keep input text at 16 px on phones. Prefer 44 px touch targets for
              primary phone actions; inspect compact controls in context.
            </li>
            <li>
              Use words and icons in addition to status colors. Loading is not
              empty; pending is not success; delivery is not payment.
            </li>
            <li>
              Wrap prose and important labels. Truncated product names need a
              full-name detail route. Test 200% zoom, reduced motion and long
              content before adoption.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

export function Baseline() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Baseline and proposed inventory</CardTitle>
          <CardDescription>
            Review candidate from Conduit main dacdd946 and Ditto source
            359e76f8. Current implementation is evidence, not automatic design
            approval.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Badge variant="warning">Visual checkpoint pending</Badge>
          <p className="text-pretty text-sm leading-6 text-[var(--text-secondary)]">
            Conduit already has a substantial shared system: 77 component source
            files, tokenized Night/Day themes, a signer-independent theme
            runtime and many domain compositions. This slice makes it
            discoverable and supplies a small missing composition layer.
          </p>
        </CardContent>
      </Card>
      <Table scrollLabel="Proposed component inventory">
        <TableCaption>
          Retain the existing primitives; add only the composition gaps
          exercised here.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Family</TableHead>
            <TableHead>Executable owners</TableHead>
            <TableHead>Coverage / boundary</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {inventory.map(([family, owners, coverage]) => (
            <TableRow key={family}>
              <TableCell className="font-medium">{family}</TableCell>
              <TableCell>{owners}</TableCell>
              <TableCell>{coverage}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <SectionGrid>
        <Card>
          <CardHeader>
            <CardTitle>Retained from Conduit</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-3 pl-5 text-sm leading-6">
              <li>
                Bricolage typography, named themes, semantic surfaces, existing
                purple action color and token radii.
              </li>
              <li>
                ProductCard media/identity/price/action structure shared by
                Market and Merchant.
              </li>
              <li>
                EventMarketCard and EventTimeline schedule/organizer hierarchy.
              </li>
              <li>
                PreferenceSectionCard grouping, explanatory copy and action
                slots.
              </li>
              <li>
                Radix dialogs, sheets, select, menus and tabs; native checkbox
                and existing cmdk combobox.
              </li>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Informed by Ditto and shadcn</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-3 pl-5 text-sm leading-6">
              <li>
                Ditto’s shared PageHeader, EmbeddedCardShell and RelayListRow
                demonstrate the useful layer between primitives and entire
                routes.
              </li>
              <li>
                Its desktop sidebar/content/utility layout becomes a header,
                drawer and bottom navigation on phones. Adopt the responsive
                separation of concerns, not the social-feed shell.
              </li>
              <li>
                Its EditProfileForm groups fields with labels, help and errors;
                its FeedEmptyState carries explicit retry/offline context.
              </li>
              <li>
                shadcn’s composable semantic table and field association
                patterns inform the new Table and Field. No table engine or new
                form dependency.
              </li>
            </ul>
          </CardContent>
        </Card>
      </SectionGrid>
      <SectionGrid>
        <Card>
          <CardHeader>
            <CardTitle>Deliberately not added</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-3 pl-5 text-sm leading-6">
              <li>
                Ditto codecs, theme events, private appearance sync or a new
                theme catalog.
              </li>
              <li>
                A copied Ditto feed shell, ornamental arcs, extra animations, a
                new icon library or font.
              </li>
              <li>
                Generic data grids, sorting engines, schema-driven forms, chart
                kits, rich editors or a configuration framework.
              </li>
              <li>
                Wallet, signer, inventory or payment logic in presentation
                components.
              </li>
              <li>
                A whole-app cosmetic migration. Existing routes adopt shared
                recipes when materially changed.
              </li>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Review choices</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-3 pl-5 text-sm leading-6">
              <li>
                Retain the restrained standard cards and the existing more
                rounded settings sections, or unify their shape later?
              </li>
              <li>
                Approve 16/24 px page gutters, 24 px section gaps and
                compact/comfortable table density?
              </li>
              <li>
                Approve a neutral checkout hierarchy with purple for the next
                action; keep orange primarily in existing price treatments?
              </li>
              <li>
                Resolve low-contrast Day Market price/status accents and compact
                phone controls before promoting the reference as approved.
              </li>
            </ol>
          </CardContent>
        </Card>
      </SectionGrid>
      <p className="text-pretty text-sm text-[var(--text-secondary)]">
        Sources:{" "}
        <a
          className="underline"
          href="https://github.com/soapbox-pub/ditto/tree/359e76f84d6415bb7eec87801e28c2af51f765cd/src/components"
        >
          Ditto component source
        </a>{" "}
        ·{" "}
        <a className="underline" href="https://ditto.pub">
          Ditto live desktop and phone inspection
        </a>{" "}
        ·{" "}
        <a
          className="underline"
          href="https://ui.shadcn.com/docs/components/radix/table"
        >
          shadcn Table
        </a>{" "}
        ·{" "}
        <a
          className="underline"
          href="https://ui.shadcn.com/docs/components/radix/dialog"
        >
          shadcn Dialog
        </a>
      </p>
    </div>
  )
}
