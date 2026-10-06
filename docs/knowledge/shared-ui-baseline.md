# Shared UI baseline and review candidate

The primary artifact is the [executable workbench](../../packages/ui/workbench/README.md),
run with `bun run dev:ui`. This report records a candidate direction; it does
not designate all existing Conduit UI as approved. No route-wide restyling is
part of this slice.

## Evidence inspected

Conduit baseline: main `dacdd946e9a406c8a4b9904b396f4ddb9d099a51`.
The inventory covered all 77 component source files in `packages/ui/src/components`,
the shared CSS/theme runtime, all three app Tailwind configurations and recurring
Market/Merchant product, order, event, form and settings compositions. Browser
inspection included the Market catalog and Merchant signed-out connection surface.
Authenticated order/inventory workflows were inspected in source; the workbench
uses fictional state, not a claim of live workflow validation.

Ditto source was frozen at
[`359e76f84d6415bb7eec87801e28c2af51f765cd`](https://github.com/soapbox-pub/ditto/tree/359e76f84d6415bb7eec87801e28c2af51f765cd).
The component tree includes roughly 50 shared UI files plus domain compositions.
Inspected implementations include `MainLayout`, `PageHeader`, `MobileBottomNav`,
`MobileDrawer`, `SettingsPage`, `EditProfileForm`, `EmbeddedCardShell`,
`RelayListRow`, `FeedEmptyState`, `TabButton` and the UI card, form, dialog, table
and button variants. Live [Ditto](https://ditto.pub) inspection covered its
desktop feed, settings overview and advanced settings, then the advanced form,
navigation drawer and sign-in dialog at 390 × 844. These show actual responsive
compositions, not just theme encoding. No sign-in was submitted.

The existing Conduit primitives already follow shadcn/Radix conventions. The
[shadcn Table](https://ui.shadcn.com/docs/components/radix/table) and
[Dialog](https://ui.shadcn.com/docs/components/radix/dialog) references informed
semantic composition and accessible overlay behavior. Ditto is prior art only;
no Ditto code or dependency was imported.

## Retain and deepen

| Conduit pattern                                              | Why retain it                                                                                       | Gap exposed by the inventory                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| ProductCard used by Market and Merchant                      | Shared media, identity, options, price and action slots already separate presentation from behavior | Day Market price contrast and compact action sizes need correction/review |
| EventMarketCard, EventPageHeader and EventTimeline           | Schedule, organizer and availability have an established hierarchy                                  | Route-specific containers and state treatments still vary                 |
| PreferenceSectionCard body/divider/footer                    | Clear settings grouping and explanatory copy; existing network settings reuse is strong             | Row geometry and ordinary-card radius differ                              |
| Radix overlays, Select, Tabs; cmdk Combobox; native Checkbox | Existing focus, keyboard and selection foundations                                                  | Labels, field errors and density are assembled repeatedly                 |
| Bricolage typography, Night/Day tokens and theme runtime     | Shared identity and signer-independent startup already exist                                        | Three byte-identical Tailwind maps invite drift                           |

Market order rows and Merchant OrderListItem repeat similar geometry without a
shared table/row contract. Merchant ProductCombinationMatrix owns a native table.
Page headings, totals, empty/error panels and field label/help/error groups are
repeated across routes. These are the useful abstraction gaps. Existing card
radii vary between standard Card, ProductCard and PreferenceSectionCard; this
report preserves the distinction for review instead of treating it as approval.

## Prior art translated into Conduit

- Ditto separates primitive controls, reusable content shells and domain rows.
  Its PageHeader, EmbeddedCardShell and RelayListRow support adding a small
  composition layer rather than either a primitive-only kit or route-sized API.
- Its desktop sidebar/content/utility columns become phone header, drawer and
  bottom navigation. Preserve content order and give navigation explicit mobile
  treatment; Conduit retains its own app navigation and commerce workflows.
- Its form groups associate labels, descriptions and errors. Field supplies
  those relationships without importing another form library.
- Its feed states distinguish unavailable/offline content from empty content.
  Conduit states additionally preserve pending and evidence distinctions.
- shadcn's semantic table composition fits order and inventory examples without
  adding a data-grid engine. Existing Radix primitives continue to own overlay
  and keyboard mechanics.

Ditto's social-feed shell, decorative arcs and brand treatment are not copied.
Its existence does not make every observed control an accessibility precedent.

## Smallest coherent inventory

Retain the current button, field controls, card, badge/status, skeleton,
tabs/segmented control/breadcrumb, dialog/alert dialog/sheet, menu/popover/command
and domain-component families. Add only:

| Addition                                       | Reused responsibility                                                  | Exercised composition                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| Field                                          | Label, help/error IDs and invalid state                                | Product form, select, dialog                          |
| PageLayout, PageHeader, SectionGrid, ActionRow | Page width/gutters, headings, responsive sections and wrapping actions | Workbench shell, commerce, forms, settings            |
| SummaryList, SummaryRow                        | Semantic key/value totals                                              | Checkout                                              |
| SettingsRow                                    | Consistent label/control arrangement                                   | Settings and connection status                        |
| Table family                                   | Native markup, explicit density and contained keyboard scrolling       | Orders and inventory                                  |
| StatePanel                                     | Explicit state explanation and optional recovery action                | Empty cart, unavailable source, pending order/restore |

Recipes use 8 px related-control gaps, 16 px within-section spacing, 24 px between
sections, 16/24 px phone/desktop page gutters and a `max-w-7xl` content frame.
Tables offer comfortable and compact density. Prose wraps, numbers use tabular
figures, and important technical strings must be allowed to break. Feature
code supplies data, authorization, validation, selection and safe actions.

The workbench contains product cards, checkout, orders, a validated form,
dialogs/sheets/menus, settings/status and Event Market/inventory examples with
loading, empty, error, disabled, selected and pending states. The new preset
extracts the identical app token maps without changing their values.

## Deliberate exclusions

No Ditto codec, theme event interoperability, private appearance synchronization,
theme catalog migration, app redesign, domain data engine, generic data grid,
schema-driven form generator, editor/chart kit, new icon/font library or state
management dependency. No shared component owns signer, payment, inventory or
relay authority. Other existing components remain available; this candidate
does not deprecate them merely because they lack a story in the initial reference.

## Visual decisions and known gaps

Recommended direction: retain Conduit's identity and strong compositions; adopt
the spacing/density recipes and neutral checkout hierarchy with one purple next
action. Preserve the more rounded settings grouping for this bounded slice.
Review that radius distinction, the 16/24 px gutters and comfortable/compact
density on phone and desktop before broad adoption.

Accessibility corrections do not depend on aesthetic preference. The inherited
Day Market ProductCard price computes to `rgb(234, 152, 97)` on white, a 2.29:1
contrast ratio. Some existing status/disabled-looking accents and compact touch
targets also need a systematic check. These are exposed in the reference and
must be corrected or explicitly bounded before it becomes an approved baseline.
Current screenshots are design-review evidence, not an accessibility sign-off.

Review disposition: **targeted human QA**, with visual checkpoint still pending.
Browser checks and remaining gaps are recorded with the candidate's review
handoff. No source inspection or automated test substitutes for that decision.
