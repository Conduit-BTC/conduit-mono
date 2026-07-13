import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conduit/ui"
import {
  DASHBOARD_RANGE_OPTIONS,
  getDashboardRangeLabel,
  isDashboardRangePreset,
  type DashboardChartData,
  type DashboardRangePreset,
  type StatusSlice,
  type TimeBucketPoint,
  type TopProduct,
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
  range,
  onRangeChange,
  children,
}: {
  title: string
  range: DashboardRangePreset
  onRangeChange: (range: DashboardRangePreset) => void
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[1.6rem] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-glass-inset)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-balance text-lg font-semibold text-[var(--text-primary)]">
          {title}
        </h3>
        <Select
          value={range}
          onValueChange={(value) => {
            if (isDashboardRangePreset(value)) onRangeChange(value)
          }}
        >
          <SelectTrigger
            aria-label={`Time range for ${title}`}
            className="w-36"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {DASHBOARD_RANGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
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
  maxLabels = 7,
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
  const slotW = W / n
  const barW = Math.min(48, Math.max(3, slotW * 0.72))
  const labelStep = Math.max(1, Math.ceil(n / maxLabels))
  const showEveryLabel = n <= maxLabels

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
          const x = i * slotW + (slotW - barW) / 2
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

          const pinToStart = !showEveryLabel && i === 0
          const pinToEnd = !showEveryLabel && i === n - 1
          return (
            <span
              key={point.date}
              className={`absolute top-0 whitespace-nowrap ${
                pinToStart || pinToEnd ? "" : "-translate-x-1/2"
              }`}
              style={
                pinToStart
                  ? { left: 0 }
                  : pinToEnd
                    ? { right: 0 }
                    : { left: `${((i + 0.5) / n) * 100}%` }
              }
            >
              {point.axisLabel ?? point.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}

interface RangeControlledChartProps {
  range: DashboardRangePreset
  onRangeChange: (range: DashboardRangePreset) => void
}

export function OrdersOverTimeChart({
  points,
  range,
  onRangeChange,
}: {
  points: TimeBucketPoint[]
} & RangeControlledChartProps) {
  const total = points.reduce((sum, p) => sum + p.value, 0)
  const rangeLabel = getDashboardRangeLabel(range)
  return (
    <ChartCard
      title="Orders over time"
      range={range}
      onRangeChange={onRangeChange}
    >
      {total === 0 ? (
        <EmptyNote>No orders in this range yet.</EmptyNote>
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
            ariaLabel={`Orders over time, ${rangeLabel}`}
          />
        </>
      )}
    </ChartCard>
  )
}

export function RevenueOverTimeChart({
  points,
  hasRevenue,
  range,
  onRangeChange,
}: {
  points: TimeBucketPoint[]
  hasRevenue: boolean
} & RangeControlledChartProps) {
  const total = points.reduce((sum, p) => sum + p.value, 0)
  const rangeLabel = getDashboardRangeLabel(range)
  return (
    <ChartCard
      title="Revenue (paid)"
      range={range}
      onRangeChange={onRangeChange}
    >
      {!hasRevenue || total === 0 ? (
        <EmptyNote>No convertible paid revenue in this range.</EmptyNote>
      ) : (
        <>
          <div className="mb-3 tabular-nums text-2xl font-semibold text-secondary-300">
            {formatSats(total)}
          </div>
          <VerticalBarChart
            points={points}
            color={MONEY_COLOR}
            formatValue={formatSats}
            ariaLabel={`Paid revenue over time, ${rangeLabel}`}
          />
        </>
      )}
    </ChartCard>
  )
}

export function StatusBreakdownChart({
  slices,
  range,
  onRangeChange,
}: {
  slices: StatusSlice[]
} & RangeControlledChartProps) {
  const total = slices.reduce((sum, s) => sum + s.count, 0)
  const size = 160
  const stroke = 22
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const gap = total > 1 ? 6 : 0
  let offset = 0

  return (
    <ChartCard title="Order status" range={range} onRangeChange={onRangeChange}>
      {total === 0 ? (
        <EmptyNote>No orders in this range yet.</EmptyNote>
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

export function TopProductsChart({
  items,
  range,
  onRangeChange,
}: {
  items: TopProduct[]
} & RangeControlledChartProps) {
  const max = Math.max(1, ...items.map((item) => item.quantity))
  return (
    <ChartCard title="Top products" range={range} onRangeChange={onRangeChange}>
      {items.length === 0 ? (
        <EmptyNote>No paid products in this range yet.</EmptyNote>
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

export type DashboardChartId = "orders" | "status" | "revenue" | "products"

export type DashboardChartRanges = Record<
  DashboardChartId,
  DashboardRangePreset
>

export type DashboardChartDataByCard = Record<
  DashboardChartId,
  DashboardChartData
>

export function DashboardCharts({
  data,
  ranges,
  onRangeChange,
}: {
  data: DashboardChartDataByCard
  ranges: DashboardChartRanges
  onRangeChange: (chart: DashboardChartId, range: DashboardRangePreset) => void
}) {
  return (
    <div className="space-y-3">
      <OrdersOverTimeChart
        points={data.orders.ordersOverTime}
        range={ranges.orders}
        onRangeChange={(range) => onRangeChange("orders", range)}
      />
      <div className="grid gap-3 lg:grid-cols-3">
        <StatusBreakdownChart
          slices={data.status.statusSlices}
          range={ranges.status}
          onRangeChange={(range) => onRangeChange("status", range)}
        />
        <RevenueOverTimeChart
          points={data.revenue.revenueOverTime}
          hasRevenue={data.revenue.hasRevenue}
          range={ranges.revenue}
          onRangeChange={(range) => onRangeChange("revenue", range)}
        />
        <TopProductsChart
          items={data.products.topProducts}
          range={ranges.products}
          onRangeChange={(range) => onRangeChange("products", range)}
        />
      </div>
    </div>
  )
}
