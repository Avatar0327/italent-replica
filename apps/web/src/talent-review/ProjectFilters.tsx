import { Button, Form, Input, InputNumber, Popover, Space } from 'antd';
import { useState } from 'react';
import { FilterDrawer } from '../foundation/FilterDrawer.js';
import { TenantDatePicker } from '../foundation/selectors.js';
import { ReferenceSelect } from './ReferenceSelect.js';
import { ProjectOrgFilter } from './ProjectOrgFilter.js';
import { base } from './api.js';
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
  const [nameDraft, setNameDraft] = useState(value.name);
  const [nameOpen, setNameOpen] = useState(false);
  return (
    <Space size={12} wrap>
      {visible('name') && (
        <Popover
          trigger="click"
          open={nameOpen}
          onOpenChange={(next) => {
            setNameOpen(next);
            setNameDraft(value.name);
          }}
          content={
            <Space direction="vertical">
              <Input
                aria-label={tr.search}
                placeholder={tr.search}
                value={nameDraft}
                allowClear
                onChange={(event) => setNameDraft(event.target.value)}
              />
              <Button
                type="primary"
                onClick={() => {
                  change({ ...value, name: nameDraft });
                  setNameOpen(false);
                }}
              >
                {tr.confirm}
              </Button>
            </Space>
          }
        >
          <Button size="small" type="text">
            {tr.fields.name} ▾
          </Button>
        </Popover>
      )}
      {visible('ownerOrgId') && (
        <ProjectOrgFilter
          value={value.ownerOrgIds ?? (value.ownerOrgId ? [value.ownerOrgId] : [])}
          onChange={(ownerOrgIds) => change({ ...value, ownerOrgId: undefined, ownerOrgIds })}
        />
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
        <h3>{tr.unnamed}</h3>
        {visible('name') && (
          <Form.Item label={tr.fields.name}>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Form.Item>
        )}
        {visible('ownerOrgId') && (
          <Form.Item label={tr.fields.ownerOrgId}>
            <ReferenceSelect
              path="/api/tenant/org/organizations"
              multiple
              value={draft.ownerOrgIds ?? (draft.ownerOrgId ? [draft.ownerOrgId] : [])}
              onChange={(ownerOrgIds) =>
                setDraft({ ...draft, ownerOrgId: undefined, ownerOrgIds: ownerOrgIds as string[] })
              }
            />
          </Form.Item>
        )}
        {(['periodStartDate', 'periodEndDate'] as const).filter(visible).map((field) => (
          <Form.Item key={field} label={tr.fields[field]}>
            <DateRange field={field} value={draft} change={setDraft} />
          </Form.Item>
        ))}
        <Form.Item label={tr.fields.scene}>
          <Input disabled placeholder={tr.unverified} />
        </Form.Item>
        {visible('year') && (
          <Form.Item label={tr.fields.year}>
            <InputNumber precision={0} value={draft.year} onChange={(year) => setDraft({ ...draft, year })} />
          </Form.Item>
        )}
        {visible('categoryId') && (
          <Form.Item label={tr.fields.categoryId}>
            <ReferenceSelect
              path={`${base}/categories`}
              value={draft.categoryId}
              onChange={(categoryId) => setDraft({ ...draft, categoryId: categoryId as string | undefined })}
            />
          </Form.Item>
        )}
      </Form>
    </FilterDrawer>
  );
}
