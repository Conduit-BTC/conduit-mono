import type {
  DashboardChartData,
  StatusSlice,
  TimeBucketPoint,
  TopProduct,
} from "../lib/dashboard-charts"

// One purple hue for counts, one orange hue for money — single hue per chart.
const COUNT_COLOR = "var(--primary-500)"
const MONEY_COLOR = "var(--secondary-500)"

const STATUS_COLORS: Record<StatusSlice["key"], string> = {
  pending: "var(--warning)",
  in_progress: "var(--info)",
  completed: "var(--success)",
  cancelled: "var(--text-muted)",
}

function formatSats(sats: number): string {
  return `${Math.round(sats).toLocaleString()} sats`
}

function ChartCard({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
      <h3 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
        {title}
      </h3>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
      {children}
    </div>
  )
}

// Top-rounded bar anchored to the baseline.
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  const b = y + h
  return `M${x},${b} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${b} Z`
}

function VerticalBarChart({
  points,
  color,
  formatValue,
  ariaLabel,
  maxLabels = 6,
}: {
  points: TimeBucketPoint[]
  color: string
  formatValue: (value: number) => string
  ariaLabel: string
  maxLabels?: number
}) {
  const W = 640
  const H = 156
  const padT = 10
  const padB = 2
  const plotH = H - padT - padB
  const n = points.length
  const max = Math.max(1, ...points.map((p) => p.value))
  const gap = 2
  const barW = Math.max(1, (W - gap * (n - 1)) / n)
  const labelStep = Math.max(1, Math.ceil(n / maxLabels))

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        className="h-36 w-full"
      >
        <line
          x1={0}
          y1={padT + plotH}
          x2={W}
          y2={padT + plotH}
          stroke="var(--border)"
          strokeWidth={1}
        />
        {points.map((point, i) => {
          const x = i * (barW + gap)
          const h = (point.value / max) * plotH
          const y = padT + plotH - h
          return point.value > 0 ? (
            <path key={point.date} d={barPath(x, y, barW, h)} fill={color}>
              <title>{`${point.label}: ${formatValue(point.value)}`}</title>
            </path>
          ) : null
        })}
      </svg>
      <div className="relative mt-1 h-4 tabular-nums text-xs text-[var(--text-muted)]">
        {points.map((point, i) => {
          const showLabel = i % labelStep === 0 || i === n - 1
          if (!showLabel) return null

          const isFirst = i === 0
          const isLast = i === n - 1
          return (
            <span
              key={point.date}
              className={`absolute top-0 whitespace-nowrap ${
                isFirst || isLast ? "" : "-translate-x-1/2"
              }`}
              style={
                isFirst
                  ? { left: 0 }
                  : isLast
                    ? { right: 0 }
                    : { left: `${((i + 0.5) / n) * 100}%` }
              }
            >
              {point.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function OrdersOverTimeChart({ points }: { points: TimeBucketPoint[] }) {
  const total = points.reduce((sum, p) => sum + p.value, 0)
  return (
    <ChartCard title="Orders over time">
      {total === 0 ? (
        <EmptyNote>No orders in the last 30 days yet.</EmptyNote>
      ) : (
        <>
          <div className="mb-3 tabular-nums text-3xl font-semibold text-[var(--text-primary)]">
            {total}
            <span className="ml-2 text-sm font-normal text-[var(--text-secondary)]">
              orders
            </span>
          </div>
          <VerticalBarChart
            points={points}
            color={COUNT_COLOR}
            formatValue={(value) => `${value} order${value === 1 ? "" : "s"}`}
            ariaLabel="Orders over time"
          />
        </>
      )}
    </ChartCard>
  )
}

export function RevenueOverTimeChart({
  points,
  hasRevenue,
}: {
  points: TimeBucketPoint[]
  hasRevenue: boolean
}) {
  const total = points.reduce((sum, p) => sum + p.value, 0)
  return (
    <ChartCard title="Revenue (paid)">
      {!hasRevenue || total === 0 ? (
        <EmptyNote>No convertible paid revenue in the last 30 days.</EmptyNote>
      ) : (
        <>
          <div className="mb-3 tabular-nums text-2xl font-semibold text-secondary-300">
            {formatSats(total)}
          </div>
          <VerticalBarChart
            points={points}
            color={MONEY_COLOR}
            formatValue={formatSats}
            ariaLabel="Paid revenue over time"
            maxLabels={4}
          />
        </>
      )}
    </ChartCard>
  )
}

export function StatusBreakdownChart({ slices }: { slices: StatusSlice[] }) {
  const total = slices.reduce((sum, s) => sum + s.count, 0)
  const size = 160
  const stroke = 22
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const gap = total > 1 ? 6 : 0
  let offset = 0

  return (
    <ChartCard title="Order status">
      {total === 0 ? (
        <EmptyNote>No orders to break down yet.</EmptyNote>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <svg
            viewBox={`0 0 ${size} ${size}`}
            width={size}
            height={size}
            role="img"
            aria-label="Order status breakdown"
            className="shrink-0"
          >
            <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
              {slices.map((slice) => {
                const frac = slice.count / total
                const dash = Math.max(0, frac * c - gap)
                const circle = (
                  <circle
                    key={slice.key}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={STATUS_COLORS[slice.key]}
                    strokeWidth={stroke}
                    strokeDasharray={`${dash} ${c - dash}`}
                    strokeDashoffset={-offset}
                  >
                    <title>{`${slice.label}: ${slice.count}`}</title>
                  </circle>
                )
                offset += frac * c
                return circle
              })}
            </g>
            <text
              x={size / 2}
              y={size / 2 - 4}
              textAnchor="middle"
              fill="var(--text-primary)"
              style={{ fontSize: 26, fontWeight: 600 }}
            >
              {total}
            </text>
            <text
              x={size / 2}
              y={size / 2 + 16}
              textAnchor="middle"
              fill="var(--text-secondary)"
              style={{ fontSize: 12 }}
            >
              orders
            </text>
          </svg>
          <ul className="min-w-0 flex-1 space-y-2">
            {slices.map((slice) => (
              <li
                key={slice.key}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: STATUS_COLORS[slice.key] }}
                  />
                  <span className="truncate text-[var(--text-secondary)]">
                    {slice.label}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums font-medium text-[var(--text-primary)]">
                  {slice.count}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  )
}

export function TopProductsChart({ items }: { items: TopProduct[] }) {
  const max = Math.max(1, ...items.map((item) => item.quantity))
  return (
    <ChartCard title="Top products">
      {items.length === 0 ? (
        <EmptyNote>No ordered items to rank yet.</EmptyNote>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.productId} className="space-y-1">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-[var(--text-primary)]">
                  {item.title}
                </span>
                <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                  {item.quantity}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-elevated)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(item.quantity / max) * 100}%`,
                    backgroundColor: COUNT_COLOR,
                  }}
                  title={`${item.title}: ${item.quantity} ordered`}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </ChartCard>
  )
}

export function DashboardCharts({ data }: { data: DashboardChartData }) {
  return (
    <div className="space-y-3">
      <OrdersOverTimeChart points={data.ordersByDay} />
      <div className="grid gap-3 lg:grid-cols-3">
        <StatusBreakdownChart slices={data.statusSlices} />
        <RevenueOverTimeChart
          points={data.revenueByDay}
          hasRevenue={data.hasRevenue}
        />
        <TopProductsChart items={data.topProducts} />
      </div>
    </div>
  )
}
