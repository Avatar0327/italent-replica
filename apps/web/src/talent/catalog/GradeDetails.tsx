import { Button, Input, InputNumber, Table, type TableColumnsType } from 'antd';
import { useFormLock } from '../../foundation/forms/FormLock.js';
import { m } from './messages.js';

type Grade = { id?: string; grade?: number | null; name?: string; description?: string | null; score?: number | null };
/** 明细按真实接口整组提交；既有行 ID 原样保留，新增行由服务端分配 ID。 */
export function GradeDetails({
  value = [],
  onChange,
  disabled,
}: {
  value?: Grade[];
  onChange?: (value: Grade[]) => void;
  disabled?: boolean;
}) {
  const lock = useFormLock(disabled);
  const change = lock.guard(onChange);
  return (
    <div className="catalog-grade-details">
      <Table
        pagination={false}
        size="small"
        rowKey="key"
        dataSource={value.map((row, index) => ({ ...row, key: row.id ?? `new:${index}` }))}
        columns={gradeColumns(value, lock.disabled, change)}
      />
      <Button disabled={lock.disabled || value.length >= 50} onClick={() => change([...value, {}])}>
        {m.addGrade}
      </Button>
    </div>
  );
}

function gradeColumns(value: Grade[], disabled: boolean, change: (value: Grade[]) => void): TableColumnsType<Grade> {
  const update = (index: number, patch: Partial<Grade>) =>
    change(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return [
    {
      title: m.gradeLevel,
      width: 40,
      render: (_, row, i) => (
        <InputNumber
          aria-label={`${m.gradeNumber} ${i + 1}`}
          disabled={disabled}
          min={0}
          max={1000}
          precision={0}
          value={row.grade}
          onChange={(grade) => update(i, { grade })}
        />
      ),
    },
    {
      title: <span className="catalog-required-label">{m.name}</span>,
      width: 120,
      render: (_, row, i) => (
        <Input
          aria-label={`${m.gradeName} ${i + 1}`}
          disabled={disabled}
          maxLength={100}
          value={row.name}
          onChange={(e) => update(i, { name: e.target.value })}
        />
      ),
    },
    {
      title: m.schemeDescription,
      width: 120,
      render: (_, row, i) => (
        <Input.TextArea
          aria-label={`${m.schemeDescription} ${i + 1}`}
          disabled={disabled}
          maxLength={4000}
          value={row.description ?? ''}
          onChange={(e) => update(i, { description: e.target.value })}
        />
      ),
    },
    {
      title: m.score,
      width: 540,
      render: (_, row, i) => (
        <InputNumber
          aria-label={`${m.score} ${i + 1}`}
          disabled={disabled}
          min={-9999999}
          max={9999999}
          precision={2}
          value={row.score}
          onChange={(score) => update(i, { score })}
        />
      ),
    },
    {
      title: m.actions,
      width: 90,
      render: (_, _row, i) => (
        <Button type="link" disabled={disabled} onClick={() => change(value.filter((_, j) => i !== j))}>
          {m.delete}
        </Button>
      ),
    },
  ];
}
