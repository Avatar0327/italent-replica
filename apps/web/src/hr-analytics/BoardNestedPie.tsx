import { ChartItem, colorAt } from './BoardCharts.js';
import type { NestedChartPoint } from './model.js';
import { m } from './messages.js';

function pieLevels(points: readonly NestedChartPoint[]) {
  const children = new Map<string, NestedChartPoint[]>();
  for (const point of points) {
    if (point.parent === null) continue;
    const matches = children.get(point.parent) ?? [];
    matches.push(point);
    children.set(point.parent, matches);
  }
  return points
    .filter(({ parent }) => parent === null)
    .map((point, index) => {
      const color = colorAt(index);
      return {
        point,
        color,
        children: (children.get(point.key) ?? []).map((child, index) => ({
          point: child,
          color: `color-mix(in srgb, ${color}, white ${20 + (index % 4) * 14}%)`,
        })),
      };
    });
}

interface Slice {
  point: NestedChartPoint;
  color: string;
}

function Ring({ slices, radius, open }: { slices: readonly Slice[]; radius: number; open?(key: string): void }) {
  const total = slices.reduce((sum, { point }) => sum + (point.value ?? 0), 0);
  let offset = 0;
  return (
    <>
      <circle cx="90" cy="90" r={radius} className="board-chart-ring-background" />
      {slices.flatMap(({ point, color }) => {
        if (!point.value || !total) return [];
        const length = (point.value / total) * 100;
        const start = offset;
        offset += length;
        return [
          <circle
            key={point.key}
            cx="90"
            cy="90"
            r={radius}
            pathLength="100"
            transform="rotate(-90 90 90)"
            stroke={color}
            strokeDasharray={`${length} ${100 - length}`}
            strokeDashoffset={-start}
            className={open ? 'board-chart-clickable' : undefined}
            onClick={open && (() => open(point.key))}
          >
            <title>{`${point.label} · ${point.text}`}</title>
          </circle>,
        ];
      })}
    </>
  );
}

function SliceLabel({ point, color, open }: { point: NestedChartPoint; color: string; open?(key: string): void }) {
  return (
    <ChartItem point={point} open={open && (() => open(point.key))}>
      <span className="board-chart-swatch" style={{ background: color }} aria-hidden="true" />
      <span className="board-chart-label" title={point.label}>
        {point.label}
      </span>
      <span className="board-chart-number">{point.text}</span>
    </ChartItem>
  );
}

export function BoardNestedPie({ points, open }: { points: readonly NestedChartPoint[]; open?(key: string): void }) {
  const levels = pieLevels(points);
  if (!levels.length) return <p className="board-chart-empty">{m.empty}</p>;
  const outer = levels.flatMap(({ children }) => children);
  return (
    <div className="board-chart board-chart-nested">
      <svg viewBox="0 0 180 180" aria-hidden="true" focusable="false">
        <Ring slices={outer} radius={72} open={open} />
        <Ring slices={levels} radius={47} open={open} />
      </svg>
      <ul className="board-chart-pie-legend">
        {levels.map(({ point, color, children }) => (
          <li key={point.key}>
            <SliceLabel point={point} color={color} open={open} />
            {children.length > 0 && (
              <ul>
                {children.map((child) => (
                  <li key={child.point.key}>
                    <SliceLabel {...child} open={open} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
