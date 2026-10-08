# Conduit UI workbench

This is the executable review reference for `@conduit/ui`. It imports the same
components as Market and Merchant. Its representative visual foundation was approved on October 7, 2026. New and
materially changed UI uses this reference; existing untouched screens adopt it
as they change. Approval does not certify every route or device. See the
[baseline report](../../../docs/knowledge/shared-ui-baseline.md) and
[current design guidance](../../../docs/DESIGN.md).

From the repository root:

```sh
bun run dev:ui
# http://127.0.0.1:7003
bun run typecheck:ui
bun run build:ui
bun run preview:ui
```

Stop the development server before running the preview on the same port, or
use `bun run preview:ui --port 7004`. The separate Vite entry writes to
`packages/ui/workbench/dist`; ordinary app builds have no workbench route.
It binds to loopback. No deployment workflow publishes it.

## Review map

| Section           | Examples and checks                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Commerce          | Real ProductCard, unavailable media, sold out, option selection, checkout summary and action hierarchy                    |
| Foundations       | Brand swatches and status mapping, typography, semantic surfaces, spacing, radii, density and responsive rules            |
| Controls          | Button hierarchy/sizes, native and Radix controls, combobox, breadcrumb, segmented controls, tabs, statuses and skeletons |
| Forms             | Visible labels, help and error associations, required-field focus recovery, textarea, checkbox, reset and submit feedback |
| Overlays          | Dialog, safe destructive confirmation, sheet, dropdown; focus trap, Escape, focus return and disabled menu entry          |
| Orders            | Semantic status table, row selection, compact/comfortable density and named horizontal scroll region                      |
| Event / inventory | Existing EventMarketCard, prepared assignment rows and loading/empty/error/pending states                                 |
| Settings / status | Existing PreferenceSectionCard, settings rows, switch, unavailable connection and restore progress                        |
| Baseline report   | Links to the baseline report and composition guide                                                                        |

Expand Preview controls to change themes, show long content or choose a state. State
selection applies to Commerce and Event / inventory; density applies to tables.
Use **200% text** and **Expanded text spacing** separately and together to inspect
reflow, clipped labels and overlay scrolling. The first doubles the root font size;
the second applies line height 1.5, paragraph spacing 2em, letter spacing 0.12em
and word spacing 0.16em. Neither changes browser preferences.
Check phone and desktop widths. On phones, section selection uses the existing
Select; desktop uses Tabs. Demo actions only change local React state.

The theme control exercises the existing device-local theme preference. It does
not use a signer or account settings. Fictional fixtures carry no customer data.
Product media uses the existing public Conduit placeholder; unavailable media
is an intentional second example. Do not add credentials or live mutations here.

## Authoring with shared recipes

1. Find the closest composition here before styling a route. Keep routing,
   validation, authorization and data fetching with the consuming feature.
2. Use `PageLayout`, `PageHeader`, `SectionGrid` and `ActionRow` for composition;
   use the existing app shell for navigation. Do not add a second app shell.
3. Use `Field` around one input, textarea or select trigger. Spread its supplied
   control props to preserve the visible label and help/error relationships.
   Use the feature's existing validation library; Field does not own validation.
   Supply `id` when an existing workflow needs a stable control ID. Retain
   external error associations when an alert belongs to the complete operation.
4. Use headings, spacing and rules for ordinary sections. Use Card only when a
   contained object is useful (for example, checkout or a focused form).
   PreferenceSectionCard provides ruled settings groups; SummaryList/SummaryRow
   provides aligned key/value totals. Avoid nested decorative frames.
5. Use the native Table family for relational data and provide a meaningful
   `scrollLabel`. Row actions remain real buttons/links with explicit selected
   state. No sorting, virtualization or hidden data transformation is implied.
6. Use StatePanel for explicit empty, unavailable and pending explanations.
   Callers own retry safety and live announcements. Do not infer payment,
   publication or inventory authority from presentation state.
7. Add a representative workbench example when adding a reusable capability.
   Reuse an existing primitive first. Promote repeated or clearly needed
   compositions into `packages/ui/src/components` and export them from its index.

### Visual grammar

- StatusPill is an icon/text label, despite its historical name. It is not an action.
- Color anchors come from the Brand elements palette: ink, purple, orange, rose and violet. Information is violet; errors are rose; attention is orange; ready is a neutral checkmark. Use readable foreground roles instead of raw signal colors for small text.
- Badge is a small rectangular classification/attention tag. Counts are plain text.
- Use a real pressed button for filters and segmented choices. Tabs have an active underline.
- Keep primary price neutral, prominent and tabular. Orange is not a readable price role in Day Market.
- Product cards retain an 8 px-radius border and surface, with media above a padded body. Labels use a 4 px gap above controls; help and errors use 8 px.
- Product and merchant names wrap. An accessible name alone does not reveal clipped content to sighted readers.
- Phone and coarse-pointer actions, selectors, switch targets and cart quantity controls use 44 px hit areas. Desktop compact variants remain available.
- Quantity controls remain visible after adding an item, with focus preserved as Add becomes Remove and back.
- Poppins is the shared UI font. Keep logo artwork as an asset and use system monospace for identifiers and technical references. Fonts and their OFL license are bundled in `src/assets/fonts`.
- Use 16 / 24 for reading and selector/input values; 14 px for short support, status and compact actions. Reserve 12 px for nonessential annotations. Keep Poppins 400/500/600 for body/actions/headings, normal tracking and wrapping headings.
- Use 4/8/12 px radii intentionally. Do not add glass highlights, passive hover shadows or decorative ticket shapes.

### Owners

| Concern                                     | Executable owner                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| Color, surface, radius and spacing tokens   | `src/styles/theme.css`                                                   |
| Font faces and voice roles                  | `src/styles/typography.css`                                              |
| Named themes, startup and persistence       | `src/theme/` and shared Vite bootstrap plugin                            |
| Tailwind token mapping                      | `packages/ui/tailwind.preset.js`; each app retains its own content paths |
| Accessible controls and composition recipes | `src/components/`                                                        |
| Realistic examples and state fixtures       | This directory                                                           |
| Navigation destinations and domain behavior | App routes/hooks and `@conduit/core`                                     |

Keep theme definitions, runtime and preset singular. Do not introduce local
color literals, copied button classes, route-owned dialogs, a new state library
or a second form framework to compose a screen. A feature needing an exception
should explain its concrete constraint and add a reviewable example here.

## Validation before adoption

Run the repository typecheck, lint, build and color/telemetry policies, plus the
workbench typecheck/build and `bun run ui:check` reuses the existing CI color-policy gate. It checks raw
hex/RGB literals, Tailwind palette shortcuts, unresolved CSS variable references,
and copied theme tokens/app presets. ESLint's `no-restricted-syntax` rejects
app-local native controls and ARIA replacements of shared keyboard/overlay
controls, including multiline JSX. Existing controls have reasoned inline
disables at their source; unused disables fail lint. Adopt shared controls when
those surfaces change, instead of carrying the disable into new work.

The policy is static: computed class construction and custom interaction logic
still need code review. CSS variables supplied by Radix are named explicitly;
local geometry variables must have a declaration or runtime setter.

The exact legacy color inventory is in
[`ui-foundation-exceptions.json`](../../../scripts/ci/ui-foundation-exceptions.json).
It records path, utility, occurrence count and reason, verified against main.
Added occurrences and stale entries fail. No wildcard path or open-ended color
exception is allowed. Use shared tokens when a surface changes. Black/white
contrast utilities remain available for foregrounds and QR media.

The policy audit repaired undefined wallet borders and a cart HUD shadow using
existing shared tokens. There is no new theme catalog, state library, form
framework, Ditto dependency or appearance synchronization.

## Remaining human checks

Physical phones, screen readers, native browser zoom and OS reduced-motion
behavior remain targeted human QA. Root-text enlargement and desktop browser
emulation establish specific reflow observations only. Preview deployment,
live signer restoration, relay delivery and funded wallet operations are
separate validation boundaries. Visual approval authorizes the foundation;
it does not grant merge, release or deployment authority.
