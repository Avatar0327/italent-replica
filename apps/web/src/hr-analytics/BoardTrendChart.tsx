import { cellText } from '../hr-reports/model.js';
import { ChartItem, colorAt } from './BoardCharts.js';
import { m } from './messages.js';
import type { TrendAxisItem, TrendPoint, TrendSeries } from './model.js';

const width = 1000;
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
  kind: 'line' | 'area';
  categories: readonly TrendAxisItem[];
  series: readonly TrendSeries[];
  percent?: boolean;
  open?(key: string): void;
}

export function BoardTrendChart({ kind, categories, series, percent, open }: TrendChartProps) {
  if (!categories.length || !series.length) return <p className="board-chart-empty">{m.empty}</p>;

  const max = series.reduce(
    (largest, item) => item.points.reduce((value, point) => Math.max(value, point.value ?? 0), largest),
    0,
  );
  const ceiling = percent ? Math.max(0.1, Math.ceil(max * 10) / 10) : Math.max(1, Math.ceil(max));
  const middle = percent ? ceiling / 2 : Math.floor(ceiling / 2);
  const ticks = middle > 0 ? [ceiling, middle, 0] : [ceiling, 0];
  const format = (value: number) => cellText(percent ? 'rate' : 'value', value);
  const yAt = (value: number) => baseline - (value / ceiling) * (baseline - top);
  const xAt = (index: number) => axis + ((index + 0.5) / categories.length) * (width - axis);
  const rows = series.map(({ key, label, points }, index) => {
    const keyed = new Map(points.map((point) => [point.category, point]));
    return { key, label, color: colorAt(index), cells: categories.map(({ key }) => keyed.get(key)) };
  });

  return (
    <div className="board-trend">
      <div className="board-trend-content" style={{ minWidth: axis + categories.length * 56 }}>
        <svg viewBox={`0 0 ${width} 146`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {ticks.map((value) => (
            <g key={value}>
              <line x1={axis} x2={width} y1={yAt(value)} y2={yAt(value)} />
              <text x={axis - 8} y={yAt(value)} textAnchor="end" dominantBaseline="central">
                {format(value)}
              </text>
            </g>
          ))}
          {rows.map(({ key, color, cells }) => {
            const segments = runs(
              cells.map((point, index) =>
                point && point.value !== null ? { x: xAt(index), y: yAt(point.value), point } : null,
              ),
            );
            return segments.map((segment) => {
              const first = segment[0]!;
              const last = segment.at(-1)!;
              const path = segment.map(({ x, y }) => `${x},${y}`).join(' ');
              return (
                <g key={`${key}/${first.point.key}`}>
                  {kind === 'area' && (
                    <polygon points={`${first.x},${baseline} ${path} ${last.x},${baseline}`} fill={color} />
                  )}
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
                      <title>{[point.label, point.text, point.hint].filter(Boolean).join(' · ')}</title>
                    </circle>
                  ))}
                </g>
              );
            });
          })}
        </svg>
        <TrendValues rows={rows} categories={categories} open={open} />
      </div>
    </div>
  );
}
