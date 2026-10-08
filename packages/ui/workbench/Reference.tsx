import { SectionGrid, StatusPill, SummaryList, SummaryRow } from "@conduit/ui"

export function Foundations() {
  return (
    <div className="space-y-6">
      <section className="space-y-5 border-t border-[var(--border)] pt-6">
        <header className="space-y-1.5">
          <h2 className="text-lg font-semibold">Brand palette</h2>
          <p className="max-w-prose text-pretty text-base leading-6 text-[var(--text-secondary)]">
            Exact swatches from Conduit Design’s Brand elements color board.
            Interaction shades and readable text tints derive from these
            anchors.
          </p>
        </header>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {[
            ["Ink", "--brand-ink"],
            ["Purple", "--brand-purple"],
            ["Orange", "--brand-orange"],
            ["Rose", "--brand-rose"],
            ["Violet", "--brand-violet"],
          ].map(([name, token]) => (
            <div key={name} className="space-y-2">
              <div
                aria-hidden="true"
                className="h-20 rounded-[var(--radius-sm)] border border-[var(--border)]"
                style={{ backgroundColor: `var(${token})` }}
              />
              <dt className="text-sm font-medium">{name}</dt>
              <dd className="font-mono text-xs text-[var(--text-secondary)]">
                {token}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          <StatusPill variant="success">Ready</StatusPill>
          <StatusPill variant="warning">Needs attention</StatusPill>
          <StatusPill variant="error">Unavailable</StatusPill>
          <StatusPill variant="info">Informational</StatusPill>
          <StatusPill variant="neutral">Draft</StatusPill>
        </div>
        <p className="max-w-prose text-pretty text-base leading-6 text-[var(--text-secondary)]">
          Ready uses a neutral checkmark. Orange signals attention, rose signals
          errors, and violet carries information. Words and icons carry meaning
          alongside color. Orange actions use ink text; small Day Market
          warnings pair an orange icon with neutral copy.
        </p>
      </section>
      <SectionGrid>
        <section className="space-y-5 border-t border-[var(--border)] pt-6">
          <header className="space-y-1.5">
            <h2 className="text-lg font-semibold">Typography</h2>
            <p className="max-w-prose text-pretty text-base leading-6 text-[var(--text-secondary)]">
              Poppins for headings, body copy and controls. System monospace for
              identifiers and technical references; logo artwork stays separate.
            </p>
          </header>
          <div className="space-y-4">
            <p className="voice-3xl text-balance">Page title · 30 / 42</p>
            <p className="voice-xl text-balance">Section heading · 20 / 28</p>
            <p className="voice-base text-pretty">
              Body, inputs and selectors · 16 / 24
            </p>
            <p className="voice-sm text-pretty">Supporting text · 14 / 21</p>
            <p className="voice-xs">Nonessential annotation only · 12 / 18</p>
            <p className="font-mono text-sm tabular-nums">
              SAMPLE-1042 · 24,000 sats
            </p>
          </div>
        </section>
        <section className="space-y-5 border-t border-[var(--border)] pt-6">
          <header className="space-y-1.5">
            <h2 className="text-lg font-semibold">
              Spacing, density and shape
            </h2>
            <p className="max-w-prose text-pretty text-base leading-6 text-[var(--text-secondary)]">
              Shared composition rules using existing Tailwind spacing and
              radius tokens.
            </p>
          </header>
          <div>
            <SummaryList>
              <SummaryRow label="Related inline controls">
                8 px · gap-2
              </SummaryRow>
              <SummaryRow label="Within a section">16 px · gap-4</SummaryRow>
              <SummaryRow label="Between sections">24 px · gap-6</SummaryRow>
              <SummaryRow label="Page gutters">16 / 24 px</SummaryRow>
              <SummaryRow label="Content width">max-w-7xl</SummaryRow>
              <SummaryRow label="Reading width">max-w-prose</SummaryRow>
              <SummaryRow label="Controls / cards">4 / 8 px</SummaryRow>
              <SummaryRow label="Dialogs">12 px · radius-lg</SummaryRow>
              <SummaryRow label="Settings sections">
                Headings and rules
              </SummaryRow>
              <SummaryRow label="Table rows">8 / 16 px vertical</SummaryRow>
            </SummaryList>
          </div>
        </section>
      </SectionGrid>
      <section className="space-y-5 border-t border-[var(--border)] pt-6">
        <header className="space-y-1.5">
          <h2 className="text-lg font-semibold">Semantic surfaces</h2>
          <p className="max-w-prose text-pretty text-base leading-6 text-[var(--text-secondary)]">
            Theme values remain in the shared CSS owner. Change themes with the
            control above.
          </p>
        </header>
        <div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--background)] p-6">
              <p className="font-medium">Background</p>
              <p className="text-sm text-[var(--text-secondary)]">
                Page canvas
              </p>
            </div>
            <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-6">
              <p className="font-medium">Surface</p>
              <p className="text-sm text-[var(--text-secondary)]">
                Persistent content
              </p>
            </div>
            <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-elevated)] p-6">
              <p className="font-medium">Elevated surface</p>
              <p className="text-sm text-[var(--text-secondary)]">
                Nested controls / selected row
              </p>
            </div>
          </div>
        </div>
      </section>
      <section className="space-y-5 border-t border-[var(--border)] pt-6">
        <header className="space-y-1.5">
          <h2 className="text-lg font-semibold">
            Accessibility and responsive rules
          </h2>
        </header>
        <div>
          <ul className="list-disc space-y-3 pl-5 text-pretty text-base leading-6 text-[var(--text-secondary)]">
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
              Wrap prose, product names and merchant names. Do not hide full
              names only in accessible labels. Test 200% zoom, reduced motion
              and long content before adoption.
            </li>
          </ul>
        </div>
      </section>
    </div>
  )
}

export function Baseline() {
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Baseline and shared inventory</h2>
      <p className="max-w-prose text-base text-[var(--text-secondary)]">
        Read the{" "}
        <a
          className="underline"
          href="https://github.com/Conduit-BTC/conduit-mono/blob/feat/shared-ui-workbench/docs/knowledge/shared-ui-baseline.md"
        >
          baseline report
        </a>{" "}
        for the inventory, prior art and approved foundation, and the{" "}
        <a
          className="underline"
          href="https://github.com/Conduit-BTC/conduit-mono/blob/feat/shared-ui-workbench/packages/ui/workbench/README.md"
        >
          workbench guide
        </a>{" "}
        for composition and validation guidance.
      </p>
    </section>
  )
}
