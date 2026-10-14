import { Button, Drawer, Input, InputNumber, Select, Space } from 'antd';
import { useState } from 'react';
import { contractTypes } from '../demo-stubs/contracts.js';
import { m } from './messages.js';
import { value as displayValue, type Filters, type View } from './model.js';
import { DemoNote } from './parts.js';
const quick: Record<View, string[]> = {
  expiring: ['name', 'location', 'companyId', 'department', 'typeId'],
  missing: ['name', 'employeeId', 'entryDate', 'department', 'typeId'],
  expired_unrenewed: ['name', 'typeId', 'termType', 'to', 'location'],
  in_review: ['name', 'companyId', 'to', 'termType', 'typeId'],
  valid: ['name', 'employeeId', 'location', 'companyId', 'department'],
  all: ['name', 'companyId', 'to', 'termType', 'typeId'],
};
function Controls({ keys, value, change }: { keys: string[]; value: Filters; change(value: Filters): void }) {
  return (
    <>
      {keys.map((key) => (
        <label className="contract-filter" key={key}>
          <span>{m.fields[key]}</span>
          {key === 'typeId' || key === 'termType' ? (
            <Select
              aria-label={m.fields[key]}
              mode={key === 'typeId' ? 'multiple' : undefined}
              allowClear
              placeholder={m.search}
              value={value[key]}
              optionFilterProp="label"
              onChange={(input: string | string[] | undefined) => change({ ...value, [key]: input })}
              options={
                key === 'typeId'
                  ? [{ value: '', label: m.unset }, ...contractTypes.map((t) => ({ value: t.id, label: t.name }))]
                  : ['fixed', 'indefinite', 'task'].map((id) => ({ value: id, label: displayValue(id, 'termType') }))
              }
            />
          ) : (
            <Input
              aria-label={m.fields[key]}
              type={['from', 'to', 'entryDate'].includes(key) ? 'date' : 'text'}
              value={(value[key] as string) ?? ''}
              maxLength={100}
              onChange={(event) => change({ ...value, [key]: event.target.value })}
            />
          )}
        </label>
      ))}
    </>
  );
}
export function QuickFilters({ view, value, change }: { view: View; value: Filters; change(value: Filters): void }) {
  return <Controls keys={quick[view]} value={value} change={change} />;
}
export function FilterDrawer({
  initial,
  days,
  setDays,
  apply,
  close,
}: {
  days: number;
  setDays(days: number): void;
  initial: Filters;
  apply(value: Filters): void;
  close(): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [draftDays, changeDays] = useState(days);
  return (
    <Drawer
      open
      title={m.filter}
      width={480}
      onClose={close}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={() => setDraft({})}>{m.reset}</Button>
          <Button onClick={close}>{m.cancel}</Button>
          <Button
            aria-label={m.confirm}
            type="primary"
            onClick={() => {
              setDays(draftDays);
              apply(draft);
            }}
          >
            {m.confirm}
          </Button>
        </Space>
      }
    >
      <DemoNote />
      <h3>{m.unnamed}</h3>
      <label>
        {m.fields.days}
        <InputNumber
          aria-label={m.fields.days}
          min={1}
          max={3660}
          precision={0}
          value={draftDays}
          onChange={(n) => {
            if (n) changeDays(n);
          }}
        />
      </label>
      <div className="contract-filter-grid">
        <Controls
          keys={['name', 'location', 'companyId', 'department', 'typeId', 'termType', 'from', 'to']}
          value={draft}
          change={setDraft}
        />
      </div>
    </Drawer>
  );
}
