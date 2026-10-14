import { Form, Select } from 'antd';
import { useEffect, useRef } from 'react';
import { newStandardCells } from './api.js';
import type { Row } from './types.js';
import { m } from './messages.js';
type Cell = { levelId: string; targetId: string };
export function StandardTargets({
  id,
  value = [],
  onChange,
  rows,
}: {
  id?: string;
  value?: Cell[];
  onChange?: (value: Cell[]) => void;
  rows: Row[];
}) {
  const levels: string[] | undefined = Form.useWatch('levelIds');
  const selected = useRef<string[]>([]);
  const levelKey = JSON.stringify(levels ?? []);
  useEffect(() => {
    onChange?.(newStandardCells(JSON.parse(levelKey) as string[], selected.current));
  }, [levelKey]);
  return (
    <Select
      id={id}
      mode="multiple"
      showSearch
      optionFilterProp="label"
      placeholder={m.choose}
      disabled={!levels?.length}
      value={[...new Set(value.map((cell) => cell.targetId))]}
      options={rows.map((row) => ({ value: row.id, label: row.name ?? row.id }))}
      onChange={(ids: string[]) => {
        selected.current = ids;
        onChange?.(newStandardCells(levels ?? [], ids));
      }}
    />
  );
}
