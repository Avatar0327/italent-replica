import { Button, Form, Input, InputNumber, Popover, Space } from 'antd';
import { useState } from 'react';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { ReferenceSelect } from './ReferenceSelect.js';
import { tr } from './messages.js';
import type { ReviewFilters } from './model.js';
interface Props {
  value: ReviewFilters;
  change(value: ReviewFilters): void;
  visible(field: string): boolean;
}
export function ProjectFilters({ value, change, visible }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <Space size={12} wrap>
      {visible('name') && (
        <Popover
          trigger="click"
          content={
            <Input.Search
              aria-label={tr.search}
              placeholder={tr.search}
              value={value.name}
              allowClear
              onChange={(event) => change({ ...value, name: event.target.value })}
            />
          }
        >
          <Button size="small" type="text">
            {tr.fields.name} ▾
          </Button>
        </Popover>
      )}
      {visible('ownerOrgId') && (
        <Popover
          trigger="click"
          content={
            <div className="review-reference-popover">
              <ReferenceSelect
                path="/api/tenant/org/organizations"
                value={value.ownerOrgId}
                onChange={(ownerOrgId) => change({ ...value, ownerOrgId: ownerOrgId as string | undefined })}
              />
            </div>
          }
        >
          <Button size="small" type="text">
            {tr.fields.ownerOrgId} ▾
          </Button>
        </Popover>
      )}
      {(['periodStartDate', 'periodEndDate'] as const).filter(visible).map((field) => (
        <Popover key={field} trigger="click" content={<DateRange field={field} value={value} change={change} />}>
          <Button size="small" type="text">
            {tr.fields[field]} ▾
          </Button>
        </Popover>
      ))}
      <Button size="small" type="text" disabled>
        {tr.fields.scene} ▾
      </Button>
      <Button
        type="link"
        onClick={() => {
          setDraft(value);
          setOpen(true);
        }}
      >
        {tr.advanced}
      </Button>
      <AdvancedFilters
        open={open}
        close={() => setOpen(false)}
        draft={draft}
        setDraft={setDraft}
        change={change}
        visible={visible}
      />
    </Space>
  );
}
function DateRange({ field, value, change }: Pick<Props, 'value' | 'change'> & { field: string }) {
  const from = field === 'periodStartDate' ? 'startFrom' : 'endFrom';
  const to = field === 'periodStartDate' ? 'startTo' : 'endTo';
  return (
    <Space>
      <TenantDatePicker value={value[from]} onChange={(date) => change({ ...value, [from]: date })} />
      <span>～</span>
      <TenantDatePicker value={value[to]} onChange={(date) => change({ ...value, [to]: date })} />
    </Space>
  );
}

function AdvancedFilters({
  open,
  close,
  draft,
  setDraft,
  change,
  visible,
}: Omit<Props, 'value'> & {
  open: boolean;
  close(): void;
  draft: ReviewFilters;
  setDraft(value: ReviewFilters): void;
}) {
  return (
    <FilterDrawer
      open={open}
      onClose={() => close()}
      onClear={() => setDraft({})}
      onApply={() => {
        change(draft);
        close();
      }}
    >
      <Form layout="vertical">
        {visible('name') && (
          <Form.Item label={tr.fields.name}>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Form.Item>
        )}
        {visible('ownerOrgId') && (
          <Form.Item label={tr.fields.ownerOrgId}>
            <ReferenceSelect
              path="/api/tenant/org/organizations"
              value={draft.ownerOrgId}
              onChange={(ownerOrgId) => setDraft({ ...draft, ownerOrgId: ownerOrgId as string | undefined })}
            />
          </Form.Item>
        )}
        {(['periodStartDate', 'periodEndDate'] as const).filter(visible).map((field) => (
          <Form.Item key={field} label={tr.fields[field]}>
            <DateRange field={field} value={draft} change={setDraft} />
          </Form.Item>
        ))}
        {visible('year') && (
          <Form.Item label={tr.fields.year}>
            <InputNumber precision={0} value={draft.year} onChange={(year) => setDraft({ ...draft, year })} />
          </Form.Item>
        )}
      </Form>
    </FilterDrawer>
  );
}
