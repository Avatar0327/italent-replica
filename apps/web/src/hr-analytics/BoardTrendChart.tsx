import { cellText } from '../hr-reports/model.js';
import { ChartItem, colorAt } from './BoardCharts.js';
import { m } from './messages.js';
import type { TrendAxisItem, TrendPoint, TrendSeries } from './model.js';

const axis = 70;
const top = 14;
const baseline = 132;
type Position = { x: number; y: number; point: TrendPoint };

function runs(positions: readonly (Position | null)[]) {
  const result: Position[][] = [];
  let current: Position[] | undefined;
  for (const position of positions) {
    if (!position) current = undefined;
    else if (current) current.push(position);
    else result.push((current = [position]));
  }
  return result;
}

type TrendRow = { key: string; label?: string; color: string; cells: (TrendPoint | undefined)[] };

function TrendValues({
  rows,
  categories,
  open,
}: {
  rows: readonly TrendRow[];
  categories: readonly TrendAxisItem[];
  open?(key: string): void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">{m.trendPeriod}</th>
          {categories.map(({ key, label }) => (
            <th scope="col" key={key}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, label, cells, color }) => (
          <tr key={key}>
            <th scope="row">
              <span className="board-chart-swatch" style={{ background: color }} aria-hidden="true" />
              {label ?? m.trendValue}
            </th>
            {cells.map((point, index) => (
              <td key={categories[index]!.key}>
                {point ? (
                  <ChartItem point={point} open={open && (() => open(point.key))}>
                    {point.text}
                  </ChartItem>
                ) : (
                  cellText('value', null)
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface TrendChartProps {
  kind: 'line' | 'area' | 'stacked' | 'combo';
  categories: readonly TrendAxisItem[];
  series: readonly TrendSeries[];
  percent?: boolean;
  categoryWidth?: number;
  open?(key: string): void;
}

const pointTitle = (point: TrendPoint) => [point.label, point.text, point.hint].filter(Boolean).join(' · ');

function TrendLine({
  positions,
  area,
  color,
  open,
}: {
  positions: readonly (Position | null)[];
  area: boolean;
  color: string;
  open?(key: string): void;
}) {
  return runs(positions).map((segment) => {
    const first = segment[0]!;
    const last = segment.at(-1)!;
    const path = segment.map(({ x, y }) => `${x},${y}`).join(' ');
    return (
      <g key={first.point.key}>
        {area && <polygon points={`${first.x},${baseline} ${path} ${last.x},${baseline}`} fill={color} />}
        <polyline points={path} stroke={color} />
        {segment.map(({ x, y, point }) => (
          <circle
            key={point.key}
            cx={x}
            cy={y}
            r={open ? 5 : 3}
            fill={color}
            onClick={open && (() => open(point.key))}
            className={open ? 'board-chart-clickable' : undefined}
          >
            <title>{pointTitle(point)}</title>
          </circle>
        ))}
      </g>
    );
  });
}

function TrendBars({
  rows,
  count,
  xAt,
  yAt,
  barWidth,
  open,
}: {
  rows: readonly TrendRow[];
  count: number;
  xAt(index: number): number;
  yAt(value: number): number;
  barWidth: number;
  open?(key: string): void;
}) {
  return Array.from({ length: count }, (_, index) => {
    let offset = 0;
    return rows.flatMap(({ key, color, cells }) => {
      const point = cells[index];
      if (!point || point.value === null) return [];
      const bottom = yAt(offset);
      offset += point.value;
      const y = yAt(offset);
      return (
        <rect
          key={JSON.stringify([key, point.key])}
          x={xAt(index) - barWidth / 2}
          y={y}
          width={barWidth}
          height={Math.max(0, bottom - y)}
          fill={color}
          onClick={open && (() => open(point.key))}
          className={open ? 'board-chart-clickable' : undefined}
        >
          <title>{pointTitle(point)}</title>
        </rect>
      );
    });
  });
}

const seriesMax = (rows: readonly TrendSeries[]) =>
  Math.max(0, ...rows.map(({ points }) => points.reduce((max, { value }) => Math.max(max, value ?? 0), 0)));

function scale(max: number, percent: boolean) {
  const ceiling = percent ? Math.max(0.1, Math.ceil(max * 10) / 10) : Math.max(1, Math.ceil(max));
  const middle = percent ? ceiling / 2 : Math.floor(ceiling / 2);
  return {
    ticks: middle > 0 ? [ceiling, middle, 0] : [ceiling, 0],
    yAt: (value: number) => baseline - (value / ceiling) * (baseline - top),
    format: (value: number) => cellText(percent ? 'rate' : 'value', value),
  };
}

// 堆叠求和只决定图形刻度，计数和钻取仍使用各系列回执。
function stackedMaximum(rows: readonly TrendRow[], categories: readonly TrendAxisItem[]) {
  return categories.reduce((maximum, _, index) => {
    const total = rows.reduce((sum, row) => sum + (row.cells[index]?.value ?? 0), 0);
    return Math.max(maximum, total);
  }, 0);
}

export function BoardTrendChart({ kind, categories, series, percent = false, categoryWidth, open }: TrendChartProps) {
  if (!categories.length || !series.length) return <p className="board-chart-empty">{m.empty}</p>;

  const rows = series.map(({ key, label, points }, index) => {
    const keyed = new Map(points.map((point) => [point.category, point]));
    return { key, label, color: colorAt(index), cells: categories.map(({ key }) => keyed.get(key)) };
  });
  const combo = kind === 'combo';
  const stacked = kind === 'stacked';
  const count = categories.length;
  const rightAxis = combo ? 55 : 0;
  const barSeriesCount = combo ? 1 : 0;
  const primarySeries = combo ? series.slice(0, barSeriesCount) : series;
  const minWidth = axis + rightAxis + count * (categoryWidth ?? 56);
  const viewWidth = categoryWidth ? Math.max(430, minWidth) : 1000;
  const plotWidth = viewWidth - axis - rightAxis;
  const xAt = (index: number) => axis + ((index + 0.5) / count) * plotWidth;
  const max = stacked ? stackedMaximum(rows, categories) : seriesMax(primarySeries);
  const primary = scale(max, percent);
  const secondary = combo ? scale(seriesMax(series.slice(barSeriesCount)), false) : undefined;
  const bars = stacked ? rows : rows.slice(0, barSeriesCount);
  const lines = stacked ? [] : rows.slice(barSeriesCount);
  const lineY = secondary?.yAt ?? primary.yAt;

  return (
    <div className="board-trend">
      <div className="board-trend-content" style={{ minWidth }}>
        <svg viewBox={`0 0 ${viewWidth} 146`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {primary.ticks.map((value) => (
            <g key={value}>
              <line x1={axis} x2={viewWidth - rightAxis} y1={primary.yAt(value)} y2={primary.yAt(value)} />
              <text x={axis - 8} y={primary.yAt(value)} textAnchor="end" dominantBaseline="central">
                {primary.format(value)}
              </text>
            </g>
          ))}
          {secondary?.ticks.map((value) => (
            <text key={value} x={viewWidth - rightAxis + 8} y={secondary.yAt(value)} dominantBaseline="central">
              {secondary.format(value)}
            </text>
          ))}
          {bars.length > 0 && (
            <TrendBars
              rows={bars}
              count={count}
              xAt={xAt}
              yAt={primary.yAt}
              barWidth={Math.min(70, (plotWidth / count) * 0.56)}
              open={open}
            />
          )}
          {lines.map(({ key, color, cells }) => (
            <TrendLine
              key={key}
              area={kind === 'area'}
              color={color}
              open={open}
              positions={cells.map((point, index) =>
                point && point.value !== null ? { x: xAt(index), y: lineY(point.value), point } : null,
              )}
            />
          ))}
        </svg>
        <TrendValues rows={rows} categories={categories} open={open} />
      </div>
    </div>
  );
}
