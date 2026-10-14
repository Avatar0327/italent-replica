import { Alert, Button, Checkbox, Drawer, Form, Input, Select, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { DecisionNote } from '../foundation/DecisionNote.js';
import { filterExamples, previewFilters, type DemoFilters } from '../demo-stubs/personnel.js';
import { columnChoices, type Filters } from './model.js';
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

export function ColumnSettings({
  value,
  allowed,
  onApply,
  onClose,
}: {
  value: string[];
  allowed: readonly string[];
  onApply(value: string[]): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(value);
  // 不用 Checkbox.Group：它把受控 value 镜像进内部 state，点击后要等 effect 再渲染一轮，
  // 这一轮之前界面仍是旧勾选，连续点击会拿旧 value 覆盖前一次操作。逐项受控 + 函数式更新在点击事件内即时生效。
  const toggle = (key: string, checked: boolean) =>
    setDraft((previous) => columnChoices.filter((choice) => (choice === key ? checked : previous.includes(choice))));
  return (
    <Drawer
      open
      width={380}
      title={m.columns}
      onClose={onClose}
      closable={{ placement: 'end' }}
      footer={
        <Space>
          <Button onClick={onClose}>{m.cancel}</Button>
          <Button
            type="primary"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            {m.confirm}
          </Button>
        </Space>
      }
    >
      <p>{m.columnHint}</p>
      <div className="staff-column-options">
        {columnChoices
          .filter((key) => allowed.includes(key))
          .map((key) => (
            <Checkbox
              key={key}
              value={key}
              disabled={key === 'name'}
              checked={draft.includes(key)}
              onChange={(event) => toggle(key, event.target.checked)}
            >
              {m.labels[key]}
            </Checkbox>
          ))}
      </div>
      <p className="staff-muted">{m.localColumns}</p>
    </Drawer>
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
