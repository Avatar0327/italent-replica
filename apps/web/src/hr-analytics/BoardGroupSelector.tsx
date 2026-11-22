import { Select } from 'antd';
import { m } from './messages.js';
import type { ChartPoint } from './model.js';

export function BoardGroupSelector({
  target,
  disabled,
  change,
}: {
  target: { card: { points: readonly Pick<ChartPoint, 'key' | 'label'>[] }; group?: string };
  disabled: boolean;
  change(group?: string): void;
}) {
  const { points } = target.card;
  if (!points.length) return null;
  // 选项值用位置承载，保留服务端任意字符串键（含空键）。
  const position = points.findIndex(({ key }) => key === target.group);
  const options = [{ value: -1, label: m.allGroups }, ...points.map(({ label }, index) => ({ value: index, label }))];
  return (
    <div className="hr-structure-group">
      <span>{m.group}</span>
      <Select<number>
        aria-label={m.group}
        value={position}
        options={options}
        disabled={disabled}
        onChange={(index) => change(points[index]?.key)}
      />
    </div>
  );
}
