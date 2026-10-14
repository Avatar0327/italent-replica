import { Alert, Form, Input, Select, Table, Tag } from 'antd';
import { useState } from 'react';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { filterExamples, previewFilters, type DemoFilters } from '../demo-stubs/personnel.js';
import type { Filters } from './model.js';
import { m } from './messages.js';

export function StaffFilters({
  value,
  allowed,
  onApply,
  onClose,
}: {
  value: Filters;
  allowed: readonly string[];
  onApply(value: Filters): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(value);
  const [demo, setDemo] = useState<DemoFilters>({});
  const update = (key: keyof Filters, value: string) => setDraft((old) => ({ ...old, [key]: value }));
  return (
    <FilterDrawer
      open
      onClear={() => {
        setDraft({});
        setDemo({});
      }}
      onClose={onClose}
      onApply={() => {
        onApply(draft);
        onClose();
      }}
    >
      <DecisionNote id="personnel-filters" />
      <h3 className="staff-section-title">{m.customSearch}</h3>
      <p className="staff-muted">{m.exactHint}</p>
      <Form layout="horizontal" labelCol={{ span: 7 }} wrapperCol={{ span: 17 }}>
        {(['name', 'code', 'entryDate'] as const)
          .filter((key) => allowed.includes(key))
          .map((key) => (
            <Form.Item key={key} label={key === 'name' ? m.search : m.labels[key]}>
              <Input
                aria-label={key === 'name' ? m.search : m.labels[key]}
                value={draft[key] ?? ''}
                type={key === 'entryDate' ? 'date' : 'text'}
                maxLength={200}
                onChange={(event) => update(key, event.target.value)}
              />
            </Form.Item>
          ))}
        {allowed.includes('employeeStatus') && (
          <Form.Item label={m.labels.employeeStatus}>
            <Select
              aria-label={m.labels.employeeStatus}
              allowClear
              value={draft.employeeStatus || undefined}
              placeholder={m.all}
              onChange={(value: string | undefined) => update('employeeStatus', value ?? '')}
              options={Object.entries(m.statuses).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
        )}
      </Form>
      <DemoFilterPreview demo={demo} onChange={setDemo} />
    </FilterDrawer>
  );
}

function DemoFilterPreview({ demo, onChange }: { demo: DemoFilters; onChange(value: DemoFilters): void }) {
  return (
    <>
      <Alert type="info" showIcon message={m.missingFilters} />
      <h3 className="staff-section-title">
        {m.demoPreview}
        <Tag>{m.demoData}</Tag>
      </h3>
      <Form layout="horizontal" labelCol={{ span: 7 }} wrapperCol={{ span: 17 }}>
        {(['gender', 'department', 'company'] as const).map((key) => (
          <Form.Item key={key} label={m.labels[key]}>
            <Select
              aria-label={`${m.demoPreview}${m.labels[key]}`}
              allowClear
              value={demo[key]}
              placeholder={m.all}
              onChange={(value: string | undefined) => onChange({ ...demo, [key]: value })}
              options={[...new Set(filterExamples.map((row) => row[key]))].map((value) => ({ value, label: value }))}
            />
          </Form.Item>
        ))}
      </Form>
      <Table
        size="small"
        pagination={false}
        rowKey="id"
        dataSource={previewFilters(demo)}
        columns={['name', 'gender', 'department'].map((key) => ({ title: m.labels[key], dataIndex: key }))}
      />
    </>
  );
}
