import type { CSSProperties, ReactNode } from 'react';
import { m } from './messages.js';
import './board-charts.css';

export type GroupChartKind = 'column' | 'bar' | 'pie';
export interface ChartPoint {
  key: string;
  label: string;
  value: number | null;
  text: string;
}

const colors = ['var(--shell-primary)', '#087e8b', '#5b5caf', '#b15d26', '#327e55', '#a24e76', '#446b98', '#81702b'];
const colorAt = (index: number) => colors[index % colors.length]!;

function pieFill(points: readonly ChartPoint[]) {
  const total = points.reduce((sum, { value }) => sum + (value ?? 0), 0);
  if (!total) return undefined;
  let start = 0;
  const stops = points.flatMap(({ value }, index) => {
    if (!value) return [];
    const end = start + (value / total) * 100;
    const stop = `${colorAt(index)} ${start}% ${end}%`;
    start = end;
    return [stop];
  });
  return `conic-gradient(${stops.join(', ')})`;
}

function ChartItem({ point, children, open }: { point: ChartPoint; children: ReactNode; open?: () => void }) {
  if (!open) return <div className="board-chart-item">{children}</div>;
  return (
    <button
      type="button"
      className="board-chart-item"
      aria-label={`${m.viewDetails}：${point.label}，${point.text}`}
      onClick={open}
    >
      {children}
    </button>
  );
}

export function BoardChart({
  kind,
  points,
  maximum,
  open,
}: {
  kind: GroupChartKind;
  points: readonly ChartPoint[];
  maximum?: number;
  open?(key: string): void;
}) {
  if (!points.length) return <p className="board-chart-empty">{m.empty}</p>;
  const scale = maximum ?? points.reduce((max, { value }) => Math.max(max, value ?? 0), 0);
  return (
    <div className={`board-chart board-chart-${kind}`}>
      {kind === 'pie' && (
        <div aria-hidden="true" className="board-chart-disc" style={{ background: pieFill(points) }} />
      )}
      <ul>
        {points.map((point, index) => {
          const fraction = scale ? (point.value ?? 0) / scale : 0;
          const chartStyle = {
            '--point-size': `${Math.min(1, Math.max(0, fraction)) * 100}%`,
            '--point-color': kind === 'pie' ? colorAt(index) : 'var(--shell-primary)',
          } as CSSProperties;
          return (
            <li key={point.key} style={chartStyle}>
              <ChartItem point={point} open={open && (() => open(point.key))}>
                <span className="board-chart-label" title={point.label}>
                  {point.label}
                </span>
                <span className="board-chart-mark" aria-hidden="true">
                  <span />
                </span>
                <span className="board-chart-number">{point.text}</span>
              </ChartItem>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function MapPlaceholder() {
  return <p className="board-chart-empty board-chart-map">{m.noSource}</p>;
}
